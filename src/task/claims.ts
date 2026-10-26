import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  parseTaskDocument,
  TaskCommandError,
  TaskDataError,
  type TaskId,
  type TaskRecord,
  TaskUsageError,
} from './record.ts';
import { getTask, loadTaskIndex, repositoryRoot } from './store.ts';

export const claimKeys = [
  'id',
  'actor',
  'worktree',
  'branch',
  'claimed',
  'reason',
] as const;

export type ClaimState = 'live' | 'expired' | 'corrupt' | 'none';

export interface TaskClaim {
  id: TaskId;
  actor: string;
  worktree: string;
  branch: string;
  claimed: string;
  reason: string | null;
}

export interface ClaimInspection {
  state: ClaimState;
  claim?: Partial<TaskClaim>;
  findings: string[];
}

export interface ReadyTasks {
  tasks: TaskRecord[];
  findings: Array<{ id: TaskId; findings: string[] }>;
}

export interface ClaimOptions {
  actor: string;
  reason?: string;
  worktree?: string;
  takeover?: boolean;
}

export interface ClaimResult {
  id: TaskId;
  previous?: ClaimInspection;
  removedExpired?: ClaimInspection;
}

export function readyTasks(root: string, limit?: number): ReadyTasks {
  const index = loadTaskIndex(root);
  const mainRoot = mainCheckoutRoot(root);
  const ordered = [...index.values()]
    .filter(
      (task) =>
        task.status === 'open' &&
        task.after.every((id) => {
          const dependency = index.get(id);
          return (
            dependency?.status === 'closed' &&
            dependency.resolution?.kind === 'done'
          );
        }),
    )
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compare(left.created, right.created) ||
        compare(left.id, right.id),
    );
  const ready: TaskRecord[] = [];
  const findings: ReadyTasks['findings'] = [];
  for (const task of ordered) {
    if (limit !== undefined && ready.length >= limit) break;
    const claim = inspectClaimAt(mainRoot, task.id);
    if (claim.state === 'corrupt')
      findings.push({ id: task.id, findings: claim.findings });
    if (claim.state === 'none' || claim.state === 'expired') ready.push(task);
  }
  return {
    tasks: ready,
    findings,
  };
}

export function inspectClaim(root: string, id: TaskId): ClaimInspection {
  return inspectClaimAt(mainCheckoutRoot(root), id);
}

function inspectClaimAt(mainRoot: string, id: TaskId): ClaimInspection {
  const path = claimPath(mainRoot, id);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (isMissing(error)) return { state: 'none', findings: [] };
    return {
      state: 'corrupt',
      findings: ['unable to read claim file'],
    };
  }

  const parsed = parseClaim(bytes, id);
  if (parsed.findings.length > 0)
    return {
      state: 'corrupt',
      ...(parsed.claim === undefined ? {} : { claim: parsed.claim }),
      findings: parsed.findings,
    };
  const claim = parsed.claim as TaskClaim;
  return {
    state: claimIsLive(mainRoot, claim) ? 'live' : 'expired',
    claim,
    findings: [],
  };
}

export function claimTask(
  root: string,
  id: TaskId,
  options: ClaimOptions,
): ClaimResult {
  const worktreeRoot = resolveClaimWorktree(root, options.worktree);
  const branch = currentBranch(worktreeRoot);
  const task = getTask(worktreeRoot, id);
  if (task.status !== 'open')
    throw new TaskDataError([`tasks/${id}.json: task is closed`]);
  assertDependenciesDone(worktreeRoot, task);

  const mainRoot = mainCheckoutRoot(worktreeRoot);
  const path = claimPath(mainRoot, id);
  const current = inspectClaimAt(mainRoot, id);
  let previous: ClaimInspection | undefined;
  let removedExpired: ClaimInspection | undefined;
  if (current.state === 'live' || current.state === 'corrupt') {
    if (!options.takeover) throw heldClaimError(current);
    previous = current;
  } else if (current.state === 'expired') {
    removedExpired = current;
    removeClaim(path);
  }

  const claim: TaskClaim = {
    id,
    actor: options.actor,
    worktree: realpathSync(worktreeRoot),
    branch,
    claimed: new Date().toISOString(),
    reason: options.reason ?? null,
  };
  try {
    writeClaim(
      mainRoot,
      path,
      serializeClaim(claim),
      options.takeover === true && previous !== undefined,
    );
  } catch (error) {
    if (isAlreadyExists(error)) {
      const raced = inspectClaim(worktreeRoot, id);
      if (
        options.takeover &&
        (raced.state === 'live' || raced.state === 'corrupt')
      ) {
        writeClaim(mainRoot, path, serializeClaim(claim), true);
      } else throw heldClaimError(raced);
    } else throw error;
  }
  return {
    id,
    ...(previous === undefined ? {} : { previous }),
    ...(removedExpired === undefined ? {} : { removedExpired }),
  };
}

export function claimNext(
  root: string,
  options: ClaimOptions,
  limit?: number,
): ClaimResult {
  const worktreeRoot = resolveClaimWorktree(root, options.worktree);
  currentBranch(worktreeRoot);
  const candidates = readyTasks(worktreeRoot, limit).tasks;
  for (const candidate of candidates) {
    try {
      return claimTask(worktreeRoot, candidate.id, {
        ...options,
        worktree: worktreeRoot,
      });
    } catch (error) {
      if (error instanceof TaskCommandError && error.exitCode === 75) continue;
      throw error;
    }
  }
  throw new TaskCommandError('no ready tasks are available to claim', 75);
}

export function releaseClaim(root: string, id: TaskId): ClaimInspection {
  const mainRoot = mainCheckoutRoot(root);
  const path = claimPath(mainRoot, id);
  const current = inspectClaimAt(mainRoot, id);
  if (current.state === 'none')
    throw new TaskDataError([`task ${id} has no claim to release`]);
  removeClaim(path);
  return current;
}

export function serializeClaim(claim: TaskClaim): string {
  const canonical: TaskClaim = {
    id: claim.id,
    actor: claim.actor,
    worktree: claim.worktree,
    branch: claim.branch,
    claimed: claim.claimed,
    reason: claim.reason,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function formatClaim(inspection: ClaimInspection): string[] {
  const lines = [`Claim: ${inspection.state}`];
  const claim = inspection.claim;
  if (claim !== undefined) {
    if (typeof claim.actor === 'string') lines.push(`Actor: ${claim.actor}`);
    if (typeof claim.worktree === 'string')
      lines.push(`Worktree: ${claim.worktree}`);
    if (typeof claim.branch === 'string') lines.push(`Branch: ${claim.branch}`);
    if (typeof claim.claimed === 'string')
      lines.push(`Claimed: ${claim.claimed}`);
    if (typeof claim.reason === 'string') lines.push(`Reason: ${claim.reason}`);
  }
  for (const finding of inspection.findings)
    lines.push(`Claim finding: ${finding}`);
  return lines;
}

export function claimHolder(inspection: ClaimInspection): string {
  const claim = inspection.claim;
  if (claim === undefined) return 'holder details unavailable';
  return (
    [
      typeof claim.actor === 'string' ? `actor ${claim.actor}` : undefined,
      typeof claim.worktree === 'string'
        ? `worktree ${claim.worktree}`
        : undefined,
      typeof claim.branch === 'string' ? `branch ${claim.branch}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(', ') || 'holder details unavailable'
  );
}

function parseClaim(
  bytes: Buffer,
  expectedId: TaskId,
): { claim?: Partial<TaskClaim>; findings: string[] } {
  const findings: string[] = [];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { findings: ['file is not valid UTF-8'] };
  }
  const hasBom = text.startsWith('\uFEFF');
  if (hasBom) findings.push('file starts with a byte order mark');
  if (text.includes('\r'))
    findings.push('contains CR characters; claims require LF');
  if (!text.endsWith('\n')) findings.push('missing trailing newline');

  let value: unknown;
  try {
    value = JSON.parse(hasBom ? text.slice(1) : text);
  } catch {
    findings.push('invalid JSON');
    return { findings };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push('claim must be a JSON object');
    return { findings };
  }

  const object = value as Record<string, unknown>;
  const actualKeys = Object.keys(object);
  for (const key of claimKeys) {
    if (!(key in object)) findings.push(`missing key "${key}"`);
  }
  for (const key of actualKeys) {
    if (!(claimKeys as readonly string[]).includes(key))
      findings.push(`extra key "${key}"`);
  }
  if (
    actualKeys.length !== claimKeys.length ||
    actualKeys.some((key, index) => key !== claimKeys[index])
  )
    findings.push('wrong top-level key order');

  const id = typeof object.id === 'string' ? object.id : undefined;
  if (id === undefined) findings.push('"id" must be a string');
  else if (id !== expectedId) findings.push(`"id" must equal "${expectedId}"`);
  const actor = typeof object.actor === 'string' ? object.actor : undefined;
  if (actor === undefined) findings.push('"actor" must be a string');
  else if (actor.trim() === '') findings.push('"actor" must not be empty');
  const worktree =
    typeof object.worktree === 'string' ? object.worktree : undefined;
  if (worktree === undefined) findings.push('"worktree" must be a string');
  else if (!worktree.startsWith('/'))
    findings.push('"worktree" must be absolute');
  const branch = typeof object.branch === 'string' ? object.branch : undefined;
  if (branch === undefined) findings.push('"branch" must be a string');
  else if (branch.trim() === '') findings.push('"branch" must not be empty');
  const claimed =
    typeof object.claimed === 'string' ? object.claimed : undefined;
  if (claimed === undefined) findings.push('"claimed" must be a string');
  else if (!isCanonicalUtc(claimed))
    findings.push('"claimed" must be an ISO-8601 UTC timestamp');
  const reason = object.reason;
  if (reason !== null && typeof reason !== 'string')
    findings.push('"reason" must be a string or null');

  const claim: Partial<TaskClaim> = {
    ...(id === undefined ? {} : { id }),
    ...(actor === undefined ? {} : { actor }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(branch === undefined ? {} : { branch }),
    ...(claimed === undefined ? {} : { claimed }),
    ...(reason === null || typeof reason === 'string' ? { reason } : {}),
  };
  if (findings.length === 0) {
    const canonical = serializeClaim(claim as TaskClaim);
    if (canonical !== text)
      findings.push('file does not use canonical claim serialization');
  }
  return { claim, findings };
}

function claimIsLive(mainRoot: string, claim: TaskClaim): boolean {
  let worktree: string;
  try {
    worktree = realpathSync(claim.worktree);
  } catch {
    return false;
  }
  const registered = registeredWorktrees(mainRoot);
  if (!registered.has(worktree)) return false;
  if (!branchExists(mainRoot, claim.branch)) return false;
  if (!taskOpenInWorktree(worktree, claim.id)) return false;
  const origin = taskInOriginMain(mainRoot, claim.id);
  return !origin.present || origin.open;
}

function taskOpenInWorktree(root: string, id: TaskId): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, 'tasks', `${id}.json`));
  } catch (error) {
    return isMissing(error);
  }
  const parsed = parseTaskDocument(bytes);
  return (
    parsed.findings.length === 0 &&
    parsed.record?.id === id &&
    parsed.record.status === 'open'
  );
}

function taskInOriginMain(
  root: string,
  id: TaskId,
): { present: false } | { present: true; open: boolean } {
  const origin = spawnSync('git', [
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    'origin/main^{commit}',
  ]);
  if (origin.status !== 0 || origin.error !== undefined)
    return { present: false };
  const exists = spawnSync('git', [
    '-C',
    root,
    'cat-file',
    '-e',
    `origin/main:tasks/${id}.json`,
  ]);
  if (exists.status !== 0 || exists.error !== undefined)
    return { present: false };
  const result = spawnSync('git', [
    '-C',
    root,
    'show',
    `origin/main:tasks/${id}.json`,
  ]);
  if (result.status !== 0 || result.error !== undefined)
    return { present: true, open: false };
  const parsed = parseTaskDocument(result.stdout as Buffer);
  return {
    present: true,
    open:
      parsed.findings.length === 0 &&
      parsed.record?.id === id &&
      parsed.record.status === 'open',
  };
}

function assertDependenciesDone(root: string, task: TaskRecord): void {
  const index = loadTaskIndex(root);
  const open = task.after.filter(
    (id) =>
      index.get(id)?.status !== 'closed' ||
      index.get(id)?.resolution?.kind !== 'done',
  );
  if (open.length > 0)
    throw new TaskDataError([
      `tasks/${task.id}.json: blocked by open after task${open.length === 1 ? '' : 's'} ${open.join(', ')}`,
    ]);
}

function resolveClaimWorktree(root: string, path?: string): string {
  const candidate = path === undefined ? root : resolve(root, path);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new TaskUsageError(`claim worktree does not exist: ${candidate}`);
  }
  if (!registeredWorktrees(root).has(canonical))
    throw new TaskUsageError(`claim worktree is not registered: ${canonical}`);
  return canonical;
}

function currentBranch(root: string): string {
  const result = spawnSync(
    'git',
    ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      encoding: 'utf8',
    },
  );
  const branch = result.status === 0 ? result.stdout.trim() : '';
  if (branch === '')
    throw new TaskUsageError('cannot claim from detached HEAD');
  return branch;
}

function registeredWorktrees(root: string): Set<string> {
  const result = spawnSync('git', [
    '-C',
    root,
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  if (result.status !== 0 || result.error !== undefined) return new Set();
  const paths = new Set<string>();
  for (const field of (result.stdout as Buffer).toString('utf8').split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    const path = field.slice('worktree '.length);
    try {
      paths.add(realpathSync(path));
    } catch {
      paths.add(resolve(path));
    }
  }
  return paths;
}

function branchExists(root: string, branch: string): boolean {
  const result = spawnSync('git', [
    '-C',
    root,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  return result.status === 0;
}

function mainCheckoutRoot(root: string): string {
  const result = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new TaskUsageError('unable to resolve the main checkout');
  try {
    return realpathSync(dirname(result.stdout.trim()));
  } catch {
    throw new TaskUsageError('unable to resolve the main checkout');
  }
}

function claimPath(mainRoot: string, id: TaskId): string {
  return join(mainRoot, '.krn', 'task-claims', `${id}.json`);
}

function writeClaim(
  mainRoot: string,
  target: string,
  contents: string,
  replace: boolean,
): void {
  const staging = join(mainRoot, '.krn', 'tmp', 'task-write');
  mkdirSync(staging, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(staging, `.${basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o666);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (replace) renameSync(temporary, target);
    else {
      linkSync(temporary, target);
      unlinkSync(temporary);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function removeClaim(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function heldClaimError(inspection: ClaimInspection): TaskCommandError {
  return new TaskCommandError(
    `task is held by ${claimHolder(inspection)}${inspection.findings.length > 0 ? `; claim findings: ${inspection.findings.join('; ')}` : ''}`,
    75,
  );
}

function isCanonicalUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
