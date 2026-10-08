// Compose red-first evidence, independent panel sessions, and their bound record.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeRole, ReviewAbortedError } from './panel.ts';
import { writeReviewRecord } from './record.ts';
import {
  redFirst,
  repoRoot,
  resolveCommit,
  validateSha,
} from './repository.ts';
import {
  panelRoles,
  type ReviewRecord,
  type ReviewRole,
  reviewRecordSchema,
  roleSchema,
} from './types.ts';

export async function runReview(input: {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly lens: string;
  readonly panel?: readonly ReviewRole[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seam; the CLI always uses CodexHost's installed executable. */
  readonly codexExecutable?: string;
}): Promise<ReviewRecord> {
  const root = repoRoot(input.repo);
  const sha = validateSha(root, input.head);
  const lens = readFileSync(resolve(input.lens), 'utf8');
  if (!lens.trim()) throw new Error('--lens file is empty');
  if (Buffer.byteLength(lens) > 32 * 1024)
    throw new Error('--lens file exceeds 32 KB');
  const panel = input.panel ?? panelRoles;
  if (!panel.length || new Set(panel).size !== panel.length)
    throw new Error('--panel must contain unique judge roles');
  for (const role of panel) roleSchema.parse(role);
  const base = resolveCommit(root, input.base);
  const red = redFirst(root, base, sha);
  const judges = [];
  for (const role of panel)
    judges.push(
      await judgeRole(
        root,
        sha,
        role,
        lens,
        red.results,
        input.timeoutMs ?? 600000,
        input.codexExecutable,
        input.signal,
      ),
    );
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  if (input.signal?.aborted) throw new ReviewAbortedError();
  const record = reviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: sha,
    base,
    createdAt: new Date().toISOString(),
    redFirst: red.results,
    judges,
  });
  writeReviewRecord(root, record);
  return record;
}
