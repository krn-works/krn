import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  census,
  detectStack,
  POPULATION,
  type Row,
  renderTable,
} from '../../evals/adoption/census.ts';

test('stack detection names workspaces, wordpress, python and static repositories', () => {
  assert.equal(detectStack(['package.json', 'tsconfig.json']), 'ts');
  assert.equal(
    detectStack(['package.json'], '{"workspaces":["a"]}'),
    'npm workspaces',
  );
  assert.equal(
    detectStack(['composer.json', 'wp-cli.yml', 'package.json']),
    'npm+php/wordpress',
  );
  assert.equal(detectStack(['pyproject.toml']), 'python');
  assert.equal(detectStack(['index.html']), 'static/other');
});

test('the census population is fifteen distinct repositories', () => {
  assert.equal(POPULATION.length, 15);
  assert.equal(new Set(POPULATION).size, 15);
});

test('the table renders one row per repository with exits and escaped gaps', () => {
  const row: Row = {
    repo: 'a/b',
    head: 'abc1234',
    stack: 'ts',
    adopt: 64,
    standards: 0,
    verify: 1,
    test: 'none',
    gaps: 'adopt: x | y',
  };
  const table = renderTable([row]);
  assert.match(
    table,
    /\| a\/b \| abc1234 \| ts \| 64 \| 0 \| 1 \| none \| adopt: x \/ y \|/,
  );
});

test('a census row comes from a real clone, its HEAD and the krn exit codes', () => {
  const base = mkdtempSync(join(tmpdir(), 'krn-census-'));
  try {
    const source = join(base, 'coding', 'repo-a');
    mkdirSync(source, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'census');
    git('config', 'user.email', 'census@example.invalid');
    writeFileSync(join(source, 'package.json'), '{"workspaces":["a"]}');
    git('add', '.');
    git('commit', '-qm', 'seed');
    mkdirSync(join(base, 'root', 'bin'), { recursive: true });
    const krn = join(base, 'root', 'bin', 'krn');
    writeFileSync(krn, '#!/bin/sh\nexit 0\n');
    chmodSync(krn, 0o755);
    const scratch = join(base, 'scratch');
    mkdirSync(scratch);
    const row = census('repo-a', {
      coding: join(base, 'coding'),
      scratch,
      repoRoot: join(base, 'root'),
    });
    assert.equal(row.stack, 'npm workspaces');
    assert.equal(row.head, git('rev-parse', '--short', 'HEAD').stdout.trim());
    assert.deepEqual([row.adopt, row.standards, row.verify], [0, 0, 0]);
    assert.equal(row.test, 'none');
    assert.equal(row.gaps, '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
