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
  const root = mkdtempSync(join(scratch, 'krn-evaluator-surface-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (message: string) => {
    git([
      'add',
      '.gitignore',
      'package.json',
      'krn.checks.json',
      'check.mjs',
      'app.txt',
    ]);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };

  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { check: 'node check.mjs' } }),
  );
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
    }),
  );
  writeFileSync(
    join(root, 'check.mjs'),
    "import { readFileSync } from 'node:fs';\nprocess.exitCode = readFileSync('app.txt', 'utf8').trim() === 'safe' ? 0 : 1;\n",
  );
  writeFileSync(join(root, 'app.txt'), 'safe\n');
  const base = commit('base');
  const job = {
    id: 'evaluator-surface-test',
    issue: 'LON-219',
    worktree: root,
    repoRoot: root,
  };
  return { root, job, git, commit, base };
}

test('judge refuses a check-script bypass when the candidate also contains a defect', async () => {
  const f = fixture();
  try {
    const clean = await judge(f.job, f.base, f.base, ['check'], async () => {});
    assert.equal(
      clean.kind,
      'pass',
      clean.kind === 'pass' ? '' : clean.findings.join('; '),
    );

    writeFileSync(join(f.root, 'app.txt'), 'broken\n');
    const defectSha = f.commit('introduce defect');
    const defect = await judge(
      f.job,
      defectSha,
      f.base,
      ['check'],
      async () => {},
    );
    assert.equal(
      defect.kind,
      'fail',
      'findings' in defect ? defect.findings.join('; ') : '',
    );

    writeFileSync(
      join(f.root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { check: 'node -e "process.exit(0)"' },
      }),
    );
    const bypassSha = f.commit('bypass failing check script');
    const verdict = await judge(
      f.job,
      bypassSha,
      f.base,
      ['check'],
      async () => {},
    );

    assert.equal(verdict.kind, 'refused');
    assert.deepEqual(verdict.findings, [
      'evaluator surface changed: package.json#scripts.check',
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('judge accepts a v1 registry and a v2 registry with protected globs', async () => {
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
        checks: [
          { id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 },
        ],
        protected: ['src/**'],
      }),
    );
    mkdirSync(join(f.root, 'src'));
    writeFileSync(
      join(f.root, 'src', 'guarded.ts'),
      'export const value = 1;\n',
    );
    f.git(['add', 'src/guarded.ts', 'krn.checks.json']);
    f.git(['commit', '-qm', 'v2 registry']);
    const v2Sha = f.git(['rev-parse', 'HEAD']);
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
    f.git(['add', 'src/guarded.ts']);
    f.git(['commit', '-qm', 'change protected path']);
    const protectedSha = f.git(['rev-parse', 'HEAD']);
    const protectedVerdict = await judge(
      f.job,
      protectedSha,
      v2Sha,
      ['check'],
      async () => {},
    );
    assert.equal(protectedVerdict.kind, 'refused');
    assert.deepEqual(protectedVerdict.findings, [
      'evaluator surface changed: src/guarded.ts',
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('judge does not refuse a source-only change for surface reasons', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'app.txt'), 'broken\n');
    const sha = f.commit('source-only defect');
    const verdict = await judge(f.job, sha, f.base, ['check'], async () => {});
    assert.equal(verdict.kind, 'fail');
    assert.ok(
      verdict.kind === 'fail' &&
        verdict.findings.every(
          (finding) => !finding.startsWith('evaluator surface changed:'),
        ),
      'source-only changes must not produce evaluator-surface findings',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
