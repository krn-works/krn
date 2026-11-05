import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runVerify } from '../../src/verify/index.ts';

const sourceRoot = process.cwd();
const files = [
  'scripts/isolation-gate.mjs',
  'scripts/test-suite.mjs',
  'scripts/test-events-reporter.mjs',
  'scripts/lib/test-shards.mjs',
  'scripts/lib/test-timings.mjs',
  'scripts/test-summary-policy.mjs',
  'scripts/probe-isolation.mjs',
  'test/helpers/isolation.ts',
];
const changedTest = 'test/live-smoke-signal.test.ts';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  base: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'krn-verify-strict-'));
  const root = join(dir, 'repo');
  await mkdir(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Verify Test']);
  git(root, ['config', 'user.email', 'verify@example.test']);
  await writeFile(join(root, 'package.json'), '{}\n');
  await writeFile(join(root, '.node-version'), `${process.version}\n`);
  for (const path of files) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(sourceRoot, path)));
  }
  await mkdir(dirname(join(root, changedTest)), { recursive: true });
  await writeFile(
    join(root, changedTest),
    "import test from 'node:test';\nimport { requiresIsolation } from './helpers/isolation.ts';\ntest('requires go', (t) => requiresIsolation(t, 'needs go', ['go']));\n",
  );
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  await writeFile(
    join(root, changedTest),
    "import test from 'node:test';\nimport { requiresIsolation } from './helpers/isolation.ts';\ntest('requires go', (t) => requiresIsolation(t, 'needs go', ['go']));\n// changed\n",
  );
  git(root, ['add', changedTest]);
  git(root, ['commit', '--quiet', '-m', 'fixture head']);
  return {
    root,
    base,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('targeted verify rejects approved isolation skips under strict CI evidence', async () => {
  const repo = await fixture();
  try {
    const result = await runVerify(
      { base: repo.base },
      {
        cwd: repo.root,
        commandRunner: (_command, args, cwd, logPath, env) => {
          const suite = args.indexOf('scripts/test-suite.mjs');
          if (suite === -1) return { exitCode: 0 };
          const run = spawnSync(process.execPath, args.slice(suite), {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, ...env, PATH: '/usr/bin:/bin' },
          });
          writeFileSync(logPath, `${run.stdout ?? ''}${run.stderr ?? ''}`);
          return { exitCode: run.status };
        },
        redFirst: async () => ({
          baseSha: repo.base,
          headSha: git(repo.root, ['rev-parse', 'HEAD']),
          contracts: [],
          results: [],
        }),
      },
    );
    const targeted = result.lines.find(({ step }) => step === 'targeted');
    assert.equal(targeted?.status, 'FAIL');
    assert.match(targeted?.detail ?? '', /strict CI evidence/u);
  } finally {
    await repo.cleanup();
  }
});

test('targeted verify passes the CI guest env only to the targeted step', async () => {
  const repo = await fixture();
  const calls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  try {
    await runVerify(
      { base: repo.base },
      {
        cwd: repo.root,
        commandRunner: (command, _args, _cwd, _logPath, env) => {
          calls.push({ command, env });
          return { exitCode: 0 };
        },
        redFirst: async () => ({
          baseSha: repo.base,
          headSha: git(repo.root, ['rev-parse', 'HEAD']),
          contracts: [],
          results: [],
        }),
      },
    );
    const targeted = calls.find(({ command }) => command === 'mise');
    assert.equal(targeted?.env?.CI, 'true');
    assert.equal(targeted?.env?.KRN_REQUIRE_ZERO_ISOLATION_SKIPS, '1');
    for (const call of calls.filter(({ command }) => command === 'npm'))
      assert.equal(call.env, undefined);
  } finally {
    await repo.cleanup();
  }
});
