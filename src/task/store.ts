import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  type Dirent,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  createTaskId,
  isTaskId,
  parseTaskDocument,
  serializeTask,
  TaskDataError,
  type TaskId,
  type TaskRecord,
  type TaskResolution,
  type TaskStatus,
  TaskUsageError,
} from './record.ts';

export interface NewTask {
  title: string;
  priority?: number;
  after?: TaskId[];
  body?: string[];
}

export interface TaskStoreOptions {
  makeId?: () => TaskId;
}

export function repositoryRoot(cwd = process.cwd()): string {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new TaskUsageError('task commands must run inside a git repository');
  return result.stdout.trim();
}

export function checkTaskDirectory(root: string): string[] {
  return scanTaskDirectory(root).findings;
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

  for (const entry of entries.sort((left, right) =>
    compare(left.name, right.name),
  )) {
    const relativePath = `tasks/${entry.name}`;
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
  findings.push(...findCycles(records));
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
    if (existsSync(path) || existsInOriginMain(root, id)) continue;
    const record: TaskRecord = {
      id,
      status: 'open',
      resolution: null,
      created: new Date().toISOString().slice(0, 10),
      priority: input.priority ?? 2,
      title: input.title,
      after: [...new Set(input.after ?? [])].sort(),
      body: [...(input.body ?? [])],
    };
    try {
      atomicWrite(directory, path, serializeTask(record), true);
      return record;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw new TaskDataError(['unable to allocate an unused task id']);
}

export function closeTask(
  root: string,
  id: TaskId,
  resolution: TaskResolution,
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

  const closed: TaskRecord = {
    ...record,
    status: 'closed',
    resolution,
  };
  atomicWrite(
    join(root, 'tasks'),
    join(root, 'tasks', `${id}.json`),
    serializeTask(closed),
  );
  return closed;
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
    join(root, 'tasks'),
    join(root, 'tasks', `${id}.json`),
    serializeTask(updated),
  );
  return updated;
}

function validateNewTask(input: NewTask, index: Map<TaskId, TaskRecord>): void {
  const findings: string[] = [];
  if (input.title.trim().length === 0) findings.push('title must not be empty');
  if (/[\r\n]/u.test(input.title)) findings.push('title must be a single line');
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 3)
  )
    findings.push('priority must be an integer between 0 and 3');
  for (const dependency of input.after ?? []) {
    if (!isTaskId(dependency))
      findings.push(`invalid after task id "${dependency}"`);
    else if (!index.has(dependency))
      findings.push(`after task "${dependency}" does not exist`);
  }
  if (findings.length > 0) throw new TaskDataError(findings);
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

function atomicWrite(
  directory: string,
  target: string,
  contents: string,
  create = false,
): void {
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o666);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      linkSync(temporary, target);
      unlinkSync(temporary);
    } else renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function findCycles(records: Map<TaskId, TaskRecord>): string[] {
  const findings: string[] = [];
  const state = new Map<TaskId, 0 | 1 | 2>();
  const stack: TaskId[] = [];
  const reported = new Set<string>();

  const visit = (id: TaskId) => {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of records.get(id)?.after ?? []) {
      if (!records.has(dependency)) continue;
      if (state.get(dependency) === 1) {
        const cycle = stack.slice(stack.indexOf(dependency));
        const key = normalizeCycle(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          findings.push(
            `tasks: dependency cycle ${[...cycle, dependency].join(' -> ')}`,
          );
        }
      } else if (state.get(dependency) !== 2) visit(dependency);
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of records.keys()) {
    if (state.get(id) === undefined) visit(id);
  }
  return findings;
}

function normalizeCycle(cycle: TaskId[]): string {
  const rotations = cycle.map((_, index) =>
    [...cycle.slice(index), ...cycle.slice(0, index)].join('\0'),
  );
  return rotations.sort(compare)[0] ?? '';
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
    pending.push(...(index.get(current)?.after ?? []));
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
