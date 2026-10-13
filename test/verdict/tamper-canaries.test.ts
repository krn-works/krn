import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'krn-tamper-canaries-'));
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
    JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }),
  );
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 2,
      checks: [{ id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 3000 }],
      protected: ['tsconfig.json'],
    }),
  );
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(
    join(root, 'test', 'foo.test.ts'),
    "import test from 'node:test';\ntest('baseline', () => {});\n",
  );
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'check.yml'),
    'name: check\n',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const job = {
    id: 'tamper-canary',
    issue: 'R1-02',
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

async function judgeCandidate(f: ReturnType<typeof fixture>, sha: string) {
  const { judge } = await import('../../src/verdict/index.ts');
  return judge(f.job, sha, f.base, ['check'], async () => {});
}

async function surfaceChanges(f: ReturnType<typeof fixture>, sha: string) {
  const { evaluatorSurfaceChanges } = await import(
    '../../src/verdict/surface.ts'
  );
  return evaluatorSurfaceChanges(f.root, f.base, sha, ['tsconfig.json']);
}

function assertRefusedWith(finding: string) {
  return async (f: ReturnType<typeof fixture>, sha: string) => {
    const verdict = await judgeCandidate(f, sha);
    assert.equal(verdict.kind, 'refused', JSON.stringify(verdict));
    if (verdict.kind === 'refused')
      assert.deepEqual(verdict.findings, [finding]);
  };
}

test('canary 1 refuses a replacement check script', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'package.json'),
      JSON.stringify({ scripts: { check: 'true' } }),
    );
    const sha = commit(f, 'replace check script');
    await assertRefusedWith(
      'evaluator surface changed: package.json#scripts.check',
    )(f, sha);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('canary 2 refuses deletion of an existing test', async () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'test', 'foo.test.ts'));
    const sha = commit(f, 'delete existing test');
    await assertRefusedWith('evaluator surface changed: test/foo.test.ts')(
      f,
      sha,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('canary 3 refuses an edited check registry', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'krn.checks.json'),
      JSON.stringify({
        version: 2,
        checks: [
          { id: 'check', argv: ['npm', 'run', 'check'], timeoutMs: 600000 },
        ],
        protected: ['tsconfig.json'],
      }),
    );
    const sha = commit(f, 'raise check timeout');
    await assertRefusedWith('evaluator surface changed: krn.checks.json')(
      f,
      sha,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('canary 4 refuses disabling strict mode in a protected tsconfig', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    const sha = commit(f, 'disable strict mode');
    await assertRefusedWith('evaluator surface changed: tsconfig.json')(f, sha);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('canary 5 refuses a workflow edit', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, '.github', 'workflows', 'check.yml'),
      'name: check\non: workflow_dispatch\n',
    );
    const sha = commit(f, 'edit workflow');
    await assertRefusedWith(
      'evaluator surface changed: .github/workflows/check.yml',
    )(f, sha);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('canary 6 refuses each test-disabling token added to an existing test', async () => {
  const addedCases = [
    ['test', '.skip', '(', "'disabled assertion', () => {});"].join(''),
    ['test(', "'disabled assertion', ", '{ skip:', ' true }, () => {});'].join(
      '',
    ),
    ['test', '.skip ', '(', "'disabled assertion', () => {});"].join(''),
    ['test', "['", 'skip', "'](", "'disabled assertion', () => {});"].join(''),
    ['test', '["', 'todo', '"](', "'unfinished assertion');"].join(''),
    ['test', '.todo', '(', "'unfinished assertion');"].join(''),
    ['test', '.only', '(', "'selected assertion', () => {});"].join(''),
    `test.skip
('x', () => {});`,
  ];
  for (const line of addedCases) {
    const f = fixture();
    try {
      writeFileSync(
        join(f.root, 'test', 'foo.test.ts'),
        `import test from 'node:test';\ntest('baseline', () => {});\n${line}\n`,
      );
      const sha = commit(f, 'disable an existing test');
      await assertRefusedWith(
        'evaluator surface changed: test/foo.test.ts (test disabled)',
      )(f, sha);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('control allows a source change and a new passing test for surface', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(
      join(f.root, 'src', 'feature.ts'),
      'export const examples = ["test.skip (", "test[\'todo\']("];\n',
    );
    writeFileSync(
      join(f.root, 'test', 'new.test.ts'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('new passing test', () => assert.equal(1, 1));\n",
    );
    const sha = commit(f, 'add source and passing test');
    assert.deepEqual(await surfaceChanges(f, sha), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
