import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { judge } from '../../src/verdict/index.ts';

function fixture() {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'krn-npm-runtime-'));
  const git = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'sandbox-npm-runtime-fixture',
      version: '1.0.0',
      private: true,
      scripts: { probe: 'node -e "console.log(\'krn-npm-runtime-ok\')"' },
    })}\n`,
  );
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [
        { id: 'npm-runtime', argv: ['npm', 'run', 'probe'], timeoutMs: 30000 },
      ],
    }),
  );
  git(['add', '.gitignore', 'package.json', 'krn.checks.json']);
  git(['commit', '-qm', 'npm runtime fixture']);
  const base = git(['rev-parse', 'HEAD']);
  return {
    root,
    base,
    job: {
      id: 'npm-runtime',
      issue: 'LON-316',
      worktree: root,
      repoRoot: root,
    },
  };
}

test('base-declared npm check runs in the isolated runtime', async (t) => {
  // The repository runner supplies capability approval; the standalone canonical
  // observer runs the real check directly and must fail if isolation is absent.
  if (Reflect.has(globalThis, Symbol.for('krn.isolation-gate.runtime-api'))) {
    const { requiresIsolation } = await import('../helpers/isolation.ts');
    if (
      !requiresIsolation(
        t,
        'base-declared npm check runs in the isolated runtime',
        ['bwrap', 'systemdUserScope'],
      )
    )
      return;
  }
  const f = fixture();
  try {
    const result = await judge(
      f.job,
      f.base,
      f.base,
      ['npm-runtime'],
      async () => {},
    );
    const diagnostics = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const output = readdirSync(diagnostics)
      .map((name) => readFileSync(join(diagnostics, name), 'utf8'))
      .join('\n');
    assert.equal(
      result.kind,
      'pass',
      result.kind === 'pass' ? '' : result.findings.join('; '),
    );
    assert.match(output, /krn-npm-runtime-ok/u);
    assert.equal(result.checks[0]?.exitCode, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
