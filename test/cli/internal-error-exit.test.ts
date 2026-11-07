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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
