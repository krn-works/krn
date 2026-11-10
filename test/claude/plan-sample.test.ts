import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  gauge,
  mainCheckout,
  record,
  sampleOf,
} from '../../scripts/claude/plan-sample.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Verbatim status line input captured from an interactive session (spike-g).
const capture = JSON.parse(
  readFileSync(
    join(root, 'test/fixtures/claude-statusline/rate-limits.json'),
    'utf8',
  ),
) as { first: unknown; second: unknown };
const scratch = () => mkdtempSync(join(tmpdir(), 'plan-sample-'));

test('the captured payload yields one sample; the call before the first response yields none', () => {
  const now = new Date('2026-11-10T07:52:39.123Z');
  assert.equal(sampleOf(capture.first, now), undefined);
  assert.deepEqual(sampleOf(capture.second, now), {
    time: '2026-11-10T07:52:39Z',
    session: '91b5aba5-823a-4c4b-a857-b374ec5f1e2c',
    five_hour: 88,
    seven_day: 50,
  });
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
  assert.equal(gauge(undefined), 'plan —');
});

test('the status line command writes under the payload cwd and prints the gauge', () => {
  const dir = scratch();
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
