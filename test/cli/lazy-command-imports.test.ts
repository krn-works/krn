import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const cliEntries = [
  {
    name: 'TypeScript entry',
    path: fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)),
  },
  {
    name: 'JavaScript entry',
    path: fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url)),
  },
];
const hook = fileURLToPath(new URL('./module-load-hook.mjs', import.meta.url));
const allCommandDirectories = [
  'deliver',
  'evals',
  'flow',
  'foreman',
  'hosts',
  'ledger',
  'relay',
  'task',
  'trace',
];

test('CLI commands load only their command modules', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-module-loads-'));
  try {
    const legacy = join(directory, 'legacy.mjs');
    await writeFile(legacy, 'process.exitCode = 0;\n');
    const unavailableCache = join(directory, 'cache-file');
    await writeFile(unavailableCache, '');
    const scenarios = [
      {
        name: 'version',
        args: ['--version'],
        forbidden: allCommandDirectories,
        stdout: 'krn 0.1.0\n',
      },
      {
        name: 'version with unavailable compile cache',
        args: ['--version'],
        forbidden: allCommandDirectories,
        env: {
          NODE_COMPILE_CACHE: unavailableCache,
          NODE_DISABLE_COMPILE_CACHE: '',
        },
        stdout: 'krn 0.1.0\n',
      },
      {
        name: 'forwarding',
        args: ['legacy-module-probe'],
        forbidden: allCommandDirectories,
        env: { KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
      },
      {
        name: 'deliver help',
        args: ['deliver', '--help'],
        forbidden: allCommandDirectories.filter((name) => name !== 'deliver'),
      },
      {
        name: 'task list',
        args: ['task', 'list'],
        forbidden: ['evals', 'flow', 'foreman', 'hosts'],
      },
      {
        name: 'eval usage',
        args: ['eval', 'plan', '--json'],
        forbidden: [
          'flow',
          'foreman',
          'hosts',
          'ledger',
          'relay',
          'task',
          'trace',
        ],
        status: 64,
      },
    ];

    for (const entry of cliEntries) {
      await t.test(entry.name, async () => {
        for (const scenario of scenarios) {
          const logPath = join(
            directory,
            `${entry.name.replace(' ', '-')}-${scenario.name.replace(' ', '-')}.log`,
          );
          await writeFile(logPath, '');
          const result = spawnSync(
            process.execPath,
            ['--import', hook, entry.path, ...scenario.args],
            {
              cwd: repository,
              encoding: 'utf8',
              env: {
                ...process.env,
                KRN_MODULE_LOAD_LOG: logPath,
                ...scenario.env,
              },
            },
          );
          assert.equal(result.status, scenario.status ?? 0, result.stderr);
          if (scenario.stdout !== undefined)
            assert.equal(result.stdout, scenario.stdout);
          const loaded = (await readFile(logPath, 'utf8')).trim().split('\n');
          const forbiddenLoads = loaded.filter((path) =>
            scenario.forbidden.some((directoryName) =>
              path.includes(`/src/${directoryName}/`),
            ),
          );
          assert.deepEqual(
            forbiddenLoads,
            [],
            `${scenario.name} loaded unrelated modules`,
          );
        }
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('task list keeps its JSON output through the CLI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-task-list-'));
  try {
    const repo = join(directory, 'repo');
    const init = spawnSync('git', ['init', '--quiet', repo], {
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stderr);
    const tasks = join(repo, 'tasks');
    await mkdir(tasks);
    const task = {
      id: 'T-1',
      status: 'open',
      resolution: null,
      created: '2026-10-25',
      priority: 1,
      title: 'CLI task list',
      after: [],
      body: ['Task body'],
    };
    await writeFile(
      join(tasks, 'T-1.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    const emptyRepo = join(directory, 'empty-repo');
    const emptyInit = spawnSync('git', ['init', '--quiet', emptyRepo], {
      encoding: 'utf8',
    });
    assert.equal(emptyInit.status, 0, emptyInit.stderr);
    for (const entry of cliEntries) {
      await t.test(entry.name, () => {
        const env = {
          ...process.env,
          KRN_HOOK_NOGIT_TMPDIR: join(directory, 'hook-state'),
        };
        const result = spawnSync(
          process.execPath,
          [entry.path, 'task', 'list', '--json'],
          { cwd: repo, encoding: 'utf8', env },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          result.stdout,
          `${JSON.stringify({ ok: true, tasks: [task] }, null, 2)}\n`,
        );
        assert.equal(result.stderr, '');

        const emptyResult = spawnSync(
          process.execPath,
          [entry.path, 'task', 'list', '--json'],
          { cwd: emptyRepo, encoding: 'utf8', env },
        );
        assert.equal(emptyResult.status, 0, emptyResult.stderr);
        assert.equal(
          emptyResult.stdout,
          `${JSON.stringify({ ok: true, tasks: [] }, null, 2)}\n`,
        );
        assert.equal(emptyResult.stderr, '');
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
