import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repositoryFacts } from '../../src/brain/standards-cli.ts';

// KRN-12: the real `krn standards check` entry on generated foreign repositories.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-standards-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  assert.equal(git.status, 0);
  return root;
}

test('repositoryFacts reads the tracker, CI and remote from a real git repository', () => {
  const root = repository({ 'pyproject.toml': '[project]\nname = "p"\n' });
  try {
    const bare = repositoryFacts(root);
    assert.equal(bare.stack, 'python');
    assert.deepEqual([...bare.needs], []);
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    const added = spawnSync('git', ['remote', 'add', 'origin', root], {
      cwd: root,
    });
    assert.equal(added.status, 0);
    assert.deepEqual([...repositoryFacts(root).needs].sort(), [
      'ci',
      'remote',
      'tracker',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function check(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [cli, 'standards', 'check', '--root', root, ...args],
    { encoding: 'utf8', cwd: tmpdir() },
  );
}

const python = {
  'pyproject.toml': '[project]\nname = "probe"\nversion = "0.1.0"\n',
  'probe/__init__.py': '',
  'tests/test_probe.py': 'def test_probe():\n    assert True\n',
};

const typescript = {
  'package.json': JSON.stringify({
    name: 'probe',
    scripts: { test: 'vitest run' },
    devDependencies: { typescript: '5.0.0', vitest: '1.0.0' },
  }),
  'tsconfig.json': '{"compilerOptions": {"strict": true}}\n',
  'src/index.ts': 'export const one = 1;\n',
  'src/index.test.ts': "import { one } from './index';\n",
};

for (const [name, files, stack] of [
  ['Python', python, 'python'],
  ['TypeScript', typescript, 'node/npm'],
] as const) {
  test(`standards check prints one PASS line on a generated ${name} repository`, () => {
    const root = repository(files);
    try {
      const done = check(root);
      assert.equal(done.status, 0, done.stderr);
      assert.equal(done.stderr, '');
      const lines = done.stdout.trimEnd().split('\n');
      assert.equal(lines.length, 1);
      assert.match(
        lines[0] ?? '',
        new RegExp(
          `^PASS standards: \\d+ standards apply to .*stack ${stack.replace('/', '\\/')};`,
          'u',
        ),
      );
      const applied = Number(
        /: (\d+) standards apply/u.exec(lines[0] ?? '')?.[1],
      );
      assert.ok(applied >= 1);
      // No tracker, CI or remote here: standards that need them do not apply.
      assert.match(lines[0] ?? '', /\((\d+) of (\d+) pack/u);
      const [, inherited, total] =
        /\((\d+) of (\d+) pack/u.exec(lines[0] ?? '') ?? [];
      assert.ok(Number(inherited) < Number(total));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('standards check fails on a project standard outside its dates and names it', () => {
  const root = repository({
    ...python,
    'AGENTS.md': '# Rules\n',
    '.agents/standards.json': JSON.stringify([
      {
        id: 's-retired',
        area: 'tests',
        audience: 'worker',
        text: 'An old rule.',
        why: 'It was replaced.',
        evidence: ['AGENTS.md#Rules'],
        enforcement: { kind: 'prose', ref: 'AGENTS.md' },
        applies: { stacks: [], needs: [] },
        recorded_at: '2020-01-01',
        valid_from: '2020-01-01',
        valid_to: '2020-12-31',
      },
    ]),
  });
  try {
    const done = check(root);
    assert.equal(done.status, 1);
    assert.match(
      done.stderr,
      /\.agents\/standards\.json s-retired: outside its dates/u,
    );
    assert.match(done.stdout, /^FAIL standards: 1 problem; /u);
    assert.equal(done.stdout.trimEnd().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards check exits 65 on a malformed project file', () => {
  const root = repository({ ...python, '.agents/standards.json': '{' });
  try {
    const done = check(root);
    assert.equal(done.status, 65);
    assert.match(
      done.stdout,
      /^FAIL standards: \.agents\/standards\.json: not JSON/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards with an unknown verb or flag is a usage error', () => {
  for (const args of [
    ['standards'],
    ['standards', 'fix'],
    ['standards', 'check', '--force'],
  ]) {
    const done = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.equal(done.status, 64, args.join(' '));
    assert.match(done.stderr, /usage: krn standards check/u);
    assert.equal(done.stdout, '');
  }
});
