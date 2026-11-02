// One repo-common owner for immutable PR attempt reservations and their records.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  budgetExceptionSchema,
  pullRequestSchema,
  type ReviewAttempt,
  type ReviewRecord,
  reviewAttemptSchema,
  type SeriesIdentity,
  seriesIdentitySchema,
} from './types.ts';

export class ReviewBudgetError extends Error {
  constructor(message: string) {
    super(`review budget: ${message}`);
    this.name = 'ReviewBudgetError';
  }
}

function git(repo: string, args: readonly string[]): string {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ])
    delete env[key];
  const result = spawnSync('git', ['-C', repo, ...args], {
    env,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new ReviewBudgetError('cannot read repository common state');
  return result.stdout.trim();
}

export type PullReader = (
  repo: string,
  pr: number,
) => unknown | Promise<unknown>;

export function githubRepository(remote: string): string | undefined {
  return /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/iu.exec(
    remote,
  )?.[1];
}

export const readPullRequest: PullReader = (repo, pr) => {
  const slug = githubRepository(git(repo, ['remote', 'get-url', 'origin']));
  if (!slug)
    throw new ReviewBudgetError('origin must identify a GitHub repository');
  const result = spawnSync('gh', ['api', `repos/${slug}/pulls/${pr}`], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new ReviewBudgetError('authoritative PR metadata unavailable');
  const decoded: unknown = JSON.parse(result.stdout);
  return decoded;
};

export function verifyPullRequest(
  value: unknown,
  pr: number,
  base: string,
  head: string,
) {
  const parsed = pullRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new ReviewBudgetError('invalid authoritative PR metadata');
  const pull = parsed.data;
  if (pull.number !== pr || pull.base.sha !== base || pull.head.sha !== head)
    throw new ReviewBudgetError(
      'authoritative PR number/base/head does not match requested review',
    );
  return seriesIdentitySchema.parse({
    schemaVersion: 1,
    repository: pull.base.repo.full_name,
    pr,
    baseRef: pull.base.ref,
  });
}

function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path
  )
    throw new ReviewBudgetError(`unsafe series directory: ${path}`);
}

function safeDirectoryExists(path: string): boolean {
  try {
    safeDirectory(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  safeDirectory(path);
}

export function readReviewJson(path: string): unknown {
  let fd: number | undefined;
  try {
    // Check every ancestor as well as the final file, including dangling symlinks.
    let parent = dirname(resolve(path));
    while (parent !== dirname(parent)) {
      safeDirectory(parent);
      parent = dirname(parent);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new ReviewBudgetError(
        'record/state must be a regular non-symlink file of at most 1 MB',
      );
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size > 1024 * 1024
    )
      throw new ReviewBudgetError('record/state changed while reading');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 1024 * 1024)
      throw new ReviewBudgetError('record/state exceeds 1 MB');
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, length));
    const decoded: unknown = JSON.parse(text);
    return decoded;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameSeries(left: SeriesIdentity, right: SeriesIdentity): boolean {
  return (
    left.repository === right.repository &&
    left.pr === right.pr &&
    left.baseRef === right.baseRef
  );
}

function seriesPath(
  repo: string,
  identity: SeriesIdentity,
  create: boolean,
): string {
  const common = realpathSync(
    git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const root = realpathSync(dirname(common));
  let path = root;
  for (const part of ['.krn', 'runs', 'review-series']) {
    path = join(path, part);
    if (create) ensureDirectory(path);
    else safeDirectory(path);
  }
  // The PR index intentionally excludes baseRef: changing an established target fails closed.
  const key = createHash('sha256')
    .update(`${identity.repository}\0${identity.pr}`)
    .digest('hex');
  path = join(path, key);
  if (create && !existsSync(path)) {
    const temporary = mkdtempSync(join(dirname(path), '.series-'));
    try {
      mkdirSync(join(temporary, 'attempts'), { mode: 0o700 });
      mkdirSync(join(temporary, 'records'), { mode: 0o700 });
      writeFileSync(
        join(temporary, 'series.json'),
        `${JSON.stringify(identity)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      try {
        renameSync(temporary, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
          )
        )
          throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  safeDirectory(path);
  const established = seriesIdentitySchema.parse(
    readReviewJson(join(path, 'series.json')),
  );
  if (!sameSeries(established, identity))
    throw new ReviewBudgetError(
      'inconsistent established PR repository/base ref',
    );
  safeDirectory(join(path, 'attempts'));
  safeDirectory(join(path, 'records'));
  return path;
}

function reservations(path: string, identity: SeriesIdentity): ReviewAttempt[] {
  const names = readdirSync(join(path, 'attempts')).filter(
    (name) => !/^\.[a-f\d-]+\.tmp$/u.test(name),
  );
  if (names.some((name) => !/^[1-9]\d*$/u.test(name)))
    throw new ReviewBudgetError('corrupt attempt state');
  names.sort(
    (left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
  );
  const attempts = names.map((name, index) => {
    if (name !== `${index + 1}`)
      throw new ReviewBudgetError('gapped or missing attempt state');
    const slot = join(path, 'attempts', name);
    safeDirectory(slot);
    const contents = readdirSync(slot);
    if (contents.length !== 1 || contents[0] !== 'reservation.json')
      throw new ReviewBudgetError(
        'missing or corrupt reservation in consumed slot',
      );
    const attempt = reviewAttemptSchema.parse(
      readReviewJson(join(slot, 'reservation.json')),
    );
    if (attempt.ordinal !== index + 1 || !sameSeries(attempt, identity))
      throw new ReviewBudgetError(
        'reservation does not match its series/ordinal',
      );
    return attempt;
  });
  for (const name of readdirSync(join(path, 'records'))) {
    if (/^[1-9]\d*\.json\.[a-f\d-]+\.tmp$/u.test(name)) continue;
    if (
      !/^[1-9]\d*\.json$/u.test(name) ||
      Number.parseInt(name, 10) > attempts.length
    )
      throw new ReviewBudgetError('record has missing reservation state');
  }
  return attempts;
}

function atomicReservation(path: string, value: ReviewAttempt): boolean {
  const temporary = join(path, 'attempts', `.${randomUUID()}.tmp`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeFileSync(
      join(temporary, 'reservation.json'),
      `${JSON.stringify(value)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    // Publish a complete nonempty slot atomically. Missing reservation metadata
    // leaves a consumed slot that refuses further cost, even without a record.
    renameSync(temporary, join(path, 'attempts', `${value.ordinal}`));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
    )
      return false;
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function reserveReviewAttempt(
  repo: string,
  identity: SeriesIdentity,
  base: string,
  head: string,
  priorRecordSha256?: string,
  exceptionPath?: string,
): ReviewAttempt {
  // Validate external exception bytes before creating any series state.
  const exception =
    exceptionPath === undefined
      ? undefined
      : budgetExceptionSchema.parse(readReviewJson(resolve(exceptionPath)));
  const path = seriesPath(repo, identity, true);
  for (;;) {
    const attempts = reservations(path, identity);
    const ordinal = attempts.length + 1;
    if (ordinal > 2 && !exception)
      throw new ReviewBudgetError(
        'two attempts exhausted; supply --budget-exception for this exact ordinal/head',
      );
    const parsed = reviewAttemptSchema.safeParse({
      ...identity,
      id: randomUUID(),
      ordinal,
      baseSha: base,
      headSha: head,
      reservedAt: new Date().toISOString(),
      ...(priorRecordSha256 === undefined ? {} : { priorRecordSha256 }),
      ...(exception === undefined ? {} : { exception }),
    });
    if (!parsed.success)
      throw new ReviewBudgetError(
        'operator exception does not match this exact series/ordinal/head',
      );
    if (atomicReservation(path, parsed.data)) return parsed.data;
  }
}

export function checkReviewBudget(
  repo: string,
  identity: SeriesIdentity,
  exceptionPath?: string,
): void {
  const exception =
    exceptionPath === undefined
      ? undefined
      : budgetExceptionSchema.parse(readReviewJson(resolve(exceptionPath)));
  const common = realpathSync(
    git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const root = realpathSync(dirname(common));
  let seriesRoot = root;
  for (const part of ['.krn', 'runs', 'review-series']) {
    seriesRoot = join(seriesRoot, part);
    if (!safeDirectoryExists(seriesRoot)) return;
  }
  const key = createHash('sha256')
    .update(`${identity.repository}\0${identity.pr}`)
    .digest('hex');
  if (!safeDirectoryExists(join(seriesRoot, key))) return;

  const path = seriesPath(repo, identity, false);
  const attempts = reservations(path, identity);
  if (attempts.length + 1 > 2 && !exception)
    throw new ReviewBudgetError(
      'two attempts exhausted; supply --budget-exception for this exact ordinal/head',
    );
}

export function attemptRecordPath(
  repo: string,
  attempt: ReviewAttempt,
): string {
  const path = seriesPath(repo, attempt, false);
  const attempts = reservations(path, attempt);
  const reserved = attempts[attempt.ordinal - 1];
  if (JSON.stringify(reserved) !== JSON.stringify(attempt))
    throw new ReviewBudgetError('record/reservation binding does not match');
  return join(path, 'records', `${attempt.ordinal}.json`);
}

export function verifyReviewBinding(
  repo: string,
  record: ReviewRecord,
  identity: SeriesIdentity,
): void {
  if (!record.attempt)
    throw new ReviewBudgetError(
      'unbound legacy review cannot admit a PR; run a PR-bound review with --pr',
    );
  if (!sameSeries(record.attempt, identity))
    throw new ReviewBudgetError('record belongs to another PR/base ref');
  attemptRecordPath(repo, record.attempt);
}

export function seriesRecordPaths(
  repo: string,
  identity: SeriesIdentity,
  head: string,
): string[] {
  const path = seriesPath(repo, identity, false);
  const attempts = reservations(path, identity);
  const current = attempts.filter((attempt) => attempt.headSha === head);
  if (!current.length)
    throw new ReviewBudgetError(
      'exact-head PR-bound review reservation is missing',
    );
  return current.map((attempt) => {
    const record = join(path, 'records', `${attempt.ordinal}.json`);
    return record;
  });
}

export function currentReviewAttempts(
  repo: string,
  identity: SeriesIdentity,
  head: string,
): ReviewAttempt[] {
  const path = seriesPath(repo, identity, false);
  return reservations(path, identity).filter(
    (attempt) => attempt.headSha === head,
  );
}
