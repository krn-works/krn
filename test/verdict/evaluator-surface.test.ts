import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { judge } from '../../src/verdict/index.ts';

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
