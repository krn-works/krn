import { spawnSync } from 'node:child_process';
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { commentFileTaskId, parseComments } from './comments.ts';
import {
  createTaskId,
  isTaskId,
  parseTaskDocument,
  serializeTask,
  type TaskAcceptance,
  TaskCommandError,
  TaskDataError,
  type TaskId,
  type TaskRecord,
  type TaskResolution,
  type TaskStatus,
  TaskUsageError,
} from './record.ts';
import { atomicWrite } from './staged-write.ts';

// Exit code of `krn task close` when an acceptance command fails.
const ACCEPTANCE_FAILED_EXIT = 66;

interface NewTask {
  title: string;
  priority?: number;
  after?: TaskId[];
  body?: string[];
  verify?: string[];
}

interface EditTask {
  title?: string;
  priority?: number;
  body?: string[];
  appendBody?: string[];
  verify?: string[];
  reopen?: boolean;
}

interface TaskStoreOptions {
  makeId?: () => TaskId;
  uniquenessRoots?: string[];
}

export function repositoryRoot(cwd = process.cwd()): string {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new TaskUsageError('task commands must run inside a git repository');
  return result.stdout.trim();
}

// Matches the post-merge proof phrasing used in task bodies: "After merge",
// "After the merge", "post-merge", "merged history".
const POST_MERGE_PROOF =
  /\bafter (?:the )?merge\b|\bpost-merge\b|\bmerged history\b/iu;

export function checkTaskDirectory(root: string): string[] {
  const { findings, records } = scanTaskDirectory(root);
  return [...findings, ...postMergeAfterFindings(records)];
}

// An open task with a post-merge proof stays open on purpose, so an open task
// ordered `after` it can never be claimed.
function postMergeAfterFindings(records: Map<TaskId, TaskRecord>): string[] {
  const findings: string[] = [];
  for (const record of records.values()) {
    if (record.status !== 'open') continue;
    for (const id of record.after) {
      const target = records.get(id);
      if (
        target?.status === 'open' &&
        POST_MERGE_PROOF.test(target.body.join('\n'))
      )
        findings.push(
          `tasks/${record.id}.json: after task "${id}" has a post-merge proof and stays open, so this task can never be claimed; drop the after, or split the post-merge proof into its own task`,
        );
    }
  }
  return findings;
}

export function loadTaskIndex(root: string): Map<TaskId, TaskRecord> {
  const { findings, records } = scanTaskDirectory(root);
  if (findings.length > 0) throw new TaskDataError(findings);
  return records;
}

function scanTaskDirectory(root: string): {
  findings: string[];
  records: Map<TaskId, TaskRecord>;
} {
  const directory = join(root, 'tasks');
  let directoryStat: Stats;
  try {
    directoryStat = lstatSync(directory);
  } catch (error) {
    if (isMissingPath(error))
      return { findings: [], records: new Map<TaskId, TaskRecord>() };
    return {
      findings: ['tasks: unable to inspect task directory'],
      records: new Map<TaskId, TaskRecord>(),
    };
  }
  if (!directoryStat.isDirectory())
    return {
      findings: ['tasks: task directory must be a real directory'],
      records: new Map<TaskId, TaskRecord>(),
    };

  const findings: string[] = [];
  const records = new Map<TaskId, TaskRecord>();
  const ids = new Set<TaskId>();
  const references: Array<{
    path: string;
    id: string | undefined;
    after: string[];
    resolutionRef: string | undefined;
  }> = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return {
      findings: ['tasks: unable to read task directory'],
      records,
    };
  }

  const commentFiles: Array<{ name: string; taskId: string }> = [];
  for (const entry of entries.sort((left, right) =>
    compare(left.name, right.name),
  )) {
    const relativePath = `tasks/${entry.name}`;
    const commentTaskId = commentFileTaskId(entry.name);
    if (commentTaskId !== undefined) {
      if (!entry.isFile())
        findings.push(`${relativePath}: comment entry must be a regular file`);
      else commentFiles.push({ name: entry.name, taskId: commentTaskId });
      continue;
    }
    if (!entry.name.endsWith('.json')) {
      findings.push(`${relativePath}: non-JSON file in tasks directory`);
      continue;
    }
    if (!entry.isFile()) {
      findings.push(`${relativePath}: task entry must be a regular file`);
      continue;
    }

    let contents: Buffer;
    try {
      contents = readFileSync(join(directory, entry.name));
    } catch {
      findings.push(`${relativePath}: unable to read task file`);
      continue;
    }
    const parsed = parseTaskDocument(contents);
    for (const finding of parsed.findings)
      findings.push(`${relativePath}: ${finding}`);
    if (parsed.id !== undefined) {
      if (entry.name !== `${parsed.id}.json`)
        findings.push(
          `${relativePath}: filename does not match id "${parsed.id}"`,
        );
      if (isTaskId(parsed.id)) ids.add(parsed.id);
    }
    references.push({
      path: relativePath,
      id: parsed.id,
      after: parsed.afterReferences,
      resolutionRef: parsed.resolutionReference,
    });
    if (parsed.record === undefined) continue;

    records.set(parsed.record.id, parsed.record);
  }

  for (const file of commentFiles) {
    const relativePath = `tasks/${file.name}`;
    if (!ids.has(file.taskId))
      findings.push(
        `${relativePath}: comments for unknown task "${file.taskId}"`,
      );
    try {
      for (const finding of parseComments(
        readFileSync(join(directory, file.name)),
      ).findings)
        findings.push(`${relativePath}: ${finding}`);
    } catch {
      findings.push(`${relativePath}: unable to read comment file`);
    }
  }

  for (const reference of references) {
    for (const dependency of reference.after) {
      if (dependency === reference.id)
        findings.push(`${reference.path}: task cannot depend on itself`);
      if (!ids.has(dependency))
        findings.push(`${reference.path}: unknown after task "${dependency}"`);
    }
    const ref = reference.resolutionRef;
    if (ref !== undefined && !ids.has(ref))
      findings.push(`${reference.path}: unknown resolution ref "${ref}"`);
  }
  const graph = new Map<TaskId, Set<TaskId>>();
  for (const reference of references) {
    if (reference.id === undefined || !isTaskId(reference.id)) continue;
    let dependencies = graph.get(reference.id);
    if (dependencies === undefined) {
      dependencies = new Set<TaskId>();
      graph.set(reference.id, dependencies);
    }
    for (const dependency of reference.after) {
      if (isTaskId(dependency)) dependencies.add(dependency);
    }
  }
  findings.push(...findCycles(graph));
  return { findings, records };
}

export function listTasks(
  root: string,
  status: TaskStatus | 'all' = 'open',
): TaskRecord[] {
  return [...loadTaskIndex(root).values()]
    .filter((record) => status === 'all' || record.status === status)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compare(left.created, right.created) ||
        compare(left.id, right.id),
    );
}

export function getTask(root: string, id: TaskId): TaskRecord {
  const record = loadTaskIndex(root).get(id);
  if (record === undefined)
    throw new TaskDataError([`tasks/${id}.json: task does not exist`]);
  return record;
}

export function createTask(
  root: string,
  input: NewTask,
  options: TaskStoreOptions = {},
): TaskRecord {
  const index = loadTaskIndex(root);
  validateNewTask(input, index);
  const directory = join(root, 'tasks');
  mkdirSync(directory, { recursive: true });
  const makeId = options.makeId ?? createTaskId;

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const id = makeId();
    if (!isTaskId(id))
      throw new TaskDataError([`generated invalid task id "${id}"`]);
    const path = join(directory, `${id}.json`);
    if (
      existsSync(path) ||
      (options.uniquenessRoots ?? []).some((candidate) =>
        existsSync(join(candidate, 'tasks', `${id}.json`)),
      ) ||
      existsInOriginMain(root, id)
    )
      continue;
    const record: TaskRecord = {
      id,
      status: 'open',
      resolution: null,
      created: new Date().toISOString().slice(0, 10),
      priority: input.priority ?? 2,
      title: input.title,
      after: [...new Set(input.after ?? [])].sort(),
      body: [...(input.body ?? [])],
      ...acceptanceFor(input.verify),
    };
    try {
      atomicWrite(root, path, serializeTask(record));
      return record;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw new TaskDataError(['unable to allocate an unused task id']);
}

function acceptanceFor(
  verify: string[] | undefined,
): { acceptance: TaskAcceptance[] } | Record<string, never> {
  const commands = [...new Set(verify ?? [])];
  return commands.length === 0
    ? {}
    : {
        acceptance: commands.map((command) => ({
          verify: command,
          passes: false,
          exit: null,
        })),
      };
}

// Runs one acceptance command through the shell in the repository root and
// returns its exit status (a signal or spawn failure counts as 1).
function runVerify(root: string, command: string): number {
  const run = spawnSync('sh', ['-c', command], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 600_000,
  });
  return run.status ?? 1;
}

export function closeTask(
  root: string,
  id: TaskId,
  resolution: TaskResolution,
  verifier: (root: string, command: string) => number = runVerify,
): TaskRecord {
  const index = loadTaskIndex(root);
  const record = index.get(id);
  if (record === undefined)
    throw new TaskDataError([`tasks/${id}.json: task does not exist`]);
  if (record.status === 'closed')
    throw new TaskDataError([`tasks/${id}.json: task is already closed`]);
  if (
    (resolution.kind === 'duplicate' || resolution.kind === 'superseded') &&
    (resolution.ref === null || !index.has(resolution.ref))
  )
    throw new TaskDataError([
      `tasks/${id}.json: ${resolution.kind} resolution requires an existing ref`,
    ]);

  let acceptance = record.acceptance;
  if (resolution.kind === 'done' && acceptance !== undefined) {
    // Only an executed command flips passes; its exit is recorded either way.
    acceptance = acceptance.map((entry) => {
      const exit = verifier(root, entry.verify);
      return { verify: entry.verify, passes: exit === 0, exit };
    });
    const failed = acceptance.filter((entry) => !entry.passes);
    if (failed.length > 0) {
      atomicWrite(
        root,
        join(root, 'tasks', `${id}.json`),
        serializeTask({ ...record, acceptance }),
        true,
      );
      throw new TaskCommandError(
        `tasks/${id}.json: acceptance failed, task stays open:\n${failed
          .map((entry) => `  exit ${entry.exit}: ${entry.verify}`)
          .join('\n')}`,
        ACCEPTANCE_FAILED_EXIT,
      );
    }
  }
  const closed: TaskRecord = {
    ...record,
    ...(acceptance === undefined ? {} : { acceptance }),
    status: 'closed',
    resolution,
  };
  atomicWrite(
    root,
    join(root, 'tasks', `${id}.json`),
    serializeTask(closed),
    true,
  );
  return closed;
}

export function editTask(
  root: string,
  id: TaskId,
  input: EditTask,
): TaskRecord {
  const index = loadTaskIndex(root);
  const record = index.get(id);
  if (record === undefined)
    throw new TaskDataError([`tasks/${id}.json: task does not exist`]);
  if (record.status === 'closed' && input.reopen !== true)
    throw new TaskDataError([
      `tasks/${id}.json: task is closed; use --reopen to edit it`,
    ]);

  const findings = validateTaskFields(input);
  if (findings.length > 0) throw new TaskDataError(findings);

  const hasFieldChange =
    input.title !== undefined ||
    input.priority !== undefined ||
    input.body !== undefined ||
    (input.verify?.length ?? 0) > 0 ||
    (input.appendBody?.length ?? 0) > 0;
  if (!hasFieldChange && !(input.reopen === true && record.status === 'closed'))
    throw new TaskUsageError('task edit requires at least one change');

  const added = acceptanceFor(input.verify).acceptance ?? [];
  const known = new Set((record.acceptance ?? []).map((entry) => entry.verify));
  const reopening = record.status === 'closed' && input.reopen === true;
  const merged = [
    ...(record.acceptance ?? []).map((entry) =>
      // A reopened task must prove its acceptance again.
      reopening ? { verify: entry.verify, passes: false, exit: null } : entry,
    ),
    ...added.filter((entry) => !known.has(entry.verify)),
  ];
  const updated: TaskRecord = {
    ...record,
    ...(merged.length === 0 ? {} : { acceptance: merged }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.body === undefined
      ? {}
      : { body: [...input.body, ...(input.appendBody ?? [])] }),
    ...(input.body === undefined && input.appendBody !== undefined
      ? { body: [...record.body, ...input.appendBody] }
      : {}),
    ...(record.status === 'closed' && input.reopen === true
      ? { status: 'open' as const, resolution: null }
      : {}),
  };
  atomicWrite(
    root,
    join(root, 'tasks', `${id}.json`),
    serializeTask(updated),
    true,
  );
  return updated;
}

export function changeDependency(
  root: string,
  id: TaskId,
  dependency: TaskId,
  operation: 'add' | 'rm',
): TaskRecord {
  const index = loadTaskIndex(root);
  const record = index.get(id);
  if (record === undefined)
    throw new TaskDataError([`tasks/${id}.json: task does not exist`]);
  if (!index.has(dependency))
    throw new TaskDataError([
      `tasks/${id}.json: after task "${dependency}" does not exist`,
    ]);
  if (id === dependency)
    throw new TaskDataError([`tasks/${id}.json: task cannot depend on itself`]);

  let after: TaskId[];
  if (operation === 'add') {
    if (reaches(index, dependency, id))
      throw new TaskDataError([
        `tasks/${id}.json: dependency "${dependency}" would create a cycle`,
      ]);
    after = [...new Set([...record.after, dependency])].sort();
  } else after = record.after.filter((candidate) => candidate !== dependency);

  const updated: TaskRecord = { ...record, after };
  atomicWrite(
    root,
    join(root, 'tasks', `${id}.json`),
    serializeTask(updated),
    true,
  );
  return updated;
}

function validateNewTask(input: NewTask, index: Map<TaskId, TaskRecord>): void {
  const findings = validateTaskFields(input);
  for (const dependency of input.after ?? []) {
    if (!isTaskId(dependency))
      findings.push(`invalid after task id "${dependency}"`);
    else if (!index.has(dependency))
      findings.push(`after task "${dependency}" does not exist`);
  }
  if (findings.length > 0) throw new TaskDataError(findings);
}

function validateTaskFields(input: {
  title?: string;
  priority?: number;
}): string[] {
  const findings: string[] = [];
  if (input.title !== undefined && input.title.trim().length === 0)
    findings.push('title must not be empty');
  if (input.title !== undefined && /[\r\n]/u.test(input.title))
    findings.push('title must be a single line');
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 3)
  )
    findings.push('priority must be an integer between 0 and 3');
  return findings;
}

function existsInOriginMain(root: string, id: TaskId): boolean {
  const branch = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
    { encoding: 'utf8' },
  );
  if (branch.status !== 0) return false;
  const object = spawnSync(
    'git',
    ['-C', root, 'cat-file', '-e', `origin/main:tasks/${id}.json`],
    { encoding: 'utf8' },
  );
  return object.status === 0;
}

function findCycles(graph: Map<TaskId, Set<TaskId>>): string[] {
  const findings: string[] = [];
  const state = new Map<TaskId, 0 | 1 | 2>();
  const stack: TaskId[] = [];
  const reported = new Set<string>();

  const positions = new Map<TaskId, number>();
  for (const start of graph.keys()) {
    if (state.get(start) !== undefined) continue;
    const frames: Array<{
      id: TaskId;
      dependencies: TaskId[];
      next: number;
    }> = [{ id: start, dependencies: [...(graph.get(start) ?? [])], next: 0 }];
    state.set(start, 1);
    positions.set(start, 0);
    stack.push(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      if (frame.next >= frame.dependencies.length) {
        frames.pop();
        stack.pop();
        positions.delete(frame.id);
        state.set(frame.id, 2);
        continue;
      }
      const dependency = frame.dependencies[frame.next];
      frame.next += 1;
      if (dependency === undefined || !graph.has(dependency)) continue;
      if (state.get(dependency) === 1) {
        const cycle = stack.slice(positions.get(dependency) ?? 0);
        const key = normalizeCycle(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          findings.push(
            `tasks: dependency cycle ${[...cycle, dependency].join(' -> ')}`,
          );
        }
      } else if (state.get(dependency) !== 2) {
        positions.set(dependency, stack.length);
        stack.push(dependency);
        state.set(dependency, 1);
        frames.push({
          id: dependency,
          dependencies: [...(graph.get(dependency) ?? [])],
          next: 0,
        });
      }
    }
  }
  return findings;
}

function normalizeCycle(cycle: TaskId[]): string {
  if (cycle.length === 0) return '';
  let first = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if (compare(cycle[index] ?? '', cycle[first] ?? '') < 0) first = index;
  }
  return [...cycle.slice(first), ...cycle.slice(0, first)].join('\0');
}

function reaches(
  index: Map<TaskId, TaskRecord>,
  start: TaskId,
  target: TaskId,
): boolean {
  const visited = new Set<TaskId>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    for (const dependency of index.get(current)?.after ?? [])
      pending.push(dependency);
  }
  return false;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
