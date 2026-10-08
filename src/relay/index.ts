// Relay validates and advances the hook-readable continuation capsule. ADR 0001.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Job } from '../core/index.ts';
import {
  type Capsule,
  type Cas,
  parseCapsule,
  type RepoFacts,
  readCapsule,
  renderProjection,
  type SessionEnd,
  writeCapsule as storeCapsule,
} from './capsule-store.ts';

export type { Capsule, Cas, RepoFacts, SessionEnd } from './capsule-store.ts';
export type Validation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function writeCapsule(
  job: Job,
  capsule: unknown,
  expectedEpoch: number | null,
): Promise<Cas<Capsule>> {
  return storeCapsule(job, capsule, expectedEpoch);
}

export async function load(
  job: Job,
  contract: { readonly revision: string },
): Promise<Capsule> {
  const current = readCapsule(job);
  if (current) {
    if (current.jobId !== job.id || current.worktree !== job.worktree)
      throw new Error('capsule belongs to a different job');
    if (current.contractRevision !== contract.revision)
      throw new Error('capsule contract revision is stale');
    return current;
  }
  const initial = parseCapsule({
    jobId: job.id,
    issue: job.issue,
    contractRevision: contract.revision,
    epoch: 0,
    ...repoFacts(job),
    nextAction: 'read the current task contract',
    lease: 'ended',
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: repoReferences(job),
  });
  const result = await storeCapsule(job, initial, null);
  return result.applied ? initial : load(job, contract);
}

export function repoReferences(job: Job): string[] {
  const root = job.worktree;
  const references = ['AGENTS.md', 'CONTEXT.md'].filter((path) => {
    const candidate = join(root, path);
    return existsSync(candidate) && statSync(candidate).isFile();
  });
  const adrDirectory = join(root, 'docs', 'adr');
  if (existsSync(adrDirectory) && statSync(adrDirectory).isDirectory()) {
    references.push(
      ...readdirSync(adrDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `docs/adr/${entry.name}`)
        .sort(),
    );
  }
  return references;
}

export function repoFacts(job: Job): RepoFacts {
  const result = spawnSync(
    'git',
    [
      '-C',
      job.worktree,
      'rev-parse',
      '--show-toplevel',
      'HEAD',
      '--abbrev-ref',
      'HEAD',
    ],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0)
    throw (
      result.error ??
      new Error(result.stderr || 'unable to read repository anchors')
    );
  const [root, head, branch] = result.stdout.trim().split('\n');
  const anchors = z
    .object({
      root: z.string().min(1),
      head: z.string().regex(/^[0-9a-f]{40,64}$/i),
      branch: z.string().min(1),
    })
    .parse({ root, head, branch });
  const baseResult = spawnSync(
    'git',
    ['-C', job.worktree, 'merge-base', 'HEAD', 'main'],
    { encoding: 'utf8' },
  );
  if (baseResult.error || baseResult.status !== 0)
    throw (
      baseResult.error ??
      new Error(baseResult.stderr || 'unable to read repository base')
    );
  const base = z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .parse(baseResult.stdout.trim());
  return {
    base,
    head: anchors.head,
    branch: anchors.branch,
    worktree: job.worktree,
  };
}

export function validate(capsule: Capsule, facts: RepoFacts): Validation {
  const reasons = [
    ...(capsule.worktree === facts.worktree ? [] : ['worktree changed']),
    ...(capsule.branch === facts.branch ? [] : ['branch changed']),
    ...(capsule.head === facts.head ? [] : ['HEAD changed']),
  ];
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function project(capsule: Capsule, facts: RepoFacts): string {
  return renderProjection(capsule, facts);
}

export async function isCurrent(
  job: Job,
  epoch: number,
  sessionId: string,
): Promise<boolean> {
  try {
    const capsule = readCapsule(job);
    return (
      capsule?.jobId === job.id &&
      capsule.epoch === epoch &&
      capsule.sessionId === sessionId
    );
  } catch {
    return false;
  }
}

export async function bindSession(
  job: Job,
  capsule: Capsule,
  sessionId: string,
): Promise<Cas<Capsule>> {
  if (capsule.sessionId && capsule.lease !== 'checkpointed')
    return { applied: false };
  const next = parseCapsule({
    ...capsule,
    epoch: capsule.epoch + 1,
    lease: 'active',
    sessionId,
  });
  return storeCapsule(job, next, capsule.epoch);
}

export async function refreshCAS(
  capsule: Capsule,
  facts: RepoFacts,
  end: SessionEnd,
): Promise<Cas<Capsule>> {
  const next = parseCapsule({
    ...capsule,
    ...facts,
    epoch: capsule.epoch + 1,
    nextAction: end.claimsDone
      ? 'verify the reported completion'
      : `resume after session ended (${end.reasonKind})`,
    lease: 'ended',
    sessionId: undefined,
  });
  return storeCapsule(
    { id: capsule.jobId, issue: capsule.issue, worktree: capsule.worktree },
    next,
    capsule.epoch,
  );
}

export async function checkpoint(
  job: Job,
  sessionId: string,
  message: string,
  nextAction: string,
  decision?: string,
): Promise<Capsule> {
  const current = readCapsule(job);
  if (!current) throw new Error('cannot checkpoint without a relay capsule');
  const next = parseCapsule({
    ...current,
    epoch: current.epoch + 1,
    nextAction,
    lease: 'checkpointed',
    decisions: [
      ...current.decisions,
      {
        date: new Date().toISOString(),
        source: sessionId,
        text: `commit request: ${message}`,
      },
      ...(decision === undefined
        ? []
        : [
            {
              date: new Date().toISOString(),
              source: sessionId,
              text: decision,
            },
          ]),
    ],
    sessionId,
  });
  const saved = await storeCapsule(job, next, current.epoch);
  if (!saved.applied) throw new Error('checkpoint capsule CAS conflict');
  return next;
}

export async function recordCommit(
  job: Job,
  sessionId: string,
  sha: string,
  message: string,
): Promise<Capsule> {
  const current = readCapsule(job);
  if (current?.sessionId !== sessionId || current.lease !== 'checkpointed')
    throw new Error('commit session is not bound to the checkpointed capsule');
  const facts = repoFacts(job);
  const next = parseCapsule({
    ...current,
    ...facts,
    epoch: current.epoch + 1,
    decisions: [
      ...current.decisions,
      {
        date: new Date().toISOString(),
        source: sessionId,
        text: `foreman commit ${sha}: ${message}`,
      },
    ],
  });
  const saved = await storeCapsule(job, next, current.epoch);
  if (!saved.applied) throw new Error('commit capsule CAS conflict');
  return next;
}

export async function withFindingsCAS(
  capsule: Capsule,
  findings: readonly string[],
): Promise<Cas<Capsule>> {
  const next = parseCapsule({
    ...capsule,
    epoch: capsule.epoch + 1,
    blockers: [...findings],
  });
  return storeCapsule(
    { id: capsule.jobId, issue: capsule.issue, worktree: capsule.worktree },
    next,
    capsule.epoch,
  );
}
