import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = join(repository, 'src', 'cli', 'main.ts');
const failureMessage = 'injected internal failure';

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const result = spawnSync('git', ['init', '--quiet', path], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

async function createHook(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "import { registerHooks } from 'node:module';",
      "if (process.env.KRN_INJECT_CWD === '1') {",
      `  process.cwd = () => { throw new TypeError('${failureMessage}'); };`,
      '}',
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    const result = nextResolve(specifier, context);',
      '    const target = process.env.KRN_INJECT_MODULE;',
      `    if (target && result.url.endsWith(target)) throw new TypeError('${failureMessage}');`,
      "    if (process.env.KRN_ABORT_DELEGATE === '1' && result.url.endsWith('/src/cli/delegate.ts')) process.emit('SIGINT');",
      '    return result;',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
}

function runCli(
  hook: string,
  root: string,
  cwd: string,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, ['--import', hook, cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      KRN_HOOK_NOGIT_TMPDIR: join(root, 'hook-state'),
      ...extraEnvironment,
    },
  });
}

test('CLI distinguishes internal errors from usage and task data errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'krn-internal-error-exit-'));
  const hook = join(root, 'inject.mjs');
  const repo = join(root, 'repo');
  try {
    await createHook(hook);
    await initializeRepository(repo);

    await t.test('task usage remains 64', () => {
      const result = runCli(hook, root, repo, ['task', 'unknown']);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /unknown task verb/);
    });

    await t.test('task internal failure exits 70 and reports stderr', () => {
      const result = runCli(hook, root, repo, ['task', 'list'], {
        KRN_INJECT_CWD: '1',
      });
      assert.equal(result.status, 70, result.stderr);
      assert.equal(result.stderr, `${failureMessage}\n`);
      assert.equal(result.stdout, '');
    });

    await t.test('task JSON reports internal failure code 70', () => {
      const result = runCli(hook, root, repo, ['task', 'list', '--json'], {
        KRN_INJECT_CWD: '1',
      });
      assert.equal(result.status, 70, result.stderr);
      assert.equal(result.stderr, `${failureMessage}\n`);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        code: 70,
        error: failureMessage,
      });
    });

    await t.test('task data errors remain 65', async () => {
      const tasks = join(repo, 'tasks');
      await mkdir(tasks);
      await writeFile(join(tasks, 'invalid.json'), '{invalid');
      const result = runCli(hook, root, repo, ['task', 'check']);
      assert.equal(result.status, 65, result.stderr);
      assert.match(result.stderr, /tasks\/invalid\.json/);
      await rm(join(tasks, 'invalid.json'));
    });

    await t.test('task busy status remains 75', async () => {
      const tasks = join(repo, 'tasks');
      await mkdir(tasks, { recursive: true });
      const result = runCli(hook, root, repo, [
        'task',
        'claim',
        '--next',
        '--actor',
        'test',
      ]);
      assert.equal(result.status, 75, result.stderr);
    });

    const commandCases = [
      {
        name: 'start',
        usage: ['start', '--job', 'bad id', '--issue', 'issue'],
        internal: ['start', '--job', 'job', '--issue', 'issue'],
      },
      {
        name: 'checkpoint',
        usage: ['checkpoint'],
        internal: ['checkpoint'],
      },
      { name: 'stop', usage: ['stop'], internal: ['stop'] },
      {
        name: 'note',
        usage: ['note', '--kind', 'unknown', '--text', 'text'],
        internal: ['note'],
      },
    ];
    for (const commandCase of commandCases) {
      await t.test(`${commandCase.name} usage remains 64`, () => {
        const result = runCli(hook, root, repo, commandCase.usage);
        assert.equal(result.status, 64, result.stderr);
        assert.notEqual(result.stderr, '');
      });

      await t.test(`${commandCase.name} internal failure exits 70`, () => {
        const result = runCli(hook, root, repo, commandCase.internal, {
          KRN_INJECT_MODULE: `/src/cli/${commandCase.name}.ts`,
        });
        assert.equal(result.status, 70, result.stderr);
        assert.equal(result.stderr, `${failureMessage}\n`);
      });
    }

    await t.test('an unresolvable --base remains a usage error', () => {
      const result = runCli(hook, root, repo, [
        'start',
        '--job',
        'job',
        '--issue',
        'issue',
        '--base',
        'missing-base',
      ]);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /base ref "missing-base"/);
    });

    await t.test('delegate usage remains 64', () => {
      const result = runCli(hook, root, repo, ['delegate', '--unknown', 'x']);
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /unknown delegate option/);
    });

    await t.test('delegate path errors remain usage errors', () => {
      const result = runCli(hook, root, repo, [
        'delegate',
        '--repo',
        repo,
        '--input',
        'missing.txt',
        '--results',
        join(repo, '.krn', 'tmp', 'invalid-input'),
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

    await t.test('delegate internal failure exits 70', () => {
      const result = runCli(hook, root, repo, ['delegate'], {
        KRN_INJECT_MODULE: '/src/cli/delegate.ts',
      });
      assert.equal(result.status, 70, result.stderr);
      assert.equal(result.stderr, `${failureMessage}\n`);
    });

    await t.test('delegate abort remains 130', async () => {
      const delegateRepo = join(root, 'delegate-repo');
      await initializeRepository(delegateRepo);
      await mkdir(join(delegateRepo, '.krn', 'tmp'), { recursive: true });
      await writeFile(join(delegateRepo, '.gitignore'), '.krn/\n');
      const input = join(delegateRepo, 'input.txt');
      await writeFile(input, 'tracked test input\n');
      for (const args of [
        ['config', 'user.name', 'KRN test'],
        ['config', 'user.email', 'test@example.invalid'],
        ['add', '.gitignore', 'input.txt'],
        ['commit', '-m', 'create delegate fixture'],
      ]) {
        const result = spawnSync('git', ['-C', delegateRepo, ...args], {
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
      }
      const result = runCli(
        hook,
        root,
        delegateRepo,
        [
          'delegate',
          '--repo',
          delegateRepo,
          '--input',
          input,
          '--results',
          join(delegateRepo, '.krn', 'tmp', 'abort-case'),
          '--brief',
          'test brief',
          '--timeout-ms',
          '10000',
          '--concurrency',
          '1',
        ],
        { KRN_ABORT_DELEGATE: '1' },
      );
      assert.equal(result.status, 130, result.stderr);
      assert.match(result.stderr, /repository preflight interrupted/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
