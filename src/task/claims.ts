import { spawnSync } from 'node:child_process';
import {
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  parseTaskDocument,
  TaskCommandError,
  TaskDataError,
  type TaskId,
  type TaskRecord,
  TaskUsageError,
} from './record.ts';
import {
  atomicWrite,
  discardStagedWrite,
  publishStagedWrite,
  stageWrite,
  uniqueStagingPath,
} from './staged-write.ts';
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

export interface ClaimTaskHooks {
  afterInspect?: (inspection: ClaimInspection) => void;
}

interface ClaimFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface ClaimSnapshot {
  inspection: ClaimInspection;
  identity?: ClaimFileIdentity;
  bytes?: Buffer;
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
  return inspectClaimSnapshotAt(mainRoot, id).inspection;
}

function inspectClaimSnapshotAt(mainRoot: string, id: TaskId): ClaimSnapshot {
  const path = claimPath(mainRoot, id);
  let identity: ClaimFileIdentity;
  try {
    identity = claimFileIdentity(path);
  } catch (error) {
    if (isMissing(error))
      return {
        inspection: { state: 'none', reason: 'none', findings: [] },
      };
    return {
      inspection: {
        state: 'corrupt',
        reason: 'corrupt',
        findings: ['unable to inspect claim file'],
      },
    };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return {
      identity,
      inspection: {
        state: 'corrupt',
        reason: 'corrupt',
        findings: ['unable to read claim file'],
      },
    };
  }

  const parsed = parseClaim(bytes, id);
  if (parsed.findings.length > 0)
    return {
      identity,
      bytes,
      inspection: {
        state: 'corrupt',
        reason: 'corrupt',
        ...(parsed.claim === undefined ? {} : { claim: parsed.claim }),
        findings: parsed.findings,
      },
    };
  const claim = parsed.claim as TaskClaim;
  const liveness = claimLiveness(mainRoot, claim);
  return {
    identity,
    bytes,
    inspection: {
      state: liveness.state,
      reason: liveness.reason,
      claim,
      findings: [],
    },
  };
}

export function claimTask(
  root: string,
  id: TaskId,
  options: ClaimOptions,
  hooks: ClaimTaskHooks = {},
): ClaimResult {
  const worktreeRoot = resolveClaimWorktree(root, options.worktree);
  const branch = currentBranch(worktreeRoot);
  const task = getTask(worktreeRoot, id);
  if (task.status !== 'open')
    throw new TaskDataError([`tasks/${id}.json: task is closed`]);
  assertDependenciesDone(worktreeRoot, task);

  const mainRoot = mainCheckoutRoot(worktreeRoot);
  const path = claimPath(mainRoot, id);
  let previous: ClaimInspection | undefined;
  let removedExpired: ClaimInspection | undefined;
  const claim: TaskClaim = {
    id,
    actor: options.actor,
    worktree: realpathSync(worktreeRoot),
    branch,
    claimed: new Date().toISOString(),
    reason: options.reason ?? null,
  };
  const serialized = serializeClaim(claim);
  let takeoverRetries = 0;
  let expiredRetries = 0;

  while (true) {
    const snapshot = inspectClaimSnapshotAt(mainRoot, id);
    const current = snapshot.inspection;
    hooks.afterInspect?.(current);

    if (current.state === 'live' || current.state === 'corrupt') {
      if (!options.takeover) throw heldClaimError(current);
      if (snapshot.identity === undefined) throw heldClaimError(current);
      const outcome = compareAndReplaceClaim(
        mainRoot,
        path,
        snapshot,
        serialized,
      );
      if (outcome === 'replaced') {
        previous = current;
        break;
      }
      if (takeoverRetries === 0) {
        takeoverRetries += 1;
        continue;
      }
      throw claimChangedError('while taking over');
    }

    if (current.state === 'expired') {
      if (snapshot.identity === undefined)
        throw claimChangedError('while removing an expired claim');
      const outcome = compareAndRemoveClaim(mainRoot, path, snapshot);
      if (outcome === 'removed') {
        removedExpired = current;
        break;
      }
      if (outcome === 'missing' && expiredRetries === 0) {
        expiredRetries += 1;
        continue;
      }
      if (outcome === 'changed')
        throw heldClaimError(inspectClaimAt(mainRoot, id));
      throw claimChangedError('while removing an expired claim');
    }

    break;
  }

  if (previous === undefined) {
    try {
      atomicWrite(mainRoot, path, serialized);
    } catch (error) {
      if (isAlreadyExists(error))
        throw heldClaimError(inspectClaimAt(mainRoot, id));
      throw error;
    }
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

export function releaseClaim(
  root: string,
  id: TaskId,
  hooks: ClaimTaskHooks = {},
): ClaimInspection {
  const mainRoot = mainCheckoutRoot(root);
  const path = claimPath(mainRoot, id);
  const snapshot = inspectClaimSnapshotAt(mainRoot, id);
  const current = snapshot.inspection;
  hooks.afterInspect?.(current);
  if (current.state === 'none')
    throw new TaskDataError([`task ${id} has no claim to release`]);
  if (snapshot.identity === undefined)
    throw claimChangedError('while releasing');
  const outcome = compareAndRemoveClaim(mainRoot, path, snapshot);
  if (outcome === 'missing')
    throw new TaskDataError([`task ${id} has no claim to release`]);
  if (outcome === 'changed') throw claimChangedError('while releasing');
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
  if (
    localParsed.findings.length === 0 &&
    localParsed.record?.id === claim.id
  ) {
    if (localParsed.record.status === 'closed')
      return expired('task is closed in worktree');
    if (localParsed.record.status !== 'open') return live();
  } else return live();

  const originRef = probes.originRef(mainRoot);
  if (!probeSucceeded(originRef)) return live();
  const originTask = probes.originTask(mainRoot, claim.id);
  if (!probeSucceeded(originTask)) return live();
  const originParsed = parseTaskDocument(originTask.stdout);
  if (
    originParsed.findings.length === 0 &&
    originParsed.record?.id === claim.id &&
    originParsed.record.status === 'closed'
  )
    return expired('task is closed in origin/main');
  return live();
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

type CompareAndRemoveResult = 'removed' | 'missing' | 'changed';

type CompareAndReplaceResult = 'replaced' | 'missing' | 'changed';

function compareAndRemoveClaim(
  mainRoot: string,
  target: string,
  inspected: ClaimSnapshot,
): CompareAndRemoveResult {
  const moved = moveClaimToStaging(mainRoot, target);
  if (moved === undefined) return 'missing';
  if (!claimSnapshotStillMatches(moved, inspected)) {
    restoreClaim(moved, target);
    return 'changed';
  }
  unlinkSync(moved);
  return 'removed';
}

function compareAndReplaceClaim(
  mainRoot: string,
  target: string,
  inspected: ClaimSnapshot,
  contents: string,
): CompareAndReplaceResult {
  const staged = stageWrite(mainRoot, target, contents);
  try {
    const moved = moveClaimToStaging(mainRoot, target);
    if (moved === undefined) return 'missing';
    if (!claimSnapshotStillMatches(moved, inspected)) {
      restoreClaim(moved, target);
      return 'changed';
    }
    try {
      publishStagedWrite(staged, target);
    } catch (error) {
      restoreClaim(moved, target);
      if (isAlreadyExists(error)) return 'changed';
      throw error;
    }
    unlinkSync(moved);
    return 'replaced';
  } finally {
    discardStagedWrite(staged);
  }
}

function claimSnapshotStillMatches(
  moved: string,
  inspected: ClaimSnapshot,
): boolean {
  if (inspected.identity === undefined) return false;
  let currentIdentity: ClaimFileIdentity;
  try {
    currentIdentity = claimFileIdentity(moved);
  } catch {
    return false;
  }
  if (!sameClaimIdentity(currentIdentity, inspected.identity)) return false;
  if (inspected.bytes === undefined) return true;
  try {
    return readFileSync(moved).equals(inspected.bytes);
  } catch {
    return false;
  }
}

function claimFileIdentity(path: string): ClaimFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sameClaimIdentity(
  left: ClaimFileIdentity,
  right: ClaimFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function moveClaimToStaging(
  mainRoot: string,
  target: string,
): string | undefined {
  const moved = uniqueStagingPath(mainRoot, target);
  try {
    renameSync(target, moved);
    return moved;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function restoreClaim(moved: string, target: string): boolean {
  try {
    linkSync(moved, target);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    unlinkSync(moved);
    return false;
  }
  unlinkSync(moved);
  return true;
}

function heldClaimError(inspection: ClaimInspection): TaskCommandError {
  return new TaskCommandError(
    `task is held by ${claimHolder(inspection)}${inspection.findings.length > 0 ? `; claim findings: ${inspection.findings.join('; ')}` : ''}`,
    75,
  );
}

function claimChangedError(action: string): TaskCommandError {
  return new TaskCommandError(`task claim changed ${action}`, 75);
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
