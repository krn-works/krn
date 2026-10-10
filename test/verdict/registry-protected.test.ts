import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { judge } from '../../src/verdict/index.ts';
import { resolveRegistry } from '../../src/verdict/registry.ts';

function fixture() {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'krn-registry-protected-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (message: string) => {
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };

  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { check: 'node -e ""' } }),
  );
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'check', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  const base = commit('base registry');
  return { root, git, commit, base };
}

test('registry resolves v1 and v2 protected globs', async () => {
  const f = fixture();
  try {
    const v1 = await resolveRegistry(f.root, f.base);
    assert.deepEqual(v1.protected, []);
    assert.deepEqual(
      v1.checks.map(({ id }) => id),
      ['check'],
    );

    writeFileSync(
      join(f.root, 'krn.checks.json'),
      JSON.stringify({
        version: 2,
        checks: [{ id: 'check', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
        protected: ['src/**'],
      }),
    );
    mkdirSync(join(f.root, 'src'));
    writeFileSync(
      join(f.root, 'src', 'guarded.ts'),
      'export const value = 1;\n',
    );
    const v2Sha = f.commit('v2 registry');
    const v2 = await resolveRegistry(f.root, v2Sha);
    assert.deepEqual(v2.protected, ['src/**']);
    assert.deepEqual(
      v2.checks.map(({ id }) => id),
      ['check'],
    );

    writeFileSync(
      join(f.root, 'src', 'guarded.ts'),
      'export const value = 2;\n',
    );
    const protectedSha = f.commit('change protected path');
    const verdict = await judge(
      {
        id: 'registry-protected-test',
        issue: 'LON-219',
        worktree: f.root,
        repoRoot: f.root,
      },
      protectedSha,
      v2Sha,
      ['check'],
      async () => {},
    );
    assert.equal(verdict.kind, 'refused');
    assert.deepEqual(verdict.findings, [
      'evaluator surface changed: src/guarded.ts',
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
