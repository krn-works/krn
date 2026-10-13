import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { judge } from '../../src/verdict/index.ts';
import { resolveChecks } from '../../src/verdict/registry.ts';

async function surfaceChanges(
  root: string,
  base: string,
  sha: string,
  globs: readonly string[],
) {
  const { evaluatorSurfaceChanges } = await import(
    '../../src/verdict/surface.ts'
  );
  return evaluatorSurfaceChanges(root, base, sha, globs);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'krn-evaluator-surface-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'gc.auto', '0']);
  git(['config', 'maintenance.auto', 'false']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { check: 'node -e "process.exit(1)"' } }),
  );
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'package.json', 'krn.checks.json']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const job = {
    id: 'surface-test',
    issue: 'R1-01',
    worktree: root,
    repoRoot: root,
  };
  return { root, git, base, job };
}

function commit(f: ReturnType<typeof fixture>, message: string) {
  f.git(['add', '-A']);
  f.git(['commit', '-qm', message]);
  return f.git(['rev-parse', 'HEAD']);
}

test('judge refuses a candidate that redefines a check script', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'package.json'),
      JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }),
    );
    const candidateSha = commit(f, 'redefine check script');
    const verdict = await judge(
      f.job,
      candidateSha,
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

test('a package manifest symlink creates an evaluator surface finding', async () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'package.json'));
    symlinkSync('missing-package-target.json', join(f.root, 'package.json'));
    const candidateSha = commit(f, 'symlink package manifest');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, []),
      ['evaluator surface changed: package.json'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an oversized package manifest creates an evaluator surface finding', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'package.json'),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );
    const candidateSha = commit(f, 'oversize package manifest');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, []),
      ['evaluator surface changed: package.json'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('judge accepts a v1 registry and a v2 registry with protected globs', async () => {
  const f = fixture();
  try {
    const { resolveRegistry } = await import('../../src/verdict/registry.ts');
    const v2 = JSON.stringify({
      version: 2,
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
      protected: ['scripts/**'],
    });
    writeFileSync(join(f.root, 'krn.checks.json'), v2);
    const candidateSha = commit(f, 'upgrade registry');
    assert.deepEqual(await resolveRegistry(f.root, candidateSha), {
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
      protected: ['scripts/**'],
    });
    assert.deepEqual(await resolveRegistry(f.root, f.base), {
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
      protected: [],
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('resolveChecks returns commands from the base registry', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'krn.checks.json'),
      JSON.stringify({
        version: 1,
        checks: [{ id: 'check', argv: ['true'], timeoutMs: 3000 }],
      }),
    );
    commit(f, 'change candidate check command');
    assert.deepEqual(await resolveChecks(f.root, f.base, ['check']), [
      { id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 },
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('judge refuses an unparsable base registry', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'krn.checks.json'), '{oops');
    const baseSha = commit(f, 'add invalid base registry');
    const verdict = await judge(
      f.job,
      baseSha,
      baseSha,
      ['check'],
      async () => {},
    );
    assert.equal(verdict.kind, 'refused');
    assert.deepEqual(verdict.checks, []);
    assert.ok(
      verdict.kind === 'refused' &&
        verdict.findings[0]?.startsWith('invalid base registry:'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('judge does not refuse a source-only change for surface reasons', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(
      join(f.root, 'src', 'feature.ts'),
      'export const value = 1;\n',
    );
    const candidateSha = commit(f, 'add source');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, []),
      [],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('deleting a test with an accented name creates an evaluator surface finding', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'test'));
    const testPath = join(f.root, 'test', 'zażółć.test.ts');
    writeFileSync(testPath, 'export {};\n');
    const accentedBase = commit(f, 'add accented test');
    rmSync(testPath);
    const candidateSha = commit(f, 'delete accented test');
    assert.deepEqual(
      await surfaceChanges(f.root, accentedBase, candidateSha, []),
      ['evaluator surface changed: test/zażółć.test.ts'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('modifying an existing test creates an evaluator surface finding', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'test'));
    const testPath = join(f.root, 'test', 'foo.test.ts');
    writeFileSync(testPath, 'export const before = true;\n');
    const testBase = commit(f, 'add existing test');
    writeFileSync(testPath, 'export const after = true;\n');
    const candidateSha = commit(f, 'modify existing test');
    assert.deepEqual(
      await surfaceChanges(f.root, testBase, candidateSha, []),
      ['evaluator surface changed: test/foo.test.ts'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adding a new test does not create a test surface finding', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'tests'));
    writeFileSync(join(f.root, 'tests', 'new.spec.ts'), 'export {};\n');
    const candidateSha = commit(f, 'add new test');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, []),
      [],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adding a root npmrc creates an evaluator surface finding', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.npmrc'), 'ignore-scripts=true\n');
    const candidateSha = commit(f, 'add npmrc');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, []),
      ['evaluator surface changed: .npmrc'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('protected **/ globs match root and nested files', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'a', 'b'), { recursive: true });
    writeFileSync(join(f.root, 'foo.ts'), 'export const before = 1;\n');
    writeFileSync(
      join(f.root, 'a', 'b', 'foo.ts'),
      'export const before = 1;\n',
    );
    const globBase = commit(f, 'add files for protected glob');
    writeFileSync(join(f.root, 'foo.ts'), 'export const after = 1;\n');
    writeFileSync(
      join(f.root, 'a', 'b', 'foo.ts'),
      'export const after = 1;\n',
    );
    const candidateSha = commit(f, 'modify protected files');
    assert.deepEqual(
      await surfaceChanges(f.root, globBase, candidateSha, ['**/foo.ts']),
      [
        'evaluator surface changed: a/b/foo.ts',
        'evaluator surface changed: foo.ts',
      ],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('protected trailing /** globs match files under the prefix', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'test'));
    writeFileSync(join(f.root, 'test', 'x.ts'), 'export {};\n');
    const candidateSha = commit(f, 'add protected test file');
    assert.deepEqual(
      await surfaceChanges(f.root, f.base, candidateSha, ['test/**']),
      ['evaluator surface changed: test/x.ts'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
