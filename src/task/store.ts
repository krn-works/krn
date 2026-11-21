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
import { contractBase } from '../repo/contract.ts';
import { assertFormat } from '../repo/formats.ts';
import { ARCHIVE_DIR } from './archive.ts';
import { claimFile, claimsDirectory, TASKS_DIR, taskFile } from './paths.ts';
import { isPendingId } from './pending.ts';
import {
  createTaskId,
  isCategoryToken,
  isTaskCategory,
  isTaskId,
  parseTaskDocument,
  TASK_CATEGORIES,
  type TaskAcceptance,
  type TaskCategory,
  TaskCommandError,
  TaskDataError,
  type TaskId,
  type TaskOrigin,
  type TaskRecord,
  type TaskResolution,
  type TaskStatus,
  TaskUsageError,
} from './record.ts';
import {
  archivedLines,
  createTaskRecord,
  locateTask,
  pendingRecordTexts,
  writeTaskRecord,
} from './storage.ts';

// Exit code of `krn task close` when an acceptance command fails.
const ACCEPTANCE_FAILED_EXIT = 66;

interface NewTask {
  title: string;
  priority?: number;
  after?: TaskId[];
  body?: string[];
  verify?: string[];
  kind?: TaskCategory;
  area?: string;
  stack?: string[];
  from?: TaskOrigin;
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
  /** Holds the new record on the pending ref (see `createsPending`) instead of `tasks/<id>.json`. */
  pending?: boolean;
  uniquenessRoots?: string[];
  /** Findings for a record about to be written; any finding refuses the write. */
  refuse?: (record: TaskRecord, index: Map<string, TaskRecord>) => string[];
  /** Receives one warning line per pending record that has findings (default: stderr). */
  warn?: (line: string) => void;
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
  return [
    ...findings,
    ...postMergeAfterFindings(records),
    ...deadAfterFindings(records),
  ];
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

// ADR 0015: only a `done` closure unblocks a dependent, so an open task after a
// task closed as dropped, duplicate or superseded waits forever unless re-pointed.
function deadAfterFindings(records: Map<TaskId, TaskRecord>): string[] {
  const findings: string[] = [];
  for (const record of records.values()) {
    if (record.status !== 'open') continue;
    for (const id of record.after) {
      const resolution = records.get(id)?.resolution;
      if (!resolution || resolution.kind === 'done') continue;
      const of = resolution.ref === null ? '' : ` of ${resolution.ref}`;
      findings.push(
        `tasks/${record.id}.json: after task "${id}" is closed as ${resolution.kind}${of}, so this task can never be claimed; run krn task dep rm ${record.id} --after ${id}${resolution.ref !== null && resolution.ref !== record.id ? `, then krn task dep add ${record.id} --after ${resolution.ref} if that work must come first` : ''}`,
      );
    }
  }
  return findings;
}

export function loadTaskIndex(root: string): Map<TaskId, TaskRecord> {
  assertFormat(root, 'krn.task');
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

  for (const entry of entries.sort((left, right) =>
    compare(left.name, right.name),
  )) {
    const relativePath = `tasks/${entry.name}`;
    if (entry.name === ARCHIVE_DIR && entry.isDirectory()) continue;
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

  for (const [id, contents] of pendingRecordTexts(root)) {
    const path = `pending tasks/${id}.json`;
    const parsed = parseTaskDocument(contents);
    for (const finding of parsed.findings) findings.push(`${path}: ${finding}`);
    if (parsed.record === undefined || parsed.id !== id) continue;
    // The pending version replaces the tree version: its edges are the only ones in the graph.
    for (let at = references.length - 1; at >= 0; at--)
      if (references[at]?.id === id) references.splice(at, 1);
    ids.add(parsed.record.id);
    references.push({
      path,
      id: parsed.id,
      after: parsed.afterReferences,
      resolutionRef: parsed.resolutionReference,
    });
    records.set(parsed.record.id, parsed.record);
  }

  for (const line of archivedLines(root)) {
    findings.push(...line.findings);
    if (line.id !== undefined && isTaskId(line.id)) {
      if (ids.has(line.id))
        findings.push(`${line.path}: id "${line.id}" is also a live task file`);
      ids.add(line.id);
    }
    references.push({
      path: line.path,
      id: line.id,
      after: line.after,
      resolutionRef: line.resolutionRef,
    });
    if (line.record !== undefined) records.set(line.record.id, line.record);
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
  filter: { kind?: TaskCategory; area?: string } = {},
): TaskRecord[] {
  return [...loadTaskIndex(root).values()]
    .filter((record) => status === 'all' || record.status === status)
    .filter(
      (record) => filter.kind === undefined || record.kind === filter.kind,
    )
    .filter(
      (record) => filter.area === undefined || record.area === filter.area,
    )
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compare(left.created, right.created) ||
        compare(left.id, right.id),
    );
}

/**
 * One task read from its own file, then from the archive, without scanning the
 * directory. A malformed record is reported; the rest of the tracker is not checked.
 */
export function readTask(root: string, id: TaskId): TaskRecord | undefined {
  return locateTask(root, id).record;
}

/** The fields of one task file or claim file, as a reader of a few fields sees them. */
export type TaskFields = Record<string, unknown>;

function readFields(path: string): TaskFields | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as TaskFields)
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonStems(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/** The raw text of `tasks/<id>.json` under `root`, undefined when the file is absent or unreadable. */
export function readTaskText(root: string, id: string): string | undefined {
  try {
    return readFileSync(join(root, taskFile(id)), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `tasks/<id>.json` under `root` without validation: undefined when absent, torn or not an object.
 * For readers that use a field or two and must not fail on a record `krn task check` reports.
 */
export function readTaskFields(
  root: string,
  id: string,
): TaskFields | undefined {
  return readFields(join(root, taskFile(id)));
}

/** Every readable `tasks/*.json` under `root`, by file stem. */
export function listTaskFields(
  root: string,
): { id: string; fields: TaskFields }[] {
  const found: { id: string; fields: TaskFields }[] = [];
  for (const id of jsonStems(join(root, TASKS_DIR))) {
    const fields = readTaskFields(root, id);
    if (fields !== undefined) found.push({ id, fields });
  }
  return found;
}

/** The claim file of task `id` in the main checkout `main`, undefined when absent, torn or not an object. */
export function readClaim(main: string, id: string): TaskFields | undefined {
  return readFields(claimFile(main, id));
}

/** Every readable claim file in the main checkout `main`, by task id, with the file path. */
export function listClaims(
  main: string,
): { id: string; path: string; claim: TaskFields }[] {
  const found: { id: string; path: string; claim: TaskFields }[] = [];
  for (const id of jsonStems(claimsDirectory(main))) {
    const claim = readClaim(main, id);
    if (claim !== undefined)
      found.push({ id, path: claimFile(main, id), claim });
  }
  return found;
}

/**
 * Ids of tasks that list `id` in `after`. Only text that names the id is
 * parsed, so the cost stays at one read per file.
 */
export function dependentsOf(root: string, id: TaskId): TaskId[] {
  const found = new Set<TaskId>();
  const pending = pendingRecordTexts(root);
  const consider = (text: string): void => {
    if (!text.includes(id)) return;
    const parsed = parseTaskDocument(text);
    if (parsed.record?.after.includes(id)) found.add(parsed.record.id);
  };
  const directory = join(root, 'tasks');
  if (existsSync(directory))
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        !pending.has(entry.name.slice(0, -'.json'.length))
      )
        consider(readFileSync(join(directory, entry.name), 'utf8'));
  for (const text of pending.values()) consider(text.toString());
  for (const line of archivedLines(root))
    if (line.record?.after.includes(id)) found.add(line.record.id);
  return [...found].sort();
}

/** Whether a live or archived record exists for `id`, without scanning the directory. */
export function hasTask(root: string, id: TaskId): boolean {
  return readTask(root, id) !== undefined;
}

export function getTask(root: string, id: TaskId): TaskRecord {
  const record = readTask(root, id);
  if (record === undefined)
    throw new TaskDataError([
      `tasks/${id}.json: task does not exist; run krn task list for the ids`,
    ]);
  return record;
}

export function createTask(
  root: string,
  input: NewTask,
  options: TaskStoreOptions = {},
): TaskRecord {
  assertFormat(root, 'krn.task');
  const scan = scanTaskDirectory(root);
  // A pending record waiting for publish is another author's work: its defects warn, never block.
  const blocking = scan.findings.filter((f) => !f.startsWith('pending '));
  if (blocking.length > 0) throw new TaskDataError(blocking);
  const warned = new Set<string>();
  for (const finding of scan.findings) {
    const record = finding.slice(0, finding.indexOf(':'));
    if (warned.has(record)) continue;
    warned.add(record);
    (options.warn ?? ((line) => process.stderr.write(`${line}\n`)))(
      `warning: ${finding}`,
    );
  }
  const index = scan.records;
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
      existsInOriginMain(root, id) ||
      isPendingId(root, id)
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
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.area === undefined ? {} : { area: input.area }),
      ...(input.stack === undefined || input.stack.length === 0
        ? {}
        : { stack: [...new Set(input.stack)].sort() }),
      ...(input.from === undefined ? {} : { from: input.from }),
    };
    const refusal = options.refuse?.(record, index) ?? [];
    if (refusal.length > 0) throw new TaskDataError(refusal);
    try {
      createTaskRecord(root, record, options.pending === true);
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
  const record = getTask(root, id);
  if (record.status === 'closed')
    throw new TaskDataError([`tasks/${id}.json: task is already closed`]);
  const write = (task: TaskRecord) => writeTaskRecord(root, task);
  if (
    (resolution.kind === 'duplicate' || resolution.kind === 'superseded') &&
    (resolution.ref === null || !hasTask(root, resolution.ref))
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
      write({ ...record, acceptance });
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
  write(closed);
  return closed;
}

export function editTask(
  root: string,
  id: TaskId,
  input: EditTask,
  options: Pick<TaskStoreOptions, 'refuse'> = {},
): TaskRecord {
  const record = getTask(root, id);
  if (locateTask(root, id).where === 'archived')
    throw new TaskDataError([
      `tasks/${id}.json: task is archived and read-only; create a new task instead`,
    ]);
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
  const refusal =
    updated.status === 'open'
      ? (options.refuse?.(updated, loadTaskIndex(root)) ?? [])
      : [];
  if (refusal.length > 0) throw new TaskDataError(refusal);
  writeTaskRecord(root, updated);
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
    throw new TaskDataError([
      `tasks/${id}.json: task does not exist; run krn task list for the ids`,
    ]);
  if (!index.has(dependency))
    throw new TaskDataError([
      `tasks/${id}.json: after task "${dependency}" does not exist`,
    ]);
  if (id === dependency)
    throw new TaskDataError([`tasks/${id}.json: task cannot depend on itself`]);
  if (locateTask(root, id).where === 'archived')
    throw new TaskDataError([
      `tasks/${id}.json: task is archived and read-only; create a new task instead`,
    ]);

  let after: TaskId[];
  if (operation === 'add') {
    if (reaches(index, dependency, id))
      throw new TaskDataError([
        `tasks/${id}.json: dependency "${dependency}" would create a cycle`,
      ]);
    after = [...new Set([...record.after, dependency])].sort();
  } else after = record.after.filter((candidate) => candidate !== dependency);

  const updated: TaskRecord = { ...record, after };
  writeTaskRecord(root, updated);
  return updated;
}

function validateNewTask(input: NewTask, index: Map<TaskId, TaskRecord>): void {
  const findings = validateTaskFields(input);
  if (input.kind !== undefined && !isTaskCategory(input.kind))
    findings.push(`kind must be one of ${TASK_CATEGORIES.join(', ')}`);
  if (input.area !== undefined && !isCategoryToken(input.area))
    findings.push('area must be a lowercase token');
  for (const item of input.stack ?? [])
    if (!isCategoryToken(item))
      findings.push(`stack entry "${item}" must be a lowercase token`);
  if (input.from !== undefined && input.from.ref.trim() === '')
    findings.push('from ref must not be empty');
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
  const base = `origin/${contractBase(root)}`;
  const branch = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`],
    { encoding: 'utf8' },
  );
  if (branch.status !== 0) return false;
  const object = spawnSync(
    'git',
    ['-C', root, 'cat-file', '-e', `${base}:tasks/${id}.json`],
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
