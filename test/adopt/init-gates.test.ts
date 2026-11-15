// fast-covers: src/adopt/init.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs the real `krn adopt --init` entry on a scratch directory per stack and reads what it wrote.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

/** Per stack: the tools its skeleton installs (each must run in CI) and the source module its test imports. */
const stacks = [
  {
    stack: 'ts',
    tools: ['biome check', 'tsc --noEmit', 'npm test'],
    source: 'src/index.ts',
    import: /from '\.\.\/src\/index\.ts'/u,
    test: 'test/smoke.test.ts',
  },
  {
    stack: 'go',
    tools: ['golangci-lint', 'go vet', 'go test'],
    source: 'project.go',
    import: /Add\(1, 1\)/u,
    test: /_test\.go$/u,
  },
  {
    stack: 'rust',
    tools: ['cargo fmt', 'cargo clippy', 'cargo check', 'cargo test'],
    source: 'src/lib.rs',
    import: /^use [a-z0-9_]+::add;/mu,
    test: 'tests/smoke.rs',
  },
  {
    stack: 'python',
    tools: ['ruff', 'mypy', 'unittest'],
    source: 'app.py',
    import: /^from app import add/mu,
    test: 'tests/test_smoke.py',
  },
  {
    stack: 'php',
    tools: ['composer run lint', 'composer run typecheck', 'make test'],
    source: 'src/Math.php',
    import: /Math::add/u,
    test: 'tests/SmokeTest.php',
  },
] as const;

for (const row of stacks) {
  test(`init ${row.stack}: the contract holds real commands, CI runs every installed tool and the test imports a source module`, () => {
    const root = mkdtempSync(join(tmpdir(), 'krn-gates-'));
    const run = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--init', '--stack', row.stack, '--no-canary'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const contract = JSON.parse(
      readFileSync(join(root, 'krn.json'), 'utf8'),
    ) as Record<string, string>;
    for (const key of ['lint', 'typecheck'] as const)
      assert.ok(contract[key], `krn.json names a ${key} command`);
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const tool of row.tools)
      assert.ok(ci.includes(tool), `CI runs ${tool}`);
    for (const key of ['lint', 'typecheck'] as const)
      assert.ok(ci.includes(contract[key] ?? ''), `CI runs the ${key} command`);
    const files = spawnSync('git', ['ls-files'], {
      cwd: root,
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter(Boolean);
    assert.ok(files.includes(row.source), `${row.source} is tracked`);
    const testFile = files.find((file) =>
      typeof row.test === 'string' ? file === row.test : row.test.test(file),
    );
    assert.ok(testFile, 'the skeleton tracks a test file');
    const body = readFileSync(join(root, testFile ?? ''), 'utf8');
    assert.match(body, row.import);
    assert.doesNotMatch(body, /1 \+ 1|1\+1/u, 'the test is not a tautology');
  });
}

test('init ts: the skeleton test runs against its source module', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-gates-'));
  const made = spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--init', '--stack', 'ts', '--no-canary'],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  const tests = spawnSync('npm', ['test', '--silent'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.match(tests.stdout, /add sums two numbers/u);
});
