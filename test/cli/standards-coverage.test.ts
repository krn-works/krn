import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12/14: every record the coverage pack added or converted from advisory is run by the real
// `krn standards check --record` entry on a repository that violates it (red) and on the plainest
// repository that follows it (green). The plainest hand-written violation is the input.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

type Files = Record<string, string>;

function repository(files: Files, commits: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-coverage-'));
  const run = (...args: string[]) => {
    const done = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  for (const message of commits)
    run(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-qm',
      message,
    );
  return root;
}

function verdict(id: string, files: Files, commits: string[] = []): number {
  const root = repository(files, commits);
  try {
    const done = spawnSync(
      process.execPath,
      [cli, 'standards', 'check', '--root', root, '--record', id],
      { encoding: 'utf8', cwd: tmpdir() },
    );
    assert.doesNotMatch(
      done.stdout + done.stderr,
      /not found/u,
      `${id} must apply to its fixture`,
    );
    return done.status ?? -1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'probe', scripts: { test: 'vitest run' }, ...extra });
const node: Files = {
  'package.json': pkg(),
  'src/index.ts': 'export const one = 1;\n',
};
const py: Files = {
  'pyproject.toml': '[project]\nname = "probe"\n',
  'probe/__init__.py': 'ONE = 1\n',
};
const tracked: Files = { ...node, 'krn.json': '{"tracker":"krn"}\n' };

type Case = {
  id: string;
  base: Files;
  red: Files;
  green: Files;
  commits?: [red: string[], green: string[]];
};

const cases: Case[] = [
  {
    id: 's-no-private-key-tracked',
    base: node,
    red: {
      'deploy/key.txt':
        '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n',
    },
    green: {
      'src/detect.ts': "export const header = '-----BEGIN PRIVATE KEY-----';\n",
    },
  },
  {
    id: 's-ts-no-any',
    base: node,
    red: { 'src/index.ts': 'export function f(x: any) {\n  return x;\n}\n' },
    green: {
      'src/index.ts':
        'export function f(x: unknown) {\n  // note: any value is fine\n  return x;\n}\n',
    },
  },
  {
    id: 's-ts-no-suppressions',
    base: node,
    red: {
      'src/index.ts': `// @ts-${'ignore'}\nexport const one: string = 1;\n`,
    },
    green: {
      'src/index.ts': `// @ts-${'expect-error'} the value is a number by design\nexport const one: string = 1;\n`,
    },
  },
  {
    id: 's-ts-no-star-reexport',
    base: node,
    red: { 'src/barrel.ts': "export * from './index';\n" },
    green: {
      'src/barrel.ts':
        "export { one } from './index';\nexport * as everything from './index';\n",
    },
  },
  {
    id: 's-no-deep-relative-imports',
    base: node,
    red: {
      'src/a/b/c/d/deep.ts':
        "import { one } from '../../../../index';\nexport const two = one;\n",
    },
    green: {
      'src/a/b/c/shallow.ts':
        "import { one } from '../../../index';\nexport const two = one;\n",
      'test/a/b/c/d/mirror.test.ts':
        "import { one } from '../../../../../src/index';\nexport const two = one;\n",
    },
  },
  {
    id: 's-node-no-empty-catch',
    base: node,
    red: {
      'src/index.ts': 'export function f() {\n  try { g(); } catch (e) {}\n}\n',
    },
    green: {
      'src/index.ts':
        'export function f() {\n  try { g(); } catch (e) { throw e; }\n}\n',
    },
  },
  {
    id: 's-node-no-empty-catch',
    base: node,
    red: { 'src/index.ts': 'run().catch(() => {});\n' },
    green: { 'src/index.ts': 'run().catch((e) => { report(e); });\n' },
  },
  {
    id: 's-py-no-bare-except',
    base: py,
    red: { 'probe/io.py': 'try:\n    x = 1\nexcept:\n    pass\n' },
    green: { 'probe/io.py': 'try:\n    x = 1\nexcept ValueError:\n    pass\n' },
  },
  {
    id: 's-py-no-mutable-default',
    base: py,
    red: {
      'probe/io.py':
        'def add(item, bucket=[]):\n    bucket.append(item)\n    return bucket\n',
    },
    green: {
      'probe/io.py':
        'def add(item, bucket=None):\n    bucket = [] if bucket is None else bucket\n    return bucket\n',
    },
  },
  {
    id: 's-py-no-unsafe-execution',
    base: py,
    red: {
      'probe/run.py': 'import subprocess\n\nsubprocess.run(cmd, shell=True)\n',
    },
    green: {
      'probe/run.py':
        'import ast\nimport subprocess\n\nsubprocess.run(["ls"])\nast.literal_eval("1")\n',
      'tests/test_run.py': 'result = eval("1")\n',
    },
  },
  {
    id: 's-node-no-dynamic-code',
    base: node,
    red: { 'src/index.ts': 'export const run = (s: string) => eval(s);\n' },
    green: {
      'src/index.ts': 'export const run = (s: string) => JSON.parse(s);\n',
    },
  },
  {
    id: 's-no-wildcard-dependencies',
    base: node,
    red: { 'package.json': pkg({ dependencies: { left: '*' } }) },
    green: { 'package.json': pkg({ dependencies: { left: '^1.2.0' } }) },
  },
  {
    id: 's-no-wildcard-dependencies',
    base: { 'composer.json': '{"name":"a/b"}\n' },
    red: { 'composer.json': '{"name":"a/b","require":{"x/y":"dev-master"}}\n' },
    green: { 'composer.json': '{"name":"a/b","require":{"x/y":"^2.0"}}\n' },
  },
  {
    id: 's-release-notes',
    base: node,
    red: { 'package.json': pkg({ version: '1.2.0' }) },
    green: {
      'package.json': pkg({ version: '1.2.0' }),
      'CHANGELOG.md': '# Changelog\n\n## 1.2.0\n',
    },
  },
  {
    id: 's-task-states-proof',
    base: tracked,
    red: {
      'tasks/t-aaaaaaa.json': JSON.stringify({
        id: 't-aaaaaaa',
        status: 'open',
        body: ['Do the thing.'],
      }),
    },
    green: {
      'tasks/t-aaaaaaa.json': JSON.stringify({
        id: 't-aaaaaaa',
        status: 'open',
        body: ['Do the thing. Proof: the test passes.'],
      }),
      'tasks/t-bbbbbbb.json': JSON.stringify({
        id: 't-bbbbbbb',
        status: 'closed',
        body: ['Done.'],
      }),
    },
  },
  {
    id: 's-no-shared-stash',
    base: node,
    red: { 'scripts.sh': 'git stash\nmake test\ngit stash pop\n' },
    green: { 'scripts.sh': 'git stash list\ngit commit -am wip\n' },
  },
  {
    id: 's-secrets-redacted',
    base: node,
    red: {
      'src/index.ts':
        'export const f = (password: string) => console.log(password);\n',
    },
    green: {
      'src/index.ts':
        'export const f = () => console.log("password required");\n',
    },
  },
  {
    id: 's-exit-codes',
    base: node,
    red: { 'src/index.ts': 'try { go(); } catch (e) { process.exit(0); }\n' },
    green: {
      'src/index.ts': 'try { go(); } catch (e) { process.exit(70); }\n',
    },
  },
  {
    id: 's-role-names',
    base: node,
    red: { 'src/phase2-parser.ts': 'export const p = 1;\n' },
    green: {
      'src/parser.ts': 'export const p = 1;\n',
      'docs/2026-11-15-adr.md': '# adr\n',
    },
  },
  {
    id: 's-role-names',
    base: node,
    red: { 'src/t-1abc23x-fix.ts': 'export const p = 1;\n' },
    green: { 'src/parser.ts': 'export const p = 1;\n' },
  },
  {
    id: 's-ticket-trailer',
    base: tracked,
    red: {},
    green: {
      'tasks/t-aaaaaaa.json':
        '{"id":"t-aaaaaaa","status":"open","body":["Proof: x"]}',
    },
    commits: [
      ['chore: adopt krn', 'feat(x): add y (t-zzzzzzz)\n\nRefs: t-zzzzzzz'],
      ['chore: adopt krn', 'feat(x): add y (t-aaaaaaa)\n\nRefs: t-aaaaaaa'],
    ],
  },
];

for (const [index, c] of cases.entries()) {
  test(`${c.id} fails on its plainest violation and passes on the plainest compliant repository (case ${index + 1})`, () => {
    assert.equal(verdict(c.id, { ...c.base }), 0, 'the base repository holds');
    assert.equal(
      verdict(c.id, { ...c.base, ...c.red }, c.commits?.[0]),
      1,
      'the violation fails',
    );
    assert.equal(
      verdict(c.id, { ...c.base, ...c.green }, c.commits?.[1]),
      0,
      'the compliant repository holds',
    );
  });
}

test('s-ticket-trailer ignores a commit that names no task and a repository with no history', () => {
  assert.equal(verdict('s-ticket-trailer', tracked), 0);
  assert.equal(verdict('s-ticket-trailer', tracked, ['chore: tidy']), 0);
});
