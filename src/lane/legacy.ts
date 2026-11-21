// The reads that find the lane of a session started before manifests existed (ADR 0029 decision 2, legacy
// rule): its transcript names the worktree it edited and the task ids it works, and the raw task claim names
// the branch. `src/lane/session.ts` asks this module only while a session has no manifest; it goes with the
// last manifestless lane (ADR 0029 migration step 7).
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { inspectClaim, type TaskClaim } from '../task/claims.ts';

const TASK_ID = /(?<![a-z0-9])t-[a-z0-9]{7}(?![a-z0-9])/gu;

/** The claim of a task unless the claim reader finds it expired; a file it cannot fully parse still names its lane. */
function heldClaim(main: string, id: string): Partial<TaskClaim> | undefined {
  const inspected = inspectClaim(main, id);
  return inspected.state === 'expired' ? undefined : inspected.claim;
}

function transcriptOf(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function editedPattern(main: string): RegExp {
  const marker = join(main, '.krn', 'worktrees') + sep;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `"(?:file_path|notebook_path)"\\s*:\\s*"${escaped}([^/"]+)`,
    'gu',
  );
}

/** The worktree a lane subagent's transcript last edited a file in, else the worktree of the first live claim it names. */
export function legacyLaneWorktree(
  main: string,
  payload: unknown,
): string | undefined {
  const text = transcriptOf(
    (payload as { agent_transcript_path?: unknown } | null)
      ?.agent_transcript_path,
  );
  if (text === undefined) return undefined;
  const marker = join(main, '.krn', 'worktrees');
  const edited = [...text.matchAll(editedPattern(main))].at(-1)?.[1];
  if (edited !== undefined && existsSync(join(marker, edited)))
    return join(marker, edited);
  for (const id of text.match(TASK_ID) ?? []) {
    try {
      const claim = heldClaim(main, id);
      if (typeof claim?.worktree === 'string' && existsSync(claim.worktree))
        return claim.worktree;
    } catch {
      /* No claim for this id. */
    }
  }
  return undefined;
}

/** The worktrees under `<main>/.krn/worktrees` that a lane subagent's transcript edited a file in. */
export function legacyEditedWorktrees(
  main: string,
  payload: unknown,
): string[] {
  const text = transcriptOf(
    (payload as { agent_transcript_path?: unknown } | null)
      ?.agent_transcript_path,
  );
  if (text === undefined) return [];
  const marker = join(main, '.krn', 'worktrees');
  const names = [...text.matchAll(editedPattern(main))].map(
    (match) => match[1] as string,
  );
  return [...new Set(names)]
    .filter((name) => existsSync(join(marker, name)))
    .map((name) => join(marker, name));
}

/** The task ids a legacy session names: KRN_TASK and the ids in its transcript (a lane subagent's own first). */
export function legacyTaskIds(
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string[] {
  const ids = new Set<string>();
  if (env.KRN_TASK) ids.add(env.KRN_TASK);
  const fields = payload as {
    transcript_path?: unknown;
    agent_transcript_path?: unknown;
  } | null;
  const own = fields?.agent_transcript_path;
  const text = transcriptOf(
    typeof own === 'string' ? own : fields?.transcript_path,
  );
  for (const id of text?.match(TASK_ID) ?? []) ids.add(id);
  return [...ids];
}

/** The branch and worktree of the live claim each task id holds. */
export function legacyClaims(
  main: string,
  ids: readonly string[],
): { branch: string; worktree?: string }[] {
  const records: { branch: string; worktree?: string }[] = [];
  for (const id of ids) {
    try {
      const claim = heldClaim(main, id);
      if (typeof claim?.branch === 'string' && claim.branch !== '')
        records.push({
          branch: claim.branch,
          ...(typeof claim.worktree === 'string' && claim.worktree !== ''
            ? { worktree: claim.worktree }
            : {}),
        });
    } catch {
      /* No claim for this id. */
    }
  }
  return records;
}
