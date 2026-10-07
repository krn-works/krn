// Capsule files keep the hook-readable ABI intact and serialize epoch compare-and-swap writes. ADR 0001.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { Job } from '../core/index.ts';

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
});

export type Capsule = z.infer<typeof capsuleSchema>;
export type RepoFacts = {
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
};
export type SessionEnd = {
  readonly reasonKind: string;
  readonly claimsDone: boolean;
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
  return join(
    job.worktree,
    '.krn',
    'runs',
    'delivery-loop',
    job.id,
    'state.md',
  );
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
    'none',
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
  if (text.length > 8000)
    throw new Error('capsule exceeds the 2k-token projection budget');
  return `${text}\n`;
}

function parseAbi(text: string): Capsule {
  const fields = new Map<string, string>();
  for (const label of labels) {
    const line = text
      .split('\n')
      .find((entry) => entry.startsWith(`${label}:`));
    if (!line) throw new Error(`capsule ABI field missing: ${label}`);
    fields.set(label, line.slice(label.length + 1).trim());
  }
  const identity = /^issue=(.+); contractRevision=(.+)$/.exec(
    fields.get(labels[0]) ?? '',
  );
  const owner = /^relay; job=([^;]+); epoch=(\d+)$/.exec(
    fields.get(labels[1]) ?? '',
  );
  const anchors =
    /^base=([^;]+); HEAD=([^;]+); branch=([^;]+); worktree=(.+)$/.exec(
      fields.get(labels[4]) ?? '',
    );
  if (!identity || !owner || !anchors)
    throw new Error('capsule ABI identity or repository anchors are malformed');
  const session = /^session=(.*); lease=(active|checkpointed|ended)$/.exec(
    fields.get(labels[9]) ?? '',
  );
  const decisions = /^decisions=(\[.*\]); rejectedApproaches=(\[.*\])$/.exec(
    fields.get(labels[11]) ?? '',
  );
  try {
    const sessionId: unknown = JSON.parse(session?.[1] ?? '""');
    return capsuleSchema.parse({
      jobId: owner[1],
      issue: JSON.parse(identity[1] ?? ''),
      contractRevision: JSON.parse(identity[2] ?? ''),
      epoch: Number(owner[2]),
      base: anchors[1],
      head: anchors[2],
      branch: anchors[3],
      worktree: anchors[4],
      nextAction: fields.get(labels[15]),
      lease: session?.[2] ?? 'ended',
      blockers: JSON.parse(fields.get(labels[12]) ?? '[]'),
      decisions: JSON.parse(decisions?.[1] ?? '[]'),
      rejectedApproaches: JSON.parse(decisions?.[2] ?? '[]'),
      references: JSON.parse(fields.get(labels[14]) ?? '[]'),
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new Error('capsule ABI data is malformed');
  }
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
    return parseAbi(readFileSync(capsulePath(job), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeCapsule(
  job: Job,
  input: unknown,
  expectedEpoch: number | null,
): Promise<Cas<Capsule>> {
  const capsule = capsuleSchema.parse(input);
  if (capsule.jobId !== job.id || capsule.worktree !== job.worktree)
    throw new Error('capsule does not belong to this job');
  const path = capsulePath(job);
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const lockFd = acquireLock(lock);
  if (lockFd === null) return Promise.resolve({ applied: false });
  try {
    const current = readCapsule(job);
    if (
      (current?.epoch ?? null) !== expectedEpoch ||
      capsule.epoch !== (expectedEpoch === null ? 0 : expectedEpoch + 1)
    )
      return Promise.resolve({ applied: false });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, renderAbi(capsule, expectedEpoch), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
    return Promise.resolve({ applied: true, value: capsule });
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

export function renderProjection(capsule: Capsule, facts: RepoFacts): string {
  const projection = renderAbi({ ...capsule, ...facts }, null);
  if (projection.length > 2000)
    throw new Error('capsule projection exceeds the 2k-token budget');
  return projection;
}
