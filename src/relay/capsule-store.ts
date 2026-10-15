// Capsule files keep the hook-readable ABI intact and serialize epoch compare-and-swap writes. ADR 0001.
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Job } from '../core/index.ts';
import { ensureProjectionDirectory, stateDirectory } from '../foreman/state.ts';
import type { Contract } from '../ledger/index.ts';

const MAX_PROJECTION_TOKENS = 2000;
const MAX_CAPSULE_DECISIONS = 64;

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

const labels = [
  'Outcome and observable acceptance',
  'Current workflow owner and sole writer',
  'Outcome state',
  'Publication state',
  'Repository base, HEAD or working-tree fingerprint, and dirty-state scope',
  'Native Goal identity/state and configured tracker item/state',
  'Restart state',
  'Outstanding workflow-run cleanup',
  'Authority',
  'Evidence observed',
  'Explicit non-proofs',
  'Review fixed point and Standards / Spec disposition',
  'Open unknowns and blockers with owners',
  'Workflow friction and lesson candidates',
  'Durable CONTEXT / ADR / research references',
  'Next bounded owner and action',
] as const;

const decisionSchema = z.object({
  date: z.string().min(1),
  source: z.string().min(1),
  text: z.string().min(1),
});
const capsuleSchema = z.object({
  jobId: z.string().min(1),
  issue: z.string().min(1),
  contractRevision: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  base: z.string().min(1),
  head: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  nextAction: z.string().min(1),
  lease: z.enum(['active', 'checkpointed', 'ended']).default('ended'),
  blockers: z.array(z.string()),
  decisions: z.array(decisionSchema),
  rejectedApproaches: z.array(z.string()),
  references: z.array(z.string()),
  sessionId: z.string().optional(),
  pendingCheckpoint: z
    .object({
      intent: z
        .string()
        .max(32)
        .regex(/^intent:\d+$/),
      parent: z.string().regex(/^[a-f0-9]{40,64}$/),
      sha: z.string().regex(/^[a-f0-9]{40,64}$/),
      epoch: z.number().int().nonnegative(),
    })
    .optional(),
});

export type Capsule = z.infer<typeof capsuleSchema>;
export type RepoFacts = {
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
  readonly dirtyPaths?: readonly string[];
};
export type SessionEnd = {
  readonly reasonKind: string;
  readonly claimsDone: boolean;
  readonly dirtyPaths?: readonly string[];
};
export type Cas<T> =
  | { readonly applied: true; readonly value: T }
  | { readonly applied: false };

export function parseCapsule(input: unknown): Capsule {
  return capsuleSchema.parse(input);
}

function capsulePath(job: Job): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid capsule job id');
  return join(ensureProjectionDirectory(job), 'state.md');
}

function authoritativePath(job: Job): string {
  return join(stateDirectory(job), 'capsule.json');
}

function renderAbi(capsule: Capsule, expectedEpoch: number | null): string {
  const values = [
    `issue=${JSON.stringify(capsule.issue)}; contractRevision=${JSON.stringify(capsule.contractRevision)}`,
    `relay; job=${capsule.jobId}; epoch=${capsule.epoch}`,
    'ACTIVE',
    'LOCAL_ONLY',
    `base=${capsule.base}; HEAD=${capsule.head}; branch=${capsule.branch}; worktree=${capsule.worktree}`,
    'none',
    'ABSENT',
    `[.krn/runs/foreman/${capsule.jobId}; foreman; $foreman; closes with capsule; ACTIVE]`,
    `capsule CAS expectedEpoch=${expectedEpoch === null ? 'empty' : expectedEpoch}`,
    `session=${JSON.stringify(capsule.sessionId ?? '')}; lease=${capsule.lease}`,
    'no transcript or memory-event writes',
    `decisions=${JSON.stringify(capsule.decisions)}; rejectedApproaches=${JSON.stringify(capsule.rejectedApproaches)}`,
    JSON.stringify(capsule.blockers),
    'none',
    JSON.stringify(capsule.references),
    capsule.nextAction,
  ];
  if (values.some((value) => /[\r\n]/.test(value)))
    throw new Error('capsule ABI values must be single-line');
  const text = labels
    .map((label, index) => `${label}: ${values[index]}`)
    .join('\n');
  const projection = `${text}\n`;
  if (approximateTokenCount(projection) > MAX_PROJECTION_TOKENS)
    throw new Error('capsule exceeds the 2k-token projection budget');
  return projection;
}

function writeProjection(job: Job, content: string): void {
  const projection = capsulePath(job);
  const directory = ensureProjectionDirectory(job);
  if (realpathSync(directory) !== directory)
    throw new Error('unsafe projection directory');
  const temporary = `${projection}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, projection);
}

export function projectCapsule(job: Job, capsule: Capsule): void {
  writeProjection(job, renderAbi(capsule, null));
}

function acquireLock(path: string): number | null {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let stale = false;
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } else {
      stale = Date.now() - statSync(path).mtimeMs > 5000;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return acquireLock(path);
    throw error;
  }
  if (!stale) return null;
  unlinkSync(path);
  return acquireLock(path);
}

export function readCapsule(job: Job): Capsule | null {
  try {
    return capsuleSchema.parse(
      JSON.parse(readFileSync(authoritativePath(job), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// The exact same admission check is used for preflight and actual CAS writes.
export function capsuleWriteRefusal(capsule: Capsule): string | null {
  if (capsule.decisions.length > MAX_CAPSULE_DECISIONS)
    return 'capsule exceeds the 64-decision history bound';
  try {
    renderAbi(capsule, null);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'capsule ABI values must be single-line' ||
        error.message === 'capsule exceeds the 2k-token projection budget')
    )
      return error.message;
    throw error;
  }
  return null;
}

export function writeCapsule(
  job: Job,
  input: unknown,
  expectedEpoch: number | null,
): Promise<Cas<Capsule>> {
  const capsule = capsuleSchema.parse(input);
  if (capsule.jobId !== job.id || capsule.worktree !== job.worktree)
    throw new Error('capsule does not belong to this job');
  // Bound new writes while keeping the reader able to load older capsules.
  if (capsuleWriteRefusal(capsule)) return Promise.resolve({ applied: false });
  const path = authoritativePath(job);
  const lock = `${path}.lock`;
  mkdirSync(stateDirectory(job), { recursive: true, mode: 0o700 });
  const lockFd = acquireLock(lock);
  if (lockFd === null) return Promise.resolve({ applied: false });
  try {
    const current = readCapsule(job);
    if (
      (current?.epoch ?? null) !== expectedEpoch ||
      capsule.epoch !== (expectedEpoch === null ? 0 : expectedEpoch + 1)
    )
      return Promise.resolve({ applied: false });
    const projection = renderAbi(capsule, null);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(capsule));
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    writeProjection(job, projection);
    return Promise.resolve({ applied: true, value: capsule });
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

export function renderProjection(
  capsule: Capsule,
  facts: RepoFacts,
  contract: Contract,
): string {
  const capsuleProjection = renderAbi({ ...capsule, ...facts }, null);
  const sectionStart = [
    'Task contract:',
    `Identifier: ${contract.identifier}`,
    `Title: ${contract.title}`,
    'Description:',
  ].join('\n');
  const sectionEnd = [
    '',
    `Checks: ${contract.checks.join(', ')}`,
    'This contract is your task source; do not look for tasks elsewhere.',
  ].join('\n');
  const separator = '\n';
  const fullProjection = `${capsuleProjection}${separator}${sectionStart}\n${contract.description}${sectionEnd}\n`;
  if (approximateTokenCount(fullProjection) <= MAX_PROJECTION_TOKENS)
    return fullProjection;

  const marker =
    '\n[description truncated to fit the 2k-token projection budget]';
  const fixedLength =
    capsuleProjection.length +
    separator.length +
    sectionStart.length +
    1 +
    marker.length +
    sectionEnd.length +
    1;
  const descriptionLength = MAX_PROJECTION_TOKENS * 4 - fixedLength;
  if (descriptionLength < 0)
    throw new Error(
      'task contract metadata exceeds the 2k-token projection budget',
    );
  const truncated = `${capsuleProjection}${separator}${sectionStart}\n${contract.description.slice(0, descriptionLength)}${marker}${sectionEnd}\n`;
  if (approximateTokenCount(truncated) > MAX_PROJECTION_TOKENS)
    throw new Error('task contract projection exceeds the 2k-token budget');
  return truncated;
}
