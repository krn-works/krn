import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildUnit,
  loadUnits,
  outcomeOf,
  parseUnit,
  verifyUnit,
} from '../../evals/units/unit.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const unitsDir = join(repo, 'evals/units');

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

// A pilot repository in miniature: the base lacks add(), the next commit delivers it.
function pilot() {
  const dir = mkdtempSync(join(tmpdir(), 'unit-pilot-'));
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'tasks'));
  const record = {
    id: 't-abc1234',
    title: 'add sums',
    body: ['Why: x\nOutcome: add(a, b) returns a + b.\nProof: y'],
  };
  writeFileSync(join(dir, 'tasks/t-abc1234.json'), JSON.stringify(record));
  writeFileSync(join(dir, 'lib.sh'), 'add() { echo 0; }\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'lib.sh'), 'add() { echo $(($1 + $2)); }\n');
  git(dir, 'commit', '-qam', 'fix add (t-abc1234)');
  const hidden = join(dir, '..', `${dir.split('/').pop()}-hidden.sh`);
  writeFileSync(hidden, '. ./lib.sh\n[ "$(add 2 3)" = 5 ]\n');
  return { dir, hidden };
}

test('the builder turns a task, its fix commit and a hidden file into a unit that is red on base and green on reference', () => {
  const { dir, hidden } = pilot();
  const out = mkdtempSync(join(tmpdir(), 'unit-out-'));
  try {
    const unit = buildUnit({
      repoDir: dir,
      repo: 'o/pilot',
      id: 't-abc1234',
      merge: 'HEAD',
      hiddenFile: hidden,
      hiddenDest: 'hidden/check.sh',
      install: 'true',
      test: 'sh hidden/check.sh',
      out,
    });
    assert.equal(unit.base, git(dir, 'rev-parse', 'HEAD~1'));
    assert.equal(unit.reference, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(unit.spec, 'add(a, b) returns a + b.');
    assert.equal(unit.task.title, 'add sums');
    const [loaded] = loadUnits(out);
    assert.deepEqual(loaded?.unit, unit);
    assert.ok(existsSync(join(out, 't-abc1234', unit.hidden.file)));
    const v = verifyUnit(dir, unit, join(out, 't-abc1234'));
    assert.deepEqual(v, {
      id: 't-abc1234',
      base: 'FAIL',
      reference: 'PASS',
      ok: true,
    });
    // a hidden test that passes on base is not a valid unit
    writeFileSync(join(out, 't-abc1234', unit.hidden.file), 'true\n');
    assert.equal(verifyUnit(dir, unit, join(out, 't-abc1234')).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the unit format refuses a record without a base, a spec or a hidden file', () => {
  const good = JSON.parse(
    readFileSync(join(unitsDir, 't-g1fc0cz/unit.json'), 'utf8'),
  );
  parseUnit(JSON.stringify(good));
  for (const [key, value] of [
    ['base', 'abc'],
    ['reference', good.base],
    ['spec', ''],
    ['hidden', {}],
    ['id', 'x'],
  ] as const) {
    assert.throws(
      () => parseUnit(JSON.stringify({ ...good, [key]: value })),
      /unit/,
    );
  }
  assert.throws(() => outcomeOf('Why: no outcome'), /Outcome/);
});

test('the committed batch holds the pilot units, each with its hidden file and the pilot repository names', () => {
  const units = loadUnits(unitsDir);
  assert.equal(units.length, 10);
  const repos = new Set(units.map((u) => u.unit.repo));
  assert.deepEqual([...repos].sort(), [
    'krn-works/krn-pilot-py',
    'krn-works/seo-audit-harness',
  ]);
  assert.equal(new Set(units.map((u) => u.unit.id)).size, 10);
  for (const { unit, dir } of units) {
    assert.ok(existsSync(join(dir, unit.hidden.file)), unit.id);
  }
});

// Needs the private pilot clones; KRN_UNIT_SOURCES points at a directory holding both by repository name.
const sources = process.env.KRN_UNIT_SOURCES ?? join(repo, '.krn/sources');
const live =
  existsSync(join(sources, 'seo-audit-harness/.git')) &&
  existsSync(join(sources, 'krn-pilot-py/.git'));
// The check runs only where the private clones exist and KRN_UNIT_LIVE is set (it installs dependencies per commit).
test('every committed unit is red on base and green on its reference fix', () => {
  if (!live || !process.env.KRN_UNIT_LIVE) return;
  for (const { unit, dir } of loadUnits(unitsDir)) {
    const v = verifyUnit(
      join(sources, unit.repo.split('/')[1] as string),
      unit,
      dir,
    );
    assert.deepEqual(v, {
      id: unit.id,
      base: 'FAIL',
      reference: 'PASS',
      ok: true,
    });
  }
});
