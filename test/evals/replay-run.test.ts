import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARMS, parseArms } from '../../evals/replay/arms.ts';
import { defaultSources, plan } from '../../evals/replay/run.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const run = (...a: string[]) =>
  execFileSync('node', ['evals/replay/run.ts', ...a], {
    cwd: repo,
    encoding: 'utf8',
  });

test('dry run of three arms over three units prints nine rows', () => {
  const out = run('--arms', 'A,B,C', '--units', '3', '--dry');
  const rows = out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 9);
  assert.match(out, /verdict: 9 rows/);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), [
      'unit',
      'arm',
      'rep',
      'pass',
      'cost',
      'harness',
    ]);
    assert.match(r.harness, /^[0-9a-f]{12}$/);
  }
  assert.equal(new Set(rows.map((r) => r.unit)).size, 3);
});

test('arms are configuration and unknown arms are refused', () => {
  assert.deepEqual(
    parseArms('A,C').map((a) => a.id),
    ['A', 'C'],
  );
  assert.equal(ARMS.C.krn, true);
  assert.equal(ARMS.B.staticRecords, true);
  assert.throws(() => parseArms('D'), /unknown arm/);
});

test('reps multiply rows per unit and arm', () => {
  const rows = plan({
    arms: parseArms('A,B'),
    units: ['u1'],
    reps: 3,
    harness: 'x',
  });
  assert.equal(rows.length, 6);
});

test('default screening sources resolve to the main checkout from a linked worktree', () => {
  const main = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  ).trim();
  const expected = join(
    realpathSync(dirname(main)),
    '.krn',
    'sources',
    'screening',
  );
  assert.equal(defaultSources(repo), expected);
  assert.equal(defaultSources(join(repo, 'evals', 'replay')), expected);
});
