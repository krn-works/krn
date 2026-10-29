// Verdict files are exclusive; overrides replace only an already validated FAIL record.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { repoRoot, validateSha } from './repository.ts';
import {
  attemptRecordPath,
  readReviewJson,
  seriesRecordPaths,
  verifyReviewBinding,
} from './series.ts';

export { reserveReviewAttempt } from './series.ts';

import {
  deterministicCauses,
  type NewReviewRecord,
  newReviewRecordSchema,
  type ReviewRecord,
  reviewRecordSchema,
  type SeriesIdentity,
} from './types.ts';

function recordPath(root: string, sha: string): string {
  if (!/^[a-f0-9]{40,64}$/u.test(sha)) throw new Error('invalid review SHA');
  const state = join(root, '.krn');
  const reviewRoot = join(state, 'runs', 'review');
  const directory = join(reviewRoot, sha);
  if (
    realpathSync(state) !== state ||
    realpathSync(reviewRoot) !== reviewRoot ||
    realpathSync(directory) !== directory
  )
    throw new Error('unsafe review record directory');
  return join(directory, 'record.json');
}

export function writeReviewRecord(root: string, record: NewReviewRecord): void {
  const validated = newReviewRecordSchema.parse(record);
  if (validated.attempt) {
    writeExclusive(attemptRecordPath(root, validated.attempt), validated);
    return;
  }
  const reviewRoot = join(root, '.krn', 'runs', 'review');
  if (realpathSync(join(root, '.krn')) !== join(root, '.krn'))
    throw new Error('unsafe repository state directory');
  mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
  if (realpathSync(reviewRoot) !== reviewRoot)
    throw new Error('unsafe review record directory');
  const directory = join(reviewRoot, validated.headSha);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error('unsafe SHA-bound review directory');
  const path = join(directory, 'record.json');
  if (existsSync(path))
    throw new Error(`review record already exists for ${validated.headSha}`);
  writeExclusive(path, validated);
}

function writeExclusive(path: string, validated: NewReviewRecord): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    linkSync(temporary, path);
    unlinkSync(temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function appendOverride(
  repo: string,
  shaInput: string,
  override: { readonly reason: string; readonly evidence: string },
  identity?: SeriesIdentity,
): ReviewRecord {
  const root = repoRoot(repo);
  const sha = validateSha(root, shaInput);
  const paths = identity
    ? seriesRecordPaths(root, identity, sha)
    : [recordPath(root, sha)];
  const path = paths[paths.length - 1];
  if (!path) throw new Error('review record is missing');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('review record must be a regular file');
  const current = reviewRecordSchema.parse(readReviewJson(path));
  if (identity) verifyReviewBinding(root, current, identity);
  if (deterministicCauses(current.redFirst, current.contracts ?? []).length)
    throw new Error(
      'deterministic checks always block; override cannot bypass them',
    );
  if (current.headSha !== sha)
    throw new Error('review record SHA does not match');
  if (current.override) throw new Error('review override already exists');
  if (
    !current.judges.some(
      (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
    )
  )
    throw new Error('override requires a recorded FAIL verdict');
  const updated = reviewRecordSchema.parse({
    ...current,
    override: { ...override, appendedAt: new Date().toISOString() },
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, path);
  return updated;
}
