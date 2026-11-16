import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { eligible, type ScreenUnit } from '../../evals/replay/screen.ts';
import {
  commandsFor,
  type ManifestRow,
  readManifest,
  unitId,
  type Verification,
  verified,
} from '../../evals/units/screening.ts';
import { loadUnits } from '../../evals/units/unit.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const unitsDir = join(repo, 'evals/units');
const good: Verification = {
  installBase: 0,
  testBase: 1,
  baseFailure: 'assertion',
  installFix: 0,
  testFix: 0,
};

const row = (n: number, v: Verification | undefined): ManifestRow => ({
  id: unitId(`https://github.com/o/r/issues/${n}`),
  repo: 'o/r',
  issue: `https://github.com/o/r/issues/${n}`,
  fixPr: `https://github.com/o/r/pull/${n}`,
  base: 'a'.repeat(40),
  fix: 'b'.repeat(40),
  committed: '2026-08-01',
  test: 't',
  verification: v,
});

test('a unit counts as verified only when the hidden test is red by assertion on base and green on the fix', () => {
  assert.equal(verified(good), true);
  assert.equal(verified(undefined), false);
  assert.equal(verified({ ...good, testFix: 1 }), false);
  assert.equal(verified({ ...good, testBase: 0, baseFailure: 'none' }), false);
  assert.equal(verified({ ...good, baseFailure: 'compile' }), false);
  assert.equal(verified({ ...good, installFix: 1 }), false);
});

test('a unit id keeps the task id shape and differs per issue', () => {
  const a = unitId('https://github.com/o/r/issues/1');
  assert.match(a, /^t-[a-z0-9]{7}$/);
  assert.notEqual(a, unitId('https://github.com/o/r/issues/2'));
  assert.equal(a, unitId('https://github.com/o/r/issues/1'));
});

test('commands name the runner the base tree shows and nothing when none is named', () => {
  const none = () => null;
  assert.match(
    commandsFor('Go', 'pkg/a/a_test.go', none)?.test ?? '',
    /go test .* \.\/pkg\/a\/$/,
  );
  assert.equal(commandsFor('Python', 'tests/test_a.py', none), null);
  const vitest = (p: string) =>
    p === 'package.json' ? '{"vitest":"1"}' : null;
  assert.match(
    commandsFor('TypeScript', 'src/a.test.ts', vitest)?.test ?? '',
    /vitest run "src\/a\.test\.ts"/,
  );
  assert.equal(
    commandsFor('TypeScript', 'a.test.ts', (p) =>
      p === 'package.json' ? '{}' : null,
    ),
    null,
  );
});

function recorded(rows: ManifestRow[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'screening-')), 'm.json');
  writeFileSync(file, JSON.stringify(rows));
  return spawnSync(
    process.execPath,
    [
      join(unitsDir, 'screening.ts'),
      'verify',
      '--recorded',
      '--manifest',
      file,
    ],
    { encoding: 'utf8' },
  );
}

test('verify prints the verified count and exits 0 only from 70 units', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row(i, good)).concat([
      row(900, { ...good, testFix: 1 }),
    ]);
  const few = recorded(rows(69));
  assert.equal(few.stdout.trim(), 'units: 69 verified');
  assert.equal(few.status, 1);
  const enough = recorded(rows(70));
  assert.equal(enough.stdout.trim(), 'units: 70 verified');
  assert.equal(enough.status, 0);
});

test('every committed screening unit is verified, loads, and is eligible for the screen', () => {
  const rows = readManifest();
  const live = rows.filter((r) => verified(r.verification));
  const loaded = loadUnits(unitsDir).filter((u) =>
    rows.some((r) => r.id === u.unit.id),
  );
  assert.deepEqual(
    loaded.map((u) => u.unit.id).sort(),
    live.map((r) => r.id).sort(),
  );
  for (const { unit, dir } of loaded) {
    assert.ok(existsSync(join(dir, unit.hidden.file)), unit.id);
    const r = rows.find((x) => x.id === unit.id) as ManifestRow;
    assert.equal(unit.base, r.base);
    assert.equal(unit.reference, r.fix);
  }
  assert.equal(
    eligible(loaded.map((u) => u.unit as ScreenUnit)).length,
    loaded.length,
  );
});
