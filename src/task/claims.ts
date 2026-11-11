import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  parseTaskDocument,
  TaskCommandError,
  TaskDataError,
  type TaskId,
  type TaskRecord,
  TaskUsageError,
} from './record.ts';
import { atomicWrite } from './staged-write.ts';
import { getTask, loadTaskIndex } from './store.ts';

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
  reason: string;
  claim?: Partial<TaskClaim>;
  findings: string[];
}

export interface ClaimGitProbe {
  status: number | null;
  error?: Error;
  stdout: Buffer;
}

export interface ClaimLivenessProbes {
  resolveWorktree(path: string): string;
  worktreeList(root: string): ClaimGitProbe;
  branchRef(root: string, branch: string): ClaimGitProbe;
  taskFile(root: string, id: TaskId): Buffer;
  originRef(root: string): ClaimGitProbe;
  originTask(root: string, id: TaskId): ClaimGitProbe;
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

export async function readyTasks(
  root: string,
  limit?: number,
): Promise<ReadyTasks> {
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
  await pruneClosedClaims(mainRoot);
  return {
    tasks: ready,
    findings,
  };
}

/**
 * A task closes inside its delivery branch, so its claim in the main checkout
 * outlives the merge. Once the main checkout's record says closed, the claim
 * holds nothing and is removed; claims of open or unknown tasks stay.
 */
async function pruneClosedClaims(mainRoot: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(join(mainRoot, '.krn', 'task-claims'));
  } catch {
    return;
  }
  const index = loadTaskIndex(mainRoot);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length) as TaskId;
    if (index.get(id)?.status !== 'closed') continue;
    try {
      await withTaskLock(mainRoot, id, () => {
        unlinkSync(claimPath(mainRoot, id));
      });
    } catch {
      /* Removed first by another ready, or busy under a claim operation: leave it. */
    }
  }
}

export function inspectClaim(root: string, id: TaskId): ClaimInspection {
  return inspectClaimAt(mainCheckoutRoot(root), id);
}

export function taskRecordRoot(cwdRoot: string, id: TaskId): string {
  // A linked worktree always owns its own records; only the main checkout
  // forwards a write to the worktree that holds the claim.
  if (realpathSync(cwdRoot) !== mainCheckoutRoot(cwdRoot)) return cwdRoot;
  const claim = inspectClaim(cwdRoot, id);
  return claim.state === 'live' &&
    claim.claim?.worktree &&
    claim.claim.worktree !== realpathSync(cwdRoot)
    ? claim.claim.worktree
    : cwdRoot;
}

export function registeredTaskWorktree(root: string, path: string): string {
  return resolveClaimWorktree(root, path);
}

function inspectClaimAt(mainRoot: string, id: TaskId): ClaimInspection {
  const path = claimPath(mainRoot, id);
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissing(error))
      return { state: 'none', reason: 'none', findings: [] };
    return {
      state: 'corrupt',
      reason: 'corrupt',
      findings: ['unable to inspect claim file'],
    };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return {
      state: 'corrupt',
      reason: 'corrupt',
      findings: ['unable to read claim file'],
    };
  }

  const parsed = parseClaim(bytes, id);
  if (parsed.findings.length > 0)
    return {
      state: 'corrupt',
      reason: 'corrupt',
      ...(parsed.claim === undefined ? {} : { claim: parsed.claim }),
      findings: parsed.findings,
    };
  const claim = parsed.claim as TaskClaim;
  const liveness = claimLiveness(mainRoot, claim);
  return {
    state: liveness.state,
    reason: liveness.reason,
    claim,
    findings: [],
  };
}

export async function claimTask(
  root: string,
  id: TaskId,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const worktreeRoot = resolveClaimWorktree(root, options.worktree);
  const branch = currentBranch(worktreeRoot);
  const task = getTask(worktreeRoot, id);
  if (task.status !== 'open')
    throw new TaskDataError([`tasks/${id}.json: task is closed`]);
  assertDependenciesDone(worktreeRoot, task);

  const mainRoot = mainCheckoutRoot(worktreeRoot);
  const path = claimPath(mainRoot, id);
  return withTaskLock(mainRoot, id, () => {
    const current = inspectClaimAt(mainRoot, id);
    const claim: TaskClaim = {
      id,
      actor: options.actor,
      worktree: realpathSync(worktreeRoot),
      branch,
      claimed: new Date().toISOString(),
      reason: options.reason ?? null,
    };
    const serialized = serializeClaim(claim);
    if (current.state === 'live' || current.state === 'corrupt') {
      if (!options.takeover) throw heldClaimError(current);
      atomicWrite(mainRoot, path, serialized, true);
      return { id, previous: current };
    }

    let removedExpired: ClaimInspection | undefined;
    if (current.state === 'expired') {
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      removedExpired = current;
    }

    try {
      atomicWrite(mainRoot, path, serialized);
    } catch (error) {
      if (isAlreadyExists(error))
        throw heldClaimError(inspectClaimAt(mainRoot, id));
      throw error;
    }
    return { id, ...(removedExpired === undefined ? {} : { removedExpired }) };
  });
}

export async function claimNext(
  root: string,
  options: ClaimOptions,
  limit?: number,
): Promise<ClaimResult> {
  const worktreeRoot = resolveClaimWorktree(root, options.worktree);
  currentBranch(worktreeRoot);
  const candidates = (await readyTasks(worktreeRoot, limit)).tasks;
  for (const candidate of candidates) {
    try {
      return await claimTask(worktreeRoot, candidate.id, {
        ...options,
        worktree: worktreeRoot,
      });
    } catch (error) {
      if (error instanceof TaskCommandError && error.exitCode === 75) {
        if (error.message.includes('claim is busy')) throw error;
        continue;
      }
      throw error;
    }
  }
  throw new TaskCommandError('no ready tasks are available to claim', 75);
}

export async function releaseClaim(
  root: string,
  id: TaskId,
): Promise<ClaimInspection> {
  const mainRoot = mainCheckoutRoot(root);
  const path = claimPath(mainRoot, id);
  return withTaskLock(mainRoot, id, () => {
    const current = inspectClaimAt(mainRoot, id);
    if (current.state === 'none')
      throw new TaskDataError([`task ${id} has no claim to release`]);
    try {
      unlinkSync(path);
    } catch (error) {
      if (isMissing(error))
        throw new TaskDataError([`task ${id} has no claim to release`]);
      throw error;
    }
    return current;
  });
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
  const lines = [`Claim: ${inspection.reason}`];
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

export function claimLiveness(
  mainRoot: string,
  claim: TaskClaim,
  probes: ClaimLivenessProbes = defaultClaimLivenessProbes(),
): { state: 'live' | 'expired'; reason: string } {
  let worktree: string;
  try {
    worktree = probes.resolveWorktree(claim.worktree);
  } catch (error) {
    if (isMissing(error)) return expired('worktree path is missing');
    return live();
  }

  const listed = probes.worktreeList(mainRoot);
  if (!probeSucceeded(listed)) return live();
  let registered: Set<string>;
  try {
    registered = registeredWorktrees(listed.stdout);
  } catch {
    return live();
  }
  if (!registered.has(worktree)) return expired('worktree is not registered');

  const branch = probes.branchRef(mainRoot, claim.branch);
  if (probeSucceeded(branch)) {
    // The branch exists; continue checking the task.
  } else if (branch.error === undefined && branch.status === 1) {
    return expired(`branch ${claim.branch} does not exist`);
  } else return live();

  let localTask: Buffer;
  try {
    localTask = probes.taskFile(worktree, claim.id);
  } catch (error) {
    if (isMissing(error)) return expired('task file is missing from worktree');
    return live();
  }
  const localParsed = parseTaskDocument(localTask);
  if (localParsed.findings.length !== 0 || localParsed.record?.id !== claim.id)
    return live();
  // A task closed in its worktree is in delivery: the claim stays live until
  // the merge closes it in origin/main, so ready never offers it meanwhile.
  const state = localParsed.record.status === 'closed' ? inDelivery() : live();

  const originRef = probes.originRef(mainRoot);
  if (!probeSucceeded(originRef)) return state;
  const originTask = probes.originTask(mainRoot, claim.id);
  if (!probeSucceeded(originTask)) return state;
  const originParsed = parseTaskDocument(originTask.stdout);
  if (
    originParsed.findings.length === 0 &&
    originParsed.record?.id === claim.id &&
    originParsed.record.status === 'closed'
  )
    return expired('task is closed in origin/main');
  return state;
}

function defaultClaimLivenessProbes(): ClaimLivenessProbes {
  return {
    resolveWorktree: (path) => realpathSync(path),
    worktreeList: (root) =>
      gitProbe(root, ['worktree', 'list', '--porcelain', '-z']),
    branchRef: (root, branch) =>
      gitProbe(root, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]),
    taskFile: (root, id) => readFileSync(join(root, 'tasks', `${id}.json`)),
    originRef: (root) =>
      gitProbe(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        'origin/main^{commit}',
      ]),
    originTask: (root, id) =>
      gitProbe(root, ['show', `origin/main:tasks/${id}.json`]),
  };
}

function gitProbe(root: string, args: string[]): ClaimGitProbe {
  const result = spawnSync('git', ['-C', root, ...args]);
  return {
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
  };
}

function probeSucceeded(probe: ClaimGitProbe): boolean {
  return probe.status === 0 && probe.error === undefined;
}

function live(): { state: 'live'; reason: string } {
  return { state: 'live', reason: 'live' };
}

function inDelivery(): { state: 'live'; reason: string } {
  return { state: 'live', reason: 'live: in delivery, closed in worktree' };
}

function expired(evidence: string): { state: 'expired'; reason: string } {
  return { state: 'expired', reason: `expired: ${evidence}` };
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
  const listing = defaultClaimLivenessProbes().worktreeList(root);
  if (!probeSucceeded(listing))
    throw new TaskUsageError(`claim worktree is not registered: ${canonical}`);
  let registered: Set<string>;
  try {
    registered = registeredWorktrees(listing.stdout);
  } catch {
    throw new TaskUsageError(`claim worktree is not registered: ${canonical}`);
  }
  if (!registered.has(canonical))
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

function registeredWorktrees(output: Buffer): Set<string> {
  const paths = new Set<string>();
  for (const field of output.toString('utf8').split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    const path = field.slice('worktree '.length);
    paths.add(realpathSync(path));
  }
  return paths;
}

export function mainCheckoutRoot(root: string): string {
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

async function withTaskLock<T>(
  mainRoot: string,
  id: TaskId,
  operation: () => T | Promise<T>,
): Promise<T> {
  const lock = await acquireTaskLock(mainRoot, id);
  try {
    await holdTaskLockForTest();
    return await operation();
  } finally {
    await releaseTaskLock(lock);
  }
}

async function acquireTaskLock(mainRoot: string, id: TaskId): Promise<Server> {
  if (process.platform !== 'linux')
    throw new TaskUsageError('claim locking requires Linux');

  const lockId = createHash('sha256')
    .update(mainRoot)
    .update('\0')
    .update(id)
    .digest('hex');
  const address = `\0krn-task-lock:${lockId}`;

  const deadline = performance.now() + lockWaitMs();
  while (true) {
    try {
      return await listenForTaskLock(address);
    } catch (error) {
      if (errorCode(error) !== 'EADDRINUSE') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new TaskCommandError('task claim is busy', 75);
      await wait(Math.min(25, remaining));
    }
  }
}

function listenForTaskLock(address: string): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(address, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

async function releaseTaskLock(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function lockWaitMs(): number {
  const override = Number(process.env.KRN_TASK_LOCK_WAIT_MS);
  if (
    process.env.NODE_ENV === 'test' &&
    Number.isSafeInteger(override) &&
    override >= 0
  )
    return override;
  return 2_000;
}

async function holdTaskLockForTest(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') return;
  const descriptor = Number(process.env.KRN_TASK_LOCK_HOLD_FD);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) return;
  writeSync(descriptor, 'locked\n');
  await new Promise<void>(() => {});
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
