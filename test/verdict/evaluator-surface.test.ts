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
    const { evaluatorSurfaceChanges } = await import(
      '../../src/verdict/surface.ts'
    );
    assert.deepEqual(
      await evaluatorSurfaceChanges(f.root, f.base, candidateSha, []),
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
    const { evaluatorSurfaceChanges } = await import(
      '../../src/verdict/surface.ts'
    );
    assert.deepEqual(
      await evaluatorSurfaceChanges(f.root, f.base, candidateSha, []),
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
    const { evaluatorSurfaceChanges } = await import(
      '../../src/verdict/surface.ts'
    );
    assert.deepEqual(
      await evaluatorSurfaceChanges(f.root, f.base, candidateSha, []),
      [],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
