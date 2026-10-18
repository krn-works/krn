import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testSuite = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);
const gateLocal = fileURLToPath(
  new URL('../scripts/gate-local.mjs', import.meta.url),
);
const timeout = 30_000;

function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CI;
  delete env.NODE_OPTIONS;
  delete env.KRN_SCOPE_PROBE;
  delete env.KRN_ISOLATION_CAPABILITIES;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.KRN_FIXTURE_SUMMARY;
  delete env.KRN_FIXTURE_DIRTIES;
  delete env.KRN_GATE_RAN;
  delete env.KRN_GH_BIN;
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
  return env;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const parent = resolve(process.cwd(), '.krn/tmp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

async function makeProject(root: string, name: string): Promise<string> {
  const project = join(root, name);
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(project, '.krn'), { recursive: true });
  await writeFile(join(project, '.node-version'), '24.21.0\n');
  return project;
}

function runNode(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env,
    timeout,
  });
  assert.equal(
    result.error,
    undefined,
    `subprocess failed to start or timed out: ${result.error?.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function resultDetails(result: ReturnType<typeof runNode>): string {
  return `status=${result.status}, signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function expectRejected(result: ReturnType<typeof runNode>, scenario: string) {
  assert.equal(result.signal, null, `${scenario}: ${resultDetails(result)}`);
  assert.notEqual(result.status, 0, `${scenario}: ${resultDetails(result)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('strict wrapper requires real native test evidence for every selected file', async (t) => {
  const root = await makeTempRoot('gate-summary-evidence-');
  try {
    const cases: Array<{
      name: string;
      source?: string;
      args?: (file: string) => string[];
      accepted?: boolean;
    }> = [
      {
        name: 'a passing declared test remains accepted',
        source:
          "import { test } from 'node:test'; test('declared', () => {});\n",
        accepted: true,
      },
      {
        name: 'context skip is rejected',
        source:
          "import { test } from 'node:test'; test('context skip', (t) => t.skip('not available'));\n",
      },
      {
        name: 'option skip is rejected',
        source:
          "import { test } from 'node:test'; test('option skip', { skip: 'not available' }, () => {});\n",
      },
      {
        name: 'registration skip is rejected',
        source:
          "import { test } from 'node:test'; test.skip('registration skip', () => {});\n",
      },
      {
        name: 'context todo is rejected',
        source:
          "import { test } from 'node:test'; test('context todo', (t) => t.todo('not implemented'));\n",
      },
      {
        name: 'registration todo is rejected',
        source:
          "import { test } from 'node:test'; test.todo('registration todo', () => {});\n",
      },
      {
        name: 'skipped suite is rejected even with zero summary skipped count',
        source:
          "import { describe, test } from 'node:test'; describe.skip('suite', () => test('nested', () => {}));\n",
      },
      {
        name: 'nested skip is rejected when a sibling passes',
        source:
          "import { describe, test } from 'node:test'; describe('suite', () => { test('nested skip', { skip: true }, () => {}); test('real', () => {}); });\n",
      },
      { name: 'empty file implicit pass is rejected', source: '' },
      {
        name: 'early-exit implicit pass is rejected',
        source: 'process.exit(0);\n',
      },
      {
        name: 'fake TAP totals cannot conceal a skipped test',
        source:
          "import { test } from 'node:test'; process.stdout.write('# tests 77\\n'); test('skipped', { skip: true }, () => {});\n",
      },
      {
        name: 'runner filter arguments are rejected instead of accepting a partial run',
        source:
          "import { test } from 'node:test'; test('filtered out', () => {});\n",
        args: (file) => ['--test-name-pattern=never-matches', file],
      },
      { name: 'default selection with no test files is rejected' },
    ];

    for (const [index, scenario] of cases.entries()) {
      await t.test(scenario.name, async () => {
        const project = await makeProject(root, `case-${index}`);
        let args: string[];
        if (scenario.source !== undefined) {
          const file = join(project, 'test/fixture.test.mjs');
          await writeFile(file, scenario.source);
          args = scenario.args?.(file) ?? [file];
        } else {
          args = [];
        }
        const result = runNode(
          process.execPath,
          [testSuite, ...args],
          project,
          fixtureEnv(),
        );
        if (scenario.accepted) {
          assert.equal(result.signal, null, resultDetails(result));
          assert.equal(result.status, 0, resultDetails(result));
        } else {
          expectRejected(result, scenario.name);
        }
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scope probe discovers only project tests without recursively running them', async (t) => {
  const root = await makeTempRoot('gate-summary-scope-');
  try {
    const project = await makeProject(root, 'project');
    const nested = join(project, '.krn/worktrees/x');
    const projectMarker = join(project, '.krn/tmp/project-ran');
    const nestedMarker = join(project, '.krn/tmp/nested-ran');
    await mkdir(nested, { recursive: true });
    await mkdir(join(project, '.krn/tmp'), { recursive: true });
    await writeFile(
      join(project, 'test/a.test.mjs'),
      `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\nwriteFileSync(${JSON.stringify(projectMarker)}, 'ran');\ntest('project test', () => {});\n`,
    );
    await writeFile(
      join(nested, 'b.test.mjs'),
      `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\nwriteFileSync(${JSON.stringify(nestedMarker)}, 'ran');\ntest('nested test', () => {});\n`,
    );

    await t.test(
      'child probe emits the exact project-only discovery and runs no tests',
      async () => {
        const env = fixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(process.execPath, [testSuite], project, env);
        assert.equal(result.signal, null, resultDetails(result));
        assert.equal(result.status, 0, resultDetails(result));
        const lines =
          result.stdout.match(/^KRN_DISCOVERED(?:=|\s+)(.+)$/gmu) ?? [];
        assert.equal(lines.length, 1, resultDetails(result));
        const payload = lines[0].replace(/^KRN_DISCOVERED(?:=|\s+)/u, '');
        assert.deepEqual(JSON.parse(payload), [
          join(project, 'test/a.test.mjs'),
        ]);
        assert.equal(
          await exists(projectMarker),
          false,
          'project test executed during discovery',
        );
        assert.equal(
          await exists(nestedMarker),
          false,
          'nested worktree test executed during discovery',
        );
      },
    );

    await t.test(
      'symlink discovery escaping the project test root fails closed',
      async () => {
        const symlinkProject = await makeProject(root, 'symlink-project');
        const foreignDirectory = join(symlinkProject, '.krn/worktrees/x');
        await mkdir(foreignDirectory, { recursive: true });
        const foreignTest = join(foreignDirectory, 'foreign.test.mjs');
        await writeFile(
          foreignTest,
          "import { test } from 'node:test'; test('foreign', () => {});\n",
        );
        await symlink(
          foreignTest,
          join(symlinkProject, 'test/foreign.test.mjs'),
        );

        const env = fixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(
          process.execPath,
          [testSuite],
          symlinkProject,
          env,
        );
        expectRejected(result, 'scope symlink outside test root');
      },
    );

    await t.test('empty discovery fails closed', async () => {
      const empty = await makeProject(root, 'empty-project');
      const env = fixtureEnv();
      env.KRN_SCOPE_PROBE = '1';
      env.NODE_TEST_CONTEXT = 'child';
      const result = runNode(process.execPath, [testSuite], empty, env);
      expectRejected(result, 'empty scope discovery');
    });

    await t.test(
      'top-level probe flag without inherited test context is rejected',
      async () => {
        const env = fixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        const result = runNode(process.execPath, [testSuite], project, env);
        expectRejected(result, 'top-level scope probe');
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate-local publishes only a clean HEAD with complete structured evidence', async (t) => {
  const root = await makeTempRoot('gate-summary-publication-');
  try {
    const scenarios: Array<{
      name: string;
      dirty?: 'tracked' | 'untracked' | 'clean';
      summary?: 'missing';
      dirties?: boolean;
    }> = [
      {
        name: 'tracked changes refuse before running the gate',
        dirty: 'tracked',
      },
      {
        name: 'nonignored untracked files refuse before running the gate',
        dirty: 'untracked',
      },
      {
        name: 'clean structured-evidence control publishes exactly once',
        dirty: 'clean',
      },
      {
        name: 'legacy TAP text without structured evidence refuses publication',
        summary: 'missing',
      },
      {
        name: 'a gate that dirties the tree refuses publication',
        dirties: true,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      await t.test(scenario.name, async () => {
        const project = await makeGitFixture(root, `case-${index}`);
        const trackedFile = join(project, 'test/a.test.mjs');
        if (scenario.dirty === 'tracked')
          await writeFile(
            trackedFile,
            `${await readFile(trackedFile, 'utf8')}\n// changed\n`,
          );
        if (scenario.dirty === 'untracked')
          await writeFile(join(project, 'untracked.txt'), 'not ignored\n');

        const head = git(project, ['rev-parse', 'HEAD']).stdout.trim();
        const gateRan = join(project, '.krn/tmp/gate-ran.log');
        const ghCalls = join(project, '.krn/tmp/gh-calls.log');
        const env = fixtureEnv();
        env.KRN_GH_BIN = join(project, '.krn/tmp/fake-gh');
        env.KRN_GATE_RAN = gateRan;
        if (scenario.summary) env.KRN_FIXTURE_SUMMARY = scenario.summary;
        if (scenario.dirties) env.KRN_FIXTURE_DIRTIES = '1';

        const result = runNode(process.execPath, [gateLocal], project, env);
        if (scenario.dirty === 'clean' && !scenario.summary) {
          assert.equal(result.signal, null, resultDetails(result));
          assert.equal(result.status, 0, resultDetails(result));
          assert.equal(await exists(gateRan), true, 'clean gate was not run');
          const calls = (await readFile(ghCalls, 'utf8')).trim().split('\n');
          assert.equal(
            calls.length,
            1,
            `expected one fake gh call, got ${calls.length}`,
          );
          const call = calls[0];
          assert.ok(call);
          assert.ok(
            call.includes(`repos/krn-works/krn/statuses/${head}`),
            call,
          );
          return;
        }

        expectRejected(result, scenario.name);
        assert.equal(
          await exists(ghCalls),
          false,
          'refused gate called fake gh',
        );
        if (scenario.dirty === 'tracked' || scenario.dirty === 'untracked') {
          assert.equal(
            await exists(gateRan),
            false,
            'dirty tree was checked only after running the gate',
          );
        } else {
          assert.equal(
            await exists(gateRan),
            true,
            'expected fixture gate to run',
          );
        }
        if (scenario.dirties)
          assert.equal(await exists(join(project, 'gate-created.txt')), true);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeGitFixture(root: string, name: string): Promise<string> {
  const project = join(root, name);
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(project, '.krn/tmp'), { recursive: true });
  await writeFile(join(project, '.node-version'), '24.21.0\n');
  await writeFile(join(project, '.gitignore'), '.krn/\n');
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'strict-gate-fixture',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { gate: 'node fake-gate.mjs' },
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(project, 'test/a.test.mjs'),
    "import { test } from 'node:test'; test('fixture declaration', () => {});\n",
  );
  await writeFile(
    join(project, 'fake-gate.mjs'),
    `import { appendFileSync, writeFileSync } from 'node:fs';\nappendFileSync(process.env.KRN_GATE_RAN, 'ran\\n');\nif (process.env.KRN_FIXTURE_DIRTIES === '1') writeFileSync('gate-created.txt', 'dirty\\n');\nconst counts = { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 };\nconst summary = { version: 1, success: true, counts, files: [{ file: 'test/a.test.mjs', ...counts }] };\nconsole.log('# tests 1');\nconsole.log('Isolation-dependent tests skipped: 0');\nif (process.env.KRN_FIXTURE_SUMMARY !== 'missing') console.log('KRN_TEST_SUMMARY_JSON=' + JSON.stringify(summary));\n`,
  );
  const fakeGh = join(project, '.krn/tmp/fake-gh');
  const ghLog = join(project, '.krn/tmp/gh-calls.log');
  await writeFile(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\n`);
  await chmod(fakeGh, 0o755);

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'Gate Fixture'],
    ['config', 'user.email', 'gate-fixture@example.invalid'],
    ['config', 'gc.auto', '0'],
    ['config', 'maintenance.auto', 'false'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture base'],
  ])
    git(project, args);
  return project;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout,
  });
  assert.equal(
    result.error,
    undefined,
    `git ${args.join(' ')} failed to start or timed out: ${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}
