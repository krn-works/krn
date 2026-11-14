import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  equivalencePower,
  equivalenceUnits,
  pairedPower,
  requirePreregistration,
  unitsForPower,
} from '../../evals/d23/preregistration.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const runs = join(repo, 'evals/d23/runs.ts');
const sha = (b: string | Buffer) =>
  createHash('sha256').update(b).digest('hex');

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
    { stdio: 'ignore' },
  );

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'prereg-'));
  git(dir, 'init', '-q');
  return dir;
}

test('the preregistration gate accepts a committed file with its hash and refuses every other state', () => {
  const dir = tmpRepo();
  try {
    const file = join(dir, 'prereg.md');
    writeFileSync(file, 'rule\n');
    const hash = sha('rule\n');
    assert.throws(() => requirePreregistration(file, hash), /not committed/);
    git(dir, 'add', 'prereg.md');
    git(dir, 'commit', '-qm', 'prereg');
    assert.equal(requirePreregistration(file, hash), hash);
    assert.throws(
      () => requirePreregistration(join(dir, 'none.md'), hash),
      /not found/,
    );
    assert.throws(() => requirePreregistration(file, ''), /64 hex/);
    assert.throws(
      () => requirePreregistration(file, sha('other')),
      /sha256 is/,
    );
    writeFileSync(file, 'rule changed\n');
    assert.throws(
      () => requirePreregistration(file, sha('rule changed\n')),
      /not committed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the confirmatory runner exits 64 without a preregistration and names the reason', () => {
  const r = spawnSync(process.execPath, [runs, '--confirmatory'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /confirmatory run refused/);
  assert.equal(r.stdout, '');
  const wrong = spawnSync(
    process.execPath,
    [
      runs,
      '--confirmatory',
      '--prereg',
      join(repo, 'evals/d23/preregistration.md'),
      '--prereg-sha256',
      sha('x'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(wrong.status, 64);
  assert.match(wrong.stderr, /sha256 is/);
});

test('the power formulas match their closed forms', () => {
  assert.ok(Math.abs(pairedPower(33, 0, 0.44) - 0.05) < 1e-4);
  assert.ok(Math.abs(pairedPower(33, 0.09, 0.44) - 0.217) < 0.001);
  assert.equal(unitsForPower(0.09, 0.44), 188);
  assert.ok(pairedPower(188, 0.09, 0.44) >= 0.8);
  assert.ok(pairedPower(187, 0.09, 0.44) < 0.8);
  assert.equal(equivalencePower(33, 0.1, 0, 0.44), 0);
  assert.equal(equivalenceUnits(0.1, 0.44), 166);
  assert.ok(equivalencePower(166, 0.1, 0, 0.44) >= 0.8);
});

test('the committed preregistration states the computed power and names a fresh-unit source', () => {
  const text = readFileSync(join(repo, 'evals/d23/preregistration.md'), 'utf8');
  assert.match(
    text,
    new RegExp(
      `power, true \\+9 pp, n = 33 \\| ${pairedPower(33, 0.09, 0.44).toFixed(3)} `,
    ),
  );
  assert.match(
    text,
    new RegExp(
      `units for power 0.8 at \\+9 pp \\| ${unitsForPower(0.09, 0.44)} `,
    ),
  );
  assert.match(
    text,
    new RegExp(
      `units for equivalence power 0.8, m = 10 pp \\| ${equivalenceUnits(0.1, 0.44)} `,
    ),
  );
  for (const outcome of ['K better', 'worse', 'equivalent', 'not shown'])
    assert.ok(text.includes(`| ${outcome} |`), outcome);
  assert.match(text, /## Fresh units/);
  assert.match(text, /seo-audit-harness/);
});
