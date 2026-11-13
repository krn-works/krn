import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  accountLabel,
  gauge,
  mainCheckout,
  record,
  sampleOf,
  stateRoot,
} from '../../scripts/claude/plan-sample.ts';
import { parsePlanSamples } from '../../src/outcome/plan-gauge.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Verbatim status line input captured from an interactive session (spike-g).
const capture = JSON.parse(
  readFileSync(
    join(root, 'test/fixtures/claude-statusline/rate-limits.json'),
    'utf8',
  ),
) as { first: unknown; second: unknown };
const scratch = () => mkdtempSync(join(tmpdir(), 'plan-sample-'));
// A temp repo marked by its own `.git`, so no test depends on the checkout kind.
const repo = () => {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  return dir;
};
const runStatusLine = (cwd: string) =>
  spawnSync(process.execPath, [join(root, 'scripts/claude/plan-sample.ts')], {
    input: JSON.stringify({ ...(capture.second as object), cwd }),
    encoding: 'utf8',
  });

test('the captured payload yields one sample; the call before the first response yields none', () => {
  const now = new Date('2026-11-10T07:52:39.123Z');
  assert.equal(sampleOf(capture.first, now), undefined);
  assert.deepEqual(sampleOf(capture.second, now), {
    time: '2026-11-10T07:52:39Z',
    session: '91b5aba5-823a-4c4b-a857-b374ec5f1e2c',
    five_hour: 88,
    seven_day: 50,
    five_hour_resets: '2026-11-10T08:00:00Z',
    seven_day_resets: '2026-11-16T12:00:00Z',
  });
});

test('a sample names its hashed account and both resets; an old row still parses', () => {
  const config = { oauthAccount: { accountUuid: 'acct-1' } };
  const account = accountLabel(config);
  assert.match(account ?? '', /^[0-9a-f]{12}$/u);
  assert.notEqual(account, 'acct-1');
  assert.equal(accountLabel({}), undefined);
  const sample = sampleOf(
    capture.second,
    new Date('2026-11-10T07:52:39Z'),
    account,
  );
  assert.equal(sample?.account, account);
  assert.equal(sample?.five_hour_resets, '2026-11-10T08:00:00Z');
  assert.equal(sample?.seven_day_resets, '2026-11-16T12:00:00Z');

  const dir = scratch();
  mkdirSync(join(dir, '.krn/plan'), { recursive: true });
  const old = {
    time: '2026-11-10T07:00:00Z',
    session: 's',
    five_hour: 88,
    seven_day: 50,
  };
  writeFileSync(
    join(dir, '.krn/plan/samples.jsonl'),
    `${JSON.stringify(old)}\n`,
  );
  assert.ok(sample);
  assert.equal(record(dir, sample), true);
  const rows = readFileSync(join(dir, '.krn/plan/samples.jsonl'), 'utf8')
    .split('\n')
    .slice(0, -1);
  assert.equal(rows.length, 2);
  assert.deepEqual(parsePlanSamples(rows.join('\n')).length, 2);
});

test('a sample is appended only when a window moves, and reads back', () => {
  const dir = scratch();
  const sample = sampleOf(capture.second, new Date('2026-11-10T07:52:39Z'));
  assert.ok(sample);
  assert.equal(record(dir, sample), true);
  assert.equal(record(dir, { ...sample, time: '2026-11-10T07:53:00Z' }), false);
  assert.equal(record(dir, { ...sample, five_hour: 89 }), true);
  const rows = readFileSync(join(dir, '.krn/plan/samples.jsonl'), 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as { five_hour: number });
  assert.deepEqual(
    rows.map((row) => row.five_hour),
    [88, 89],
  );
});

test('worktree state resolves to the main checkout', () => {
  assert.equal(mainCheckout('/r/.krn/worktrees/slug/sub'), '/r');
  assert.equal(mainCheckout('/r/src'), '/r/src');
  assert.equal(
    mainCheckout('/w/.krn/worktrees/lane/.krn/tmp/r/.krn/worktrees/x'),
    '/w/.krn/worktrees/lane/.krn/tmp/r',
  );
  assert.equal(gauge(undefined), 'plan —');
});

test('the status line command writes under the payload cwd and prints the gauge', () => {
  const dir = repo();
  const payload = {
    ...(capture.second as object),
    cwd: join(dir, '.krn/worktrees/x'),
  };
  const run = spawnSync(
    process.execPath,
    [join(root, 'scripts/claude/plan-sample.ts')],
    { input: JSON.stringify(payload), encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'plan 5h 88% · 7d 50%\n');
  assert.match(
    readFileSync(join(dir, '.krn/plan/samples.jsonl'), 'utf8'),
    /"five_hour":88/u,
  );
  const bad = spawnSync(
    process.execPath,
    [join(root, 'scripts/claude/plan-sample.ts')],
    {
      input: 'not json',
      encoding: 'utf8',
    },
  );
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, 'plan —\n');
});

test('a cwd in a nested subdirectory writes to the repo root, never below it', () => {
  const dir = repo();
  const nested = join(dir, '.krn/runs/program/deep');
  mkdirSync(nested, { recursive: true });
  assert.equal(stateRoot(nested), dir);
  assert.equal(runStatusLine(nested).status, 0);
  assert.ok(existsSync(join(dir, '.krn/plan/samples.jsonl')));
  assert.equal(existsSync(join(nested, '.krn')), false);

  const worktree = join(dir, '.krn/worktrees/x');
  const inside = join(worktree, 'src/deep');
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
  assert.equal(stateRoot(inside), dir);
  assert.equal(existsSync(join(worktree, '.krn')), false);
});

test('outside any repository nothing resolves', () => {
  // The system temp dir may itself sit inside a repository, so use the root.
  assert.equal(stateRoot('/krn-no-such-directory/a/b'), undefined);
});
