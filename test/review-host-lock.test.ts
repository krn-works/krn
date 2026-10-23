import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { requiresIsolation } from './helpers/isolation.ts';

const stateDirectory = join(process.cwd(), '.krn', 'tmp');

interface Fixture {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly lens: string;
  readonly fakeCodex: string;
  readonly cleanup: () => void;
}

interface RunningProcess {
  readonly child: ChildProcess;
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly getStdout: () => string;
  readonly getStderr: () => string;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(options: { readonly redFirstProbe?: boolean } = {}): Fixture {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(stateDirectory, 'review-host-lock-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');

  if (options.redFirstProbe) {
    mkdirSync(join(root, 'test'));
    writeFileSync(
      join(root, 'test', 'host-lock-probe.test.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { test } from 'node:test';",
        "test('red-first boundary probe', async () => {",
        "  writeFileSync(join(process.cwd(), '.host-lock-red-first-started'), 'started');",
        '  await new Promise((resolve) => setTimeout(resolve, 500));',
        '});',
        '',
      ].join('\n'),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'add red-first lock probe');
  }
  const head = git(root, 'rev-parse', 'HEAD');
  const lens = join(root, 'lens.txt');
  writeFileSync(lens, 'Check the requested review contract.\n');
  const fakeCodex = join(root, 'fake-codex.mjs');
  writeFileSync(
    fakeCodex,
    [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      'let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;',
      `const callFile = ${JSON.stringify(join(root, 'codex-calls.txt'))};`,
      `const startedFile = ${JSON.stringify(join(root, 'judge-started'))};`,
      `const releaseFile = ${JSON.stringify(join(root, 'judge-release'))};`,
      `const blockFirstJudge = ${JSON.stringify(options.redFirstProbe)};`,
      "const calls = existsSync(callFile) ? Number(readFileSync(callFile, 'utf8')) : 0;",
      'writeFileSync(callFile, String(calls + 1));',
      "if (blockFirstJudge && calls === 0) { writeFileSync(startedFile, 'started'); const deadline = Date.now() + 10000; while (!existsSync(releaseFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20)); }",
      "const text = JSON.stringify({ verdict: 'PASS', findings: [] });",
      "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');",
      'void prompt;',
      '',
    ].join('\n'),
  );
  chmodSync(fakeCodex, 0o700);
  return {
    root,
    base,
    head,
    lens,
    fakeCodex,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function startReview(
  target: Fixture,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): RunningProcess {
  const runner = join(target.root, 'review-runner.mjs');
  const cliUrl = new URL('../src/flow/cli.ts', import.meta.url).href;
  writeFileSync(
    runner,
    [
      `import { reviewCommand, ReviewUsageError } from ${JSON.stringify(cliUrl)};`,
      `const codexExecutable = ${JSON.stringify(target.fakeCodex)};`,
      'try { await reviewCommand(process.argv.slice(2), { codexExecutable }); }',
      "catch (error) { process.stderr.write(error instanceof Error ? error.message : String(error)); process.stderr.write('\\n'); process.exitCode = error instanceof ReviewUsageError ? 64 : 70; }",
      '',
    ].join('\n'),
  );
  const child = spawn(
    process.execPath,
    [
      runner,
      '--repo',
      target.root,
      '--base',
      target.base,
      '--head',
      target.head,
      '--lens',
      target.lens,
      '--panel',
      'standards',
      ...args,
    ],
    { cwd: target.root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout
    ?.setEncoding('utf8')
    .on('data', (chunk: string) => (stdout += chunk));
  child.stderr
    ?.setEncoding('utf8')
    .on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, getStdout: () => stdout, getStderr: () => stderr };
}

function startHolder(path: string): RunningProcess {
  const child = spawn(
    'flock',
    ['--exclusive', path, 'sh', '-c', 'echo locked; exec cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout
    ?.setEncoding('utf8')
    .on('data', (chunk: string) => (stdout += chunk));
  child.stderr
    ?.setEncoding('utf8')
    .on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function redFirstStarted(root: string): boolean {
  const temporary = join(root, '.krn', 'tmp');
  if (!existsSync(temporary)) return false;
  return readdirSync(temporary, { withFileTypes: true }).some(
    (entry) =>
      entry.isDirectory() &&
      existsSync(join(temporary, entry.name, '.host-lock-red-first-started')),
  );
}

function waitingHostLockChild(pid: number, path: string): boolean {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    return children.some((childPid) => {
      const args = readFileSync(`/proc/${childPid}/cmdline`, 'utf8');
      return args.includes('flock\0--exclusive\0') && args.includes(path);
    });
  } catch {
    return false;
  }
}

function probeLockIsFree(path: string): void {
  const result = spawnSync(
    'flock',
    ['--exclusive', '--nonblock', path, 'true'],
    { encoding: 'utf8', timeout: 1500 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('review waits for another holder before starting red-first', async (t) => {
  if (
    !requiresIsolation(
      t,
      'review waits for another holder before starting red-first',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const target = fixture({ redFirstProbe: true });
  const lockPath = join(target.root, 'host.lock');
  const holder = startHolder(lockPath);
  let review: RunningProcess | undefined;
  try {
    await waitFor(
      () => holder.getStdout().includes('locked'),
      'external lock holder did not acquire the lock',
    );
    review = startReview(target, ['--host-lock', lockPath]);
    assert.ok(review.child.pid);
    await waitFor(
      () => waitingHostLockChild(review?.child.pid ?? -1, lockPath),
      'review did not wait in a flock child while the other holder owns the lock',
      3000,
    );
    assert.equal(
      redFirstStarted(target.root),
      false,
      'red-first started before host-lock acquisition',
    );
    holder.child.stdin?.end();
    assert.equal((await holder.closed).code, 0, holder.getStderr());
    await waitFor(
      () => redFirstStarted(target.root),
      'red-first did not start after lock release',
    );
    const result = await review.closed;
    assert.equal(result.code, 0, review.getStderr());
  } finally {
    holder.child.stdin?.end();
    if (holder.child.exitCode === null && holder.child.signalCode === null)
      holder.child.kill('SIGKILL');
    if (review?.child.exitCode === null && review.child.signalCode === null) {
      review.child.kill('SIGKILL');
      await review.closed;
    }
    target.cleanup();
  }
});

test('host lock is free during the judge panel and prepass', async (t) => {
  if (
    !requiresIsolation(
      t,
      'host lock is free during the judge panel and prepass',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const target = fixture({ redFirstProbe: true });
  const lockPath = join(target.root, 'host.lock');
  const checklist = join(target.root, 'checklist.txt');
  writeFileSync(checklist, 'Check for missing acceptance evidence.\n');
  const review = startReview(target, [
    '--host-lock',
    lockPath,
    '--prepass',
    '--checklist',
    checklist,
  ]);
  try {
    await waitFor(
      () => existsSync(join(target.root, 'judge-started')),
      'prepass judge did not start',
    );
    probeLockIsFree(lockPath);
    writeFileSync(join(target.root, 'judge-release'), 'release');
    const result = await review.closed;
    assert.equal(result.code, 0, review.getStderr());
    assert.equal(
      readFileSync(join(target.root, 'codex-calls.txt'), 'utf8'),
      '2',
    );
  } finally {
    if (review.child.exitCode === null && review.child.signalCode === null) {
      review.child.kill('SIGKILL');
      await review.closed;
    }
    target.cleanup();
  }
});

test('a red-first exception releases the host lock', async () => {
  const target = fixture();
  const lockPath = join(target.root, 'host.lock');
  try {
    writeFileSync(join(target.root, '.krn'), 'not a directory');
    const review = startReview(target, ['--host-lock', lockPath]);
    const result = await review.closed;
    assert.notEqual(result.code, 0);
    assert.match(review.getStderr(), /not a directory|EEXIST|ENOTDIR/iu);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);
    probeLockIsFree(lockPath);
  } finally {
    target.cleanup();
  }
});

test('SIGKILL during red-first promptly releases the host lock', async (t) => {
  if (
    !requiresIsolation(
      t,
      'SIGKILL during red-first promptly releases the host lock',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const target = fixture({ redFirstProbe: true });
  const lockPath = join(target.root, 'host.lock');
  const review = startReview(target, ['--host-lock', lockPath]);
  try {
    await waitFor(
      () => redFirstStarted(target.root),
      'red-first did not start',
    );
    assert.equal(existsSync(lockPath), true, 'host lock file was not created');
    assert.equal(review.child.kill('SIGKILL'), true);
    assert.equal((await review.closed).signal, 'SIGKILL');
    probeLockIsFree(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    if (review.child.exitCode === null && review.child.signalCode === null) {
      review.child.kill('SIGKILL');
      await review.closed;
    }
    target.cleanup();
  }
});

test('host lock paths and override mode are validated as usage errors', async () => {
  const target = fixture();
  const unusedLock = join(target.root, 'unused.lock');
  try {
    writeFileSync(join(target.root, '.krn'), 'not a directory');
    const invalidCases: readonly {
      readonly args: readonly string[];
      readonly env?: NodeJS.ProcessEnv;
      readonly message: RegExp;
    }[] = [
      {
        args: ['--host-lock', 'relative.lock'],
        message: /--host-lock must be an absolute path/iu,
      },
      {
        args: ['--host-lock', join(target.root, 'missing-parent', 'host.lock')],
        message: /--host-lock parent must exist/iu,
      },
      {
        args: [],
        env: { ...process.env, KRN_REVIEW_HOST_LOCK: unusedLock },
        message: /KRN_REVIEW_HOST_LOCK is unsupported/iu,
      },
      {
        args: [
          '--override',
          '--host-lock',
          unusedLock,
          '--reason',
          'reason',
          '--evidence',
          'evidence',
        ],
        message: /--host-lock cannot be used with --override/iu,
      },
    ];
    for (const invalidCase of invalidCases) {
      const review = startReview(target, invalidCase.args, invalidCase.env);
      const result = await review.closed;
      assert.equal(result.code, 64, review.getStderr());
      assert.match(review.getStderr(), invalidCase.message);
    }
    assert.equal(existsSync(unusedLock), false);
  } finally {
    target.cleanup();
  }
});

test('review without --host-lock does not create a lock file', async (t) => {
  if (
    !requiresIsolation(
      t,
      'review without --host-lock does not create a lock file',
      ['systemdUserScope'],
    )
  )
    return;
  const target = fixture();
  const lockPath = join(target.root, 'host.lock');
  try {
    const review = startReview(target);
    const result = await review.closed;
    assert.equal(result.code, 0, review.getStderr());
    assert.equal(existsSync(lockPath), false);
  } finally {
    target.cleanup();
  }
});

test('missing flock refuses review before red-first starts', async () => {
  const target = fixture({ redFirstProbe: true });
  const lockPath = join(target.root, 'host.lock');
  const isolatedPath = join(target.root, 'path-without-flock');
  mkdirSync(isolatedPath);
  const gitPath = spawnSync('which', ['git'], {
    encoding: 'utf8',
  }).stdout.trim();
  assert.ok(gitPath, 'git is required to prepare the review fixture');
  symlinkSync(gitPath, join(isolatedPath, 'git'));
  try {
    const review = startReview(target, ['--host-lock', lockPath], {
      ...process.env,
      PATH: isolatedPath,
    });
    const result = await review.closed;
    assert.notEqual(result.code, 0);
    assert.match(review.getStderr(), /flock/iu);
    assert.equal(
      redFirstStarted(target.root),
      false,
      'red-first ran without the requested host lock',
    );
  } finally {
    target.cleanup();
  }
});

test('an early-exit flock holder refuses review before red-first starts', async () => {
  const target = fixture({ redFirstProbe: true });
  const lockPath = join(target.root, 'host.lock');
  const isolatedPath = join(target.root, 'path-with-early-flock');
  mkdirSync(isolatedPath);
  const gitPath = spawnSync('which', ['git'], {
    encoding: 'utf8',
  }).stdout.trim();
  assert.ok(gitPath, 'git is required to prepare the review fixture');
  symlinkSync(gitPath, join(isolatedPath, 'git'));
  const earlyFlock = join(isolatedPath, 'flock');
  writeFileSync(earlyFlock, '#!/bin/sh\nexit 42\n');
  chmodSync(earlyFlock, 0o700);
  try {
    const review = startReview(target, ['--host-lock', lockPath], {
      ...process.env,
      PATH: isolatedPath,
    });
    const result = await review.closed;
    assert.notEqual(result.code, 0);
    assert.match(
      review.getStderr(),
      /flock holder exited before release \(42\)/u,
    );
    assert.equal(
      redFirstStarted(target.root),
      false,
      'red-first ran after the flock holder exited early',
    );
  } finally {
    target.cleanup();
  }
});
