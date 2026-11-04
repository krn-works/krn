import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const { runVerify } = await import('../../src/verify/index.ts');
type Step = import('../../src/verify/index.ts').VerifyStep;

const OTHER_STEPS: Step[] = [
  'lint',
  'check',
  'targeted',
  'preflight',
  'diff-check',
];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

type Change = { write?: Record<string, string>; remove?: string[] };
type Options = { observers?: string[]; skipRedFirst?: boolean };

async function redFirstLine(change: Change, options: Options = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'krn-verify-code-'));
  const root = join(temp, 'repo');
  await mkdir(root);
  try {
    git(root, 'init', '--quiet');
    git(root, 'config', 'user.name', 'Verify');
    git(root, 'config', 'user.email', 'verify@example.test');
    const baseFiles: Record<string, string> = {
      'package.json': '{}\n',
      'src/a.ts': 'base\n',
      'test/a.test.ts': 'base\n',
    };
    for (const [path, body] of Object.entries(baseFiles)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), body);
    }
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    for (const [path, body] of Object.entries(change.write ?? {})) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), body);
    }
    for (const path of change.remove ?? []) git(root, 'rm', '--quiet', path);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'head');
    const head = git(root, 'rev-parse', 'HEAD');
    let runnerCalls = 0;
    const result = await runVerify(
      {
        base,
        observers: options.observers ?? [],
        skipped: options.skipRedFirst
          ? [...OTHER_STEPS, 'red-first']
          : OTHER_STEPS,
      },
      {
        cwd: root,
        commandRunner: () => ({ exitCode: 0 }),
        redFirst: async () => {
          runnerCalls += 1;
          return { baseSha: base, headSha: head, contracts: [], results: [] };
        },
      },
    );
    const red = result.lines.find((line) => line.step === 'red-first');
    assert.ok(red);
    return { status: red.status, detail: red.detail, runnerCalls };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const SKIP = ['SKIP', 'no observer test files'];

test('red-first fails an added or modified code path without an observer', async () => {
  for (const path of ['src/a.ts', 'src/new.ts', 'scripts/x.mjs', 'bin/tool']) {
    const red = await redFirstLine({ write: { [path]: 'head\n' } });
    assert.equal(red.status, 'FAIL', path);
    assert.equal(red.detail, `no observer for code change: ${path}`);
  }
});

test('non-code and deletion-only diffs keep the observer SKIP', async () => {
  const changes: Change[] = [
    { write: { 'tasks/t-x.json': '{}\n' } },
    { write: { 'docs/x.md': 'doc\n' } },
    { write: { 'README.md': 'readme\n' } },
    { write: { 'srcx/a.ts': 'head\n' } },
    { write: { 'test/src/readme.md': 'head\n' } },
    { remove: ['src/a.ts'] },
  ];
  for (const change of changes) {
    const red = await redFirstLine(change);
    assert.deepEqual([red.status, red.detail], SKIP, JSON.stringify(change));
  }
});

test('a changed test or an explicit observer lifts the code-change rule', async () => {
  const withTest = await redFirstLine({
    write: { 'src/a.ts': 'head\n', 'test/a.test.ts': 'head\n' },
  });
  assert.equal(withTest.detail.includes('no observer for code change'), false);
  const withObserver = await redFirstLine(
    { write: { 'src/a.ts': 'head\n' } },
    { observers: ['test/a.test.ts'] },
  );
  assert.equal(
    withObserver.detail.includes('no observer for code change'),
    false,
  );
});

test('--skip red-first keeps the flag SKIP and never calls the runner', async () => {
  const red = await redFirstLine(
    { write: { 'src/a.ts': 'head\n' } },
    { skipRedFirst: true },
  );
  assert.deepEqual(
    [red.status, red.detail, red.runnerCalls],
    ['SKIP', 'skipped by flag', 0],
  );
});

test('many code paths are listed with a bounded detail', async () => {
  const write: Record<string, string> = {};
  for (let index = 0; index < 7; index += 1)
    write[`src/f${index}.ts`] = 'head\n';
  const red = await redFirstLine({ write });
  assert.equal(red.status, 'FAIL');
  assert.match(red.detail, /^no observer for code change: src\/f0\.ts; /u);
  assert.match(red.detail, /\+2 more$/u);
});
