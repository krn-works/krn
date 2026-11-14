import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { adoptionDrift, refreshAdoption } from '../../src/adopt/drift.ts';

// KRN-12: the real `krn adopt` entry writes the fixture, then drift and refresh read it back.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function adopted(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-drift-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  mkdirSync(join(root, 'tasks'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  const run = spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--no-canary', '--tracker'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return root;
}

const krnAdopt = (root: string, flag: string) =>
  spawnSync(process.execPath, [cli, 'adopt', root, flag], {
    encoding: 'utf8',
  });

test('an untouched adoption has no drift and refresh keeps every file', () => {
  const root = adopted();
  const drift = adoptionDrift(root);
  assert.deepEqual([drift.drifted, drift.missing], [[], []]);
  const run = krnAdopt(root, '--refresh');
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /^updated /mu);
  assert.match(run.stdout, /^kept \.claude\/settings\.json$/mu);
});

test('an edited hook file and a deleted standards record are each named and drift leaves the files as found', () => {
  const root = adopted();
  const settings = join(root, '.claude/settings.json');
  writeFileSync(settings, '{}\n');
  rmSync(join(root, '.agents/standards.json'));
  const before = readFileSync(settings, 'utf8');
  const drift = adoptionDrift(root);
  assert.ok(drift.drifted.includes('.claude/settings.json'));
  assert.ok(drift.missing.includes('.agents/standards.json'));
  assert.equal(readFileSync(settings, 'utf8'), before);
  assert.equal(existsSync(join(root, '.agents/standards.json')), false);
});

test('refresh updates a standards file that predates tiers, keeps repo-owned files and is idempotent', () => {
  const root = adopted();
  const standards = join(root, '.agents/standards.json');
  const current = JSON.parse(readFileSync(standards, 'utf8')) as {
    tier?: unknown;
  }[];
  for (const record of current) delete record.tier;
  writeFileSync(standards, `${JSON.stringify(current, null, 2)}\n`);
  const contract = join(root, 'krn.json');
  writeFileSync(
    contract,
    '{"base":"main","test":"node --test","tracker":"krn"}\n',
  );
  const owned = readFileSync(contract, 'utf8');
  const first = krnAdopt(root, '--refresh');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^updated \.agents\/standards\.json$/mu);
  assert.equal(readFileSync(contract, 'utf8'), owned);
  const second = krnAdopt(root, '--refresh');
  assert.doesNotMatch(second.stdout, /^updated /mu);
  assert.match(second.stdout, /^kept \.agents\/standards\.json$/mu);
});

test('refreshAdoption rewrites a drifted skill file', () => {
  const root = adopted();
  const skill = readdirSkill(root);
  writeFileSync(skill, 'edited\n');
  assert.deepEqual(refreshAdoption(root).drifted, [
    skill.slice(root.length + 1),
  ]);
  assert.notEqual(readFileSync(skill, 'utf8'), 'edited\n');
});

function readdirSkill(root: string): string {
  const dir = join(root, '.agents/skills');
  const name = spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split(
    '\n',
  )[0];
  return join(dir, name as string, 'SKILL.md');
}
