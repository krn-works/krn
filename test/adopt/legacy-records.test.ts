import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseUnified } from '../../src/brain/record.ts';

// KRN-12: a verbatim capture of the standards file an older krn wrote, adopted by the real `krn adopt` entry.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const capture = fileURLToPath(
  new URL('../fixtures/legacy-standards/standards.json', import.meta.url),
);

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function legacyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-legacy-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  mkdirSync(join(root, 'tasks'));
  mkdirSync(join(root, '.agents'));
  copyFileSync(capture, join(root, '.agents/standards.json'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const adopt = (root: string) =>
  spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--tracker', '--no-canary'],
    {
      encoding: 'utf8',
    },
  );

test('the legacy capture parses as current records and a current row stays strict', () => {
  const rows = JSON.parse(readFileSync(capture, 'utf8')) as unknown[];
  const parsed = parseUnified(rows);
  assert.equal(parsed.length, 17);
  assert.ok(parsed.every((r) => r.type === 'standard'));
  assert.equal(parsed[0]?.provenance.origin, 'krn pack (inherited)');
  const current = { ...(rows[0] as object), type: 'standard' };
  assert.throws(() => parseUnified([current]), /provenance/u);
});

test('adopt keeps every legacy record id and a second run changes nothing', () => {
  const root = legacyRepo();
  const ids = (
    JSON.parse(readFileSync(capture, 'utf8')) as { id: string }[]
  ).map((r) => r.id);
  const first = adopt(root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const file = join(root, '.agents/standards.json');
  const afterFirst = readFileSync(file, 'utf8');
  const kept = (JSON.parse(afterFirst) as { id: string }[]).map((r) => r.id);
  // Adopt re-copies the pack: a legacy id stays while the pack still holds it as a universal record in force.
  const pack = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../standards/records.json', import.meta.url)),
      'utf8',
    ),
  ) as { id: string; status: string; layer: string }[];
  const held = pack
    .filter((r) => r.status !== 'retired' && r.layer === 'universal')
    .map((r) => r.id);
  for (const id of ids)
    assert.equal(kept.includes(id), held.includes(id), `id ${id}`);
  assert.ok(ids.filter((id) => kept.includes(id)).length >= 12);
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const second = adopt(root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(readFileSync(file, 'utf8'), afterFirst);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), agents);
});
