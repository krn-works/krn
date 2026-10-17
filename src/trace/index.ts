// Trace is append-only so a resumed worker can distinguish durable checkpoints. ADR 0001.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { readCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { repoRecord, stateDirectory } from '../foreman/state.ts';
import type { SessionEnd } from '../foreman/types.ts';
import {
  codexScopeUnit,
  type SystemdScopeRegistration,
  validateSystemdScopeRegistration,
} from '../hosts/systemd-scope.ts';
import type { SubmissionReceipt } from '../ledger/index.ts';
import type { VerdictEvent } from '../verdict/index.ts';

type Event = {
  readonly key: string;
  readonly kind: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
};

type TraceFdPathVerification = 'verified' | 'unavailable' | 'mismatch';

export function classifyTraceFdPathReadback(
  actualPath: string | undefined,
  errorCode: string | undefined,
  expectedPath: string,
): TraceFdPathVerification {
  if (actualPath === expectedPath) return 'verified';
  if (
    actualPath === undefined &&
    (errorCode === 'ENOENT' || errorCode === 'ENOTDIR')
  )
    return 'unavailable';
  return 'mismatch';
}

export function traceFdPathVerificationDecision(
  verification: TraceFdPathVerification,
): 'ok' | 'refusal' {
  return verification === 'verified' ? 'ok' : 'refusal';
}

const eventSchema = z.object({
  key: z.string(),
  kind: z.string(),
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const verdictDataSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  checks: z.array(
    z.object({
      id: z.string(),
      exitCode: z.number().int(),
      durationMs: z.number().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    }),
  ),
});

function file(job: Job): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid trace job id');
  return join(stateDirectory(job), 'trace.jsonl');
}

function parseEvent(line: string): Event {
  const value: unknown = JSON.parse(line);
  return eventSchema.parse(value);
}

function writeAllSync(fd: number, value: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written < 1) throw new Error('trace write made no progress');
    offset += written;
  }
}

function assertNoTraceSymlinks(directory: string, path: string): void {
  const relativePath = relative(directory, path);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error('unsafe trace path');

  const assertNotSymlink = (componentPath: string): void => {
    try {
      if (lstatSync(componentPath).isSymbolicLink())
        throw new Error('unsafe trace path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const ancestors: string[] = [];
  let ancestor = directory;
  while (true) {
    ancestors.unshift(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const componentPath of ancestors) assertNotSymlink(componentPath);

  let current = directory;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    assertNotSymlink(current);
  }
}

function isWithinOrSame(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function nearestExistingRealpath(path: string): string {
  let current = resolve(path);
  while (true) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('unsafe trace path');
      const parent = dirname(current);
      if (parent === current) throw new Error('unsafe trace path');
      current = parent;
      continue;
    }
    try {
      return realpathSync(current);
    } catch {
      throw new Error('unsafe trace path');
    }
  }
}

function ensureTraceDirectory(
  job: Job,
  directory: string,
  create: boolean,
): boolean {
  const repoRoot = realpathSync(repoRecord(job).repoRoot);
  const expectedDirectory = resolve(directory);
  if (
    expectedDirectory === repoRoot ||
    !isWithinOrSame(repoRoot, expectedDirectory)
  )
    throw new Error('unsafe trace path');

  const nearest = nearestExistingRealpath(expectedDirectory);
  if (!isWithinOrSame(repoRoot, nearest)) throw new Error('unsafe trace path');
  assertNoTraceSymlinks(repoRoot, expectedDirectory);

  const createdDirectories: Array<{
    path: string;
    dev?: number;
    ino?: number;
  }> = [];
  try {
    if (create) {
      let current = repoRoot;
      for (const component of relative(repoRoot, expectedDirectory).split(
        sep,
      )) {
        current = join(current, component);
        let createdDirectory:
          | { path: string; dev?: number; ino?: number }
          | undefined;
        try {
          lstatSync(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('unsafe trace path');
          try {
            mkdirSync(current, { mode: 0o700 });
            createdDirectory = { path: current };
            createdDirectories.push(createdDirectory);
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST')
              throw new Error('unsafe trace path');
          }
        }

        let stats: ReturnType<typeof lstatSync>;
        try {
          stats = lstatSync(current);
        } catch {
          throw new Error('unsafe trace path');
        }
        if (
          createdDirectory &&
          stats.isDirectory() &&
          !stats.isSymbolicLink()
        ) {
          createdDirectory.dev = stats.dev;
          createdDirectory.ino = stats.ino;
        }
        if (stats.isSymbolicLink() || !stats.isDirectory())
          throw new Error('unsafe trace path');
      }
    } else {
      try {
        lstatSync(expectedDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new Error('unsafe trace path');
      }
    }

    let actualDirectory: string;
    try {
      actualDirectory = realpathSync(expectedDirectory);
    } catch {
      throw new Error('unsafe trace path');
    }
    if (actualDirectory !== expectedDirectory)
      throw new Error('unsafe trace path');
    assertNoTraceSymlinks(repoRoot, expectedDirectory);
    return true;
  } catch {
    for (const createdDirectory of createdDirectories.reverse()) {
      try {
        const stats = lstatSync(createdDirectory.path);
        if (
          createdDirectory.dev !== undefined &&
          createdDirectory.ino !== undefined &&
          stats.isDirectory() &&
          !stats.isSymbolicLink() &&
          stats.dev === createdDirectory.dev &&
          stats.ino === createdDirectory.ino
        )
          rmdirSync(createdDirectory.path);
      } catch {
        // Only empty directories created by this invocation are removed.
      }
    }
    throw new Error('unsafe trace path');
  }
}

function assertTraceFileIsRegularIfPresent(path: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isFile() || stats.nlink !== 1)
    throw new Error('unsafe trace path');
}

function openTraceFile(path: string, flags: number, mode?: number): number {
  assertTraceFileIsRegularIfPresent(path);
  try {
    return openSync(
      path,
      flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      mode,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('unsafe trace path');
    throw error;
  }
}

function openVerifiedTrace(path: string, flags: number, mode?: number): number {
  let fd: number;
  let createdByOpen = false;
  if ((flags & constants.O_CREAT) !== 0) {
    try {
      fd = openTraceFile(path, flags | constants.O_EXCL, mode);
      createdByOpen = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      fd = openTraceFile(path, flags & ~constants.O_CREAT, mode);
    }
  } else {
    fd = openTraceFile(path, flags);
  }

  let actualPath: string | undefined;
  let readbackErrorCode: string | undefined;
  try {
    actualPath = readlinkSync(`/proc/self/fd/${fd}`);
  } catch (error) {
    readbackErrorCode = (error as NodeJS.ErrnoException).code;
  }
  const pathVerification = classifyTraceFdPathReadback(
    actualPath,
    readbackErrorCode,
    resolve(path),
  );
  if (traceFdPathVerificationDecision(pathVerification) === 'refusal') {
    let cleanupPath: string | undefined;
    let openedStats: ReturnType<typeof fstatSync> | undefined;
    if (createdByOpen && pathVerification === 'mismatch') {
      try {
        openedStats = fstatSync(fd);
        if (openedStats.isFile() && openedStats.size === 0)
          cleanupPath = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        // Keep the refusal even if procfs cannot provide a cleanup path.
      }
    }
    closeSync(fd);
    if (
      cleanupPath !== undefined &&
      cleanupPath !== resolve(path) &&
      openedStats !== undefined
    ) {
      try {
        const currentStats = lstatSync(cleanupPath);
        if (
          currentStats.isFile() &&
          currentStats.size === 0 &&
          currentStats.dev === openedStats.dev &&
          currentStats.ino === openedStats.ino
        )
          unlinkSync(cleanupPath);
      } catch {
        // The path is still rejected if cleanup is no longer possible.
      }
    }
    throw new Error('unsafe trace path');
  }
  const openedStats = fstatSync(fd);
  if (!openedStats.isFile() || openedStats.nlink !== 1) {
    closeSync(fd);
    throw new Error('unsafe trace path');
  }
  return fd;
}

function events(job: Job): Event[] {
  const path = file(job);
  const directory = dirname(path);
  if (!ensureTraceDirectory(job, directory, false)) return [];
  assertNoTraceSymlinks(directory, path);
  if (!existsSync(path)) return [];
  let contents: Buffer;
  try {
    const fd = openVerifiedTrace(path, constants.O_RDONLY);
    try {
      contents = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const terminated =
    contents.length === 0 || contents[contents.length - 1] === 0x0a;
  const lastNewline = contents.lastIndexOf(0x0a);
  const completeLength = terminated ? contents.length - 1 : lastNewline + 1;
  const result = contents
    .subarray(0, completeLength)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseEvent);
  if (terminated || contents.length === 0) return result;

  const tail = contents.subarray(completeLength).toString('utf8');
  let finalEvent: Event;
  try {
    finalEvent = parseEvent(tail);
  } catch {
    const fd = openVerifiedTrace(path, constants.O_RDWR);
    try {
      ftruncateSync(fd, completeLength);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.warn('krn trace: discarded torn final trace line');
    return result;
  }

  const fd = openVerifiedTrace(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    writeAllSync(fd, '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  result.push(finalEvent);
  return result;
}

function append(
  job: Job,
  key: string,
  kind: string,
  data: Record<string, unknown>,
): boolean {
  const path = file(job);
  const directory = dirname(path);
  ensureTraceDirectory(job, directory, true);
  assertNoTraceSymlinks(directory, path);
  const prior = events(job).find((event) => event.key === key);
  if (prior) return false;
  assertNoTraceSymlinks(directory, path);
  const fd = openVerifiedTrace(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error('unsafe trace path');
    writeAllSync(
      fd,
      `${JSON.stringify({ id: randomUUID(), key, kind, at: new Date().toISOString(), data })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

export async function intent(job: Job, epoch: number): Promise<string> {
  const key = `intent:${epoch}`;
  append(job, key, 'intent', { jobId: job.id, epoch });
  return key;
}

export async function started(
  job: Job,
  intentId: string,
  sessionId: string,
  pgid?: number,
  isolation?: 'pid_namespace' | 'systemd_scope',
  registration?: SystemdScopeRegistration,
): Promise<boolean> {
  let expectedUnit: string | undefined;
  let scopeRegistration: SystemdScopeRegistration | undefined;
  if (isolation === 'systemd_scope') {
    try {
      expectedUnit = codexScopeUnit(job.id, sessionId);
    } catch {
      throw new Error('invalid Codex scope registration identity');
    }
    scopeRegistration = validateSystemdScopeRegistration(
      registration,
      expectedUnit,
    );
    if (!scopeRegistration)
      throw new Error('systemd scope registration witness is invalid');
  } else if (registration !== undefined) {
    throw new Error(
      'systemd scope registration has no matching isolation mode',
    );
  }
  // Session starts are unique by opaque host identity, while the intent key fences retries.
  const prior = events(job).find(
    (event) => event.key === `${intentId}:session`,
  );
  if (prior) {
    if (prior.data.sessionId !== sessionId) return false;
    if (scopeRegistration) {
      const previous = validateSystemdScopeRegistration(
        prior.data.scopeRegistration,
        expectedUnit ?? '',
      );
      return (
        prior.data.jobId === job.id &&
        prior.data.isolation === 'systemd_scope' &&
        previous !== undefined &&
        previous.controlGroup === scopeRegistration.controlGroup &&
        previous.pid === scopeRegistration.pid &&
        previous.startTicks === scopeRegistration.startTicks
      );
    }
    return true;
  }
  append(job, `${intentId}:session`, 'session_started', {
    intent: intentId,
    jobId: job.id,
    sessionId,
    ...(pgid === undefined ? {} : { pgid }),
    sandbox: 'workspace-write',
    isolation: isolation ?? 'unknown',
    ...(scopeRegistration === undefined ? {} : { scopeRegistration }),
  });
  return true;
}

export async function checkpoint(
  job: Job,
  intentId: string,
  sessionId: string,
  message: string,
  next: string,
  _decision?: string,
): Promise<void> {
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message || request.next !== next)
    throw new Error('checkpoint request is missing or stale');
  append(job, `${intentId}:checkpoint:${sessionId}`, 'checkpoint', {
    intent: intentId,
    sessionId,
    message,
    next,
    ...(request.decision === undefined ? {} : { decision: request.decision }),
  });
}

export async function checkpointRequest(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<{
  readonly message: string;
  readonly next: string;
  readonly decision?: string;
} | null> {
  const trace = events(job);
  const started = trace.find((event) => event.key === `${intentId}:session`);
  if (started?.data.sessionId !== sessionId) return null;
  const request = readCheckpointRequest(job, sessionId);
  return request?.intent === intentId && request.sessionId === sessionId
    ? {
        message: request.message,
        next: request.next,
        ...(request.decision === undefined
          ? {}
          : { decision: request.decision }),
      }
    : null;
}

export async function commit(
  job: Job,
  intentId: string,
  sessionId: string,
  sha: string,
  message: string,
): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(sha))
    throw new Error('commit SHA is malformed');
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message)
    throw new Error('commit does not match the bound checkpoint request');
  const key = `${intentId}:commit:${sessionId}`;
  const prior = events(job).find((event) => event.key === key);
  if (prior) {
    if (prior.data.sha !== sha || prior.data.message !== message)
      throw new Error('commit conflicts with the recorded session commit');
    return;
  }
  append(job, key, 'commit', {
    intent: intentId,
    sessionId,
    sha,
    message,
  });
}

export async function hasCheckpoint(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<boolean> {
  return (await checkpointRequest(job, intentId, sessionId)) !== null;
}

export async function sessionEnd(
  job: Job,
  sessionId: string,
): Promise<SessionEnd | null> {
  const trace = events(job);
  const value = trace.find(
    (event) =>
      event.kind === 'session_ended' && event.data.sessionId === sessionId,
  )?.data.end;
  const parsed = z
    .object({ reasonKind: z.string(), claimsDone: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return null;
  const completed = trace.some(
    (event) =>
      event.kind === 'checkpoint' &&
      event.data.sessionId === sessionId &&
      event.data.next === 'done',
  );
  return { ...parsed.data, claimsDone: completed };
}

export async function sessionScopeRegistration(
  job: Job,
  sessionId: string,
): Promise<SystemdScopeRegistration | null> {
  const started = events(job).find(
    (event) =>
      event.kind === 'session_started' &&
      event.data.jobId === job.id &&
      event.data.sessionId === sessionId,
  );
  if (started?.data.isolation !== 'systemd_scope') return null;
  let expectedUnit: string;
  try {
    expectedUnit = codexScopeUnit(job.id, sessionId);
  } catch {
    return null;
  }
  return (
    validateSystemdScopeRegistration(
      started.data.scopeRegistration,
      expectedUnit,
    ) ?? null
  );
}

export async function sessionLost(
  job: Job,
  sessionId: string,
  dirtyPaths: readonly string[],
): Promise<void> {
  append(job, `session-lost:${sessionId}`, 'session_lost', {
    sessionId,
    dirtyPaths,
  });
}

export async function log(
  job: Job,
  intentId: string,
  sessionId: string,
  event: 'session_ended',
  end: SessionEnd,
): Promise<void> {
  append(job, `${intentId}:ended:${sessionId}`, event, {
    intent: intentId,
    sessionId,
    end: {
      exitCode: end.exitCode,
      signal: end.signal,
      threadId: end.threadId,
      usage: end.usage,
      reasonKind: end.reasonKind,
      reasonSha256: end.reasonSha256,
      reasonLength: end.reasonLength,
      claimsDone: end.claimsDone,
    },
  });
}

export async function failure(
  job: Job,
  intentId: string,
  error: unknown,
): Promise<void> {
  append(job, `${intentId}:failure`, 'failure', {
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

export async function verdict(job: Job, event: VerdictEvent): Promise<void> {
  const data = {
    sha: event.sha,
    checks: event.checks.map(({ id, exitCode, durationMs, sha256 }) => ({
      id,
      exitCode,
      durationMs,
      sha256,
    })),
  };
  const resultHash = createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
  append(job, `verdict:${event.sha}:${resultHash}`, 'verdict', data);
}

export async function hasVerdict(job: Job, sha: string): Promise<boolean> {
  return events(job).some((event) => {
    if (event.kind !== 'verdict') return false;
    const parsed = verdictDataSchema.parse(event.data);
    return (
      parsed.sha === sha && parsed.checks.every((check) => check.exitCode === 0)
    );
  });
}

export async function submitIntent(
  job: Job,
  sha: string,
  contractRevision: string,
): Promise<boolean> {
  const priorForSha = events(job).some(
    (event) => event.kind === 'submit_intent' && event.data.sha === sha,
  );
  const key = `submit-intent:${sha}:${contractRevision}`;
  const created = append(job, key, 'submit_intent', { sha, contractRevision });
  return priorForSha || !created;
}

export async function submittedFor(
  job: Job,
  sha: string,
): Promise<SubmissionReceipt | null> {
  const event = events(job).find(
    (candidate) => candidate.kind === 'submitted' && candidate.data.sha === sha,
  );
  if (!event) return null;
  const parsed = z
    .object({
      issueId: z.string().min(1),
      status: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .safeParse(event.data.receipt);
  return parsed.success ? parsed.data : null;
}

export function submitted(
  job: Job,
  sha: string,
  receipt: SubmissionReceipt,
): void {
  append(job, `submitted:${sha}`, 'submitted', { sha, receipt });
}

export async function stopped(job: Job, signal: string): Promise<void> {
  append(job, `stopped:${randomUUID()}`, 'stopped', { signal });
}

export async function teardownUnconfirmed(
  job: Job,
  detail: string,
): Promise<void> {
  append(job, `teardown-unconfirmed:${randomUUID()}`, 'teardown_unconfirmed', {
    detail: detail.slice(0, 1000),
  });
}

export function paperclipUpdateStarted(
  job: Job,
  sha: string,
  kind: 'review' | 'conflict_comment',
): void {
  append(
    job,
    `paperclip-update-started:${randomUUID()}`,
    'paperclip_update_started',
    {
      sha,
      kind,
    },
  );
}

export async function readyForReview(job: Job, sha: string): Promise<void> {
  append(job, `ready-for-review:${sha}`, 'ready_for_review', { sha });
}

export async function operatorStart(job: Job, operator: string): Promise<void> {
  append(job, `operator-start:${randomUUID()}`, 'operator_start', { operator });
}

export async function operatorStop(job: Job, operator: string): Promise<void> {
  append(job, `operator-stop:${randomUUID()}`, 'operator_stop', { operator });
}

const genericCredentialTokenClasses = [
  /[a-z]/u,
  /[A-Z]/u,
  /[0-9]/u,
  /[_+=/-]/u,
] as const;

function isSafeGenericCredentialToken(token: string): boolean {
  if (
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
      token,
    )
  )
    return true;
  return (
    /^[A-Z]{2,}-\d+$/u.test(token) ||
    /^krn-[A-Z]+-\d+(?:-[a-z0-9]+)*$/u.test(token)
  );
}

function containsGenericCredentialToken(note: string): boolean {
  return note.split(/\s+/u).some((token) => {
    if (token.length < 20 || isSafeGenericCredentialToken(token)) return false;
    let characterClasses = 0;
    for (const pattern of genericCredentialTokenClasses) {
      if (pattern.test(token)) characterClasses += 1;
    }
    return characterClasses >= 2;
  });
}

export async function leadIntervention(
  job: Job,
  kind: 'intervention' | 'reconstruction_prompt',
  note: string,
): Promise<void> {
  if (!note || note.length > 200 || /[\r\n]/u.test(note))
    throw new Error(
      'lead intervention note must be a single line of at most 200 characters',
    );
  if (
    /\b(?:(?:sk|rk|pk)_(?:live|test)_|whsec_|sk[-_])/u.test(note) ||
    /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|glpat-)/u.test(note) ||
    /\bgithub_pat_/u.test(note) ||
    /\bxox[baprs]-/u.test(note) ||
    /(?:AKIA|ASIA)[0-9A-Z]{16}/u.test(note) ||
    /AIza[0-9A-Za-z_-]{35}/u.test(note) ||
    /\bBasic\s+[A-Za-z0-9+/=]{16,}/iu.test(note) ||
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u.test(note) ||
    /Bearer\s+\S+/iu.test(note) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(note) ||
    /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/iu.test(note) ||
    containsGenericCredentialToken(note)
  )
    throw new Error('lead intervention note must not contain credentials');
  append(job, `lead-intervention:${randomUUID()}`, 'lead_intervention', {
    kind,
    note,
  });
}
