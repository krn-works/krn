import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = join(repository, 'src', 'cli', 'main.ts');

function outsideRepositoryDirectory(): string {
  const candidates = [process.env.KRN_HOOK_NOGIT_TMPDIR, '/tmp', tmpdir()];
  for (const candidate of candidates) {
    if (candidate === undefined || !existsSync(candidate)) continue;
    const path = relative(resolve(repository), resolve(candidate));
    if (
      path !== '' &&
      path !== '..' &&
      !path.startsWith(`..${sep}`) &&
      !isAbsolute(path)
    )
      continue;
    return candidate;
  }
  throw new Error('no existing directory outside the repository is available');
}

function git(repositoryPath: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '--quiet');
  git(path, 'config', 'user.name', 'KRN exit code fixture');
  git(path, 'config', 'user.email', 'exit-code@example.invalid');
  await writeFile(join(path, 'tracked.txt'), 'exit-code fixture\n');
  git(path, 'add', 'tracked.txt');
  git(path, 'commit', '-qm', 'create exit code fixture');
}

async function writeFailureHook(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "import { registerHooks } from 'node:module';",
      'const kind = process.env.KRN_ERROR_KIND;',
      'if (kind) {',
      '  process.cwd = () => {',
      "    if (kind === 'type') throw new TypeError('injected TypeError');",
      "    if (kind === 'module') { const error = new Error('injected module error'); error.code = 'ERR_MODULE_NOT_FOUND'; throw error; }",
      "    if (kind === 'syscall') { const error = new Error('injected system error'); error.syscall = 'open'; throw error; }",
      "    if (kind === 'plain') throw new Error('injected plain error');",
      "    if (kind === 'string') throw 'injected string error';",
      '  };',
      '}',
      'registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); } });',
      '',
    ].join('\n'),
  );
}

function runCli(
  hook: string,
  root: string,
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, ['--import', hook, cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      KRN_HOOK_NOGIT_TMPDIR: join(root, 'hook-state'),
      ...environment,
    },
  });
}

test('CLI classifies command failures by error kind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'krn-exit-code-classification-'));
  const hook = join(root, 'inject.mjs');
  const repo = join(root, 'repo');
  try {
    await writeFailureHook(hook);
    await initializeRepository(repo);

    await t.test('start outside a repository is usage', () => {
      const result = runCli(hook, root, outsideRepositoryDirectory(), [
        'start',
        '--job',
        'job',
        '--issue',
        'issue',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /git|repository/iu);
    });

    await t.test('unresolvable default remote ref is usage', async () => {
      const invalidRefRepo = join(root, 'invalid-default-ref');
      await initializeRepository(invalidRefRepo);
      git(
        invalidRefRepo,
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/missing',
      );
      const result = runCli(hook, root, invalidRefRepo, [
        'start',
        '--job',
        'job',
        '--issue',
        'issue',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /base ref .* does not resolve/);
    });

    await t.test(
      'worktree parent outside the repository is usage',
      async () => {
        const escapedRepo = join(root, 'escaped-worktree-parent');
        const outside = join(root, 'outside-worktrees');
        await initializeRepository(escapedRepo);
        await mkdir(join(escapedRepo, '.krn'), { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(escapedRepo, '.krn', 'worktrees'));
        const result = runCli(hook, root, escapedRepo, [
          'start',
          '--job',
          'job',
          '--issue',
          'issue',
        ]);
        assert.equal(result.status, 64, result.stderr);
        assert.match(result.stderr, /worktree parent must resolve inside/);
      },
    );

    await t.test('checkpoint rejects an unsafe session as usage', () => {
      const result = runCli(hook, root, repo, [
        'checkpoint',
        '--job',
        'job',
        '--issue',
        'issue',
        '--worktree',
        repo,
        '--message',
        'message',
        '--next',
        'next',
        '--session',
        '../x',
        '--intent',
        'intent:1',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /invalid checkpoint session id/);
    });

    await t.test('checkpoint rejects an invalid intent as usage', () => {
      const result = runCli(hook, root, repo, [
        'checkpoint',
        '--job',
        'job',
        '--issue',
        'issue',
        '--worktree',
        repo,
        '--message',
        'message',
        '--next',
        'next',
        '--session',
        'session-1',
        '--intent',
        'bad-intent',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /intent/iu);
    });

    await t.test('note rejects invalid text as usage', () => {
      const result = runCli(hook, root, repo, [
        'note',
        '--job',
        'job',
        '--issue',
        'issue',
        '--worktree',
        repo,
        '--kind',
        'intervention',
        '--text',
        'x'.repeat(201),
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /single line of at most 200 characters/);
    });

    for (const [kind, message] of [
      ['type', 'injected TypeError'],
      ['module', 'injected module error'],
      ['syscall', 'injected system error'],
      ['string', 'injected string error'],
    ]) {
      await t.test(`task JSON reports ${kind} as internal code 70`, () => {
        const result = runCli(hook, root, repo, ['task', 'list', '--json'], {
          KRN_ERROR_KIND: kind,
        });
        assert.equal(result.status, 70, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          ok: false,
          code: 70,
          error: message,
        });
      });
    }

    await t.test('task JSON treats an ordinary Error as usage code 64', () => {
      const result = runCli(hook, root, repo, ['task', 'list', '--json'], {
        KRN_ERROR_KIND: 'plain',
      });
      assert.equal(result.status, 64, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        code: 64,
        error: 'injected plain error',
      });
    });

    await t.test('delegate missing input is usage', () => {
      const result = runCli(hook, root, repo, [
        'delegate',
        '--repo',
        repo,
        '--input',
        'missing.txt',
        '--results',
        join(repo, '.krn', 'tmp', 'missing-input'),
        '--brief',
        'test brief',
        '--timeout-ms',
        '10000',
        '--concurrency',
        '1',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(
        result.stderr,
        /--input must name an existing repository file/,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
