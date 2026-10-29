import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testSuite = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);
const gateLocal = fileURLToPath(
  new URL('../scripts/gate-local.mjs', import.meta.url),
);
const timeout = 30_000;
const gitContextKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
] as const;

function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CI;
  delete env.NODE_OPTIONS;
  delete env.KRN_SCOPE_PROBE;
  delete env.KRN_ISOLATION_CAPABILITIES;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.KRN_FIXTURE_SUMMARY;
  delete env.KRN_FIXTURE_TAP_TESTS;
  delete env.KRN_FIXTURE_DIRTIES;
  delete env.KRN_GATE_RAN;
  delete env.KRN_GH_BIN;
  delete env.KRN_GATE_GIT_CONTEXT_LOG;
  for (const key of gitContextKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
  return env;
}

function nonStrictFixtureEnv(): NodeJS.ProcessEnv {
  const env = fixtureEnv();
  delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  return env;
}

const summaryPrefix = 'KRN_TEST_SUMMARY_JSON=';

type StrictFixtureSummary = {
  success: boolean;
  counts: { tests: number };
};

function isStrictFixtureSummary(value: unknown): value is StrictFixtureSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof value.success === 'boolean' &&
    'counts' in value &&
    typeof value.counts === 'object' &&
    value.counts !== null &&
    'tests' in value.counts &&
    typeof value.counts.tests === 'number'
  );
}

function strictSummary(result: ReturnType<typeof runNode>, scenario: string) {
  const lines = result.stdout.match(/^KRN_TEST_SUMMARY_JSON=.*$/gmu) ?? [];
  assert.equal(lines.length, 1, `${scenario}: ${resultDetails(result)}`);
  const line = lines[0];
  assert.ok(line, `${scenario}: missing structured summary`);
  assert.equal(
    result.stdout.trimEnd().split(/\r?\n/u).at(-1),
    line,
    `${scenario}: structured summary is not the final output line`,
  );
  const summary: unknown = JSON.parse(line.slice(summaryPrefix.length));
  assert.ok(isStrictFixtureSummary(summary), `${scenario}: malformed summary`);
  return summary;
}

function expectStrictRejected(
  result: ReturnType<typeof runNode>,
  scenario: string,
  category: 'evidence' | 'wrapper',
) {
  expectRejected(result, scenario);
  assert.equal(
    strictSummary(result, scenario).success,
    false,
    resultDetails(result),
  );
  const reasonCategory =
    category === 'evidence'
      ? /^Strict test evidence rejected:/mu
      : /^Test suite wrapper failed:/mu;
  assert.match(
    result.stderr,
    reasonCategory,
    `${scenario}: wrong rejection category\n${resultDetails(result)}`,
  );
}

function expectStrictAccepted(
  result: ReturnType<typeof runNode>,
  scenario: string,
) {
  assert.equal(result.signal, null, `${scenario}: ${resultDetails(result)}`);
  assert.equal(result.status, 0, `${scenario}: ${resultDetails(result)}`);
  const summary = strictSummary(result, scenario);
  assert.equal(summary.success, true, resultDetails(result));
  return summary;
}

function expectNonStrictProbeRejected(
  result: ReturnType<typeof runNode>,
  scenario: string,
) {
  expectRejected(result, scenario);
  assert.doesNotMatch(
    result.stdout,
    /^KRN_DISCOVERED=/mu,
    resultDetails(result),
  );
  assert.doesNotMatch(
    result.stdout,
    /^KRN_TEST_SUMMARY_JSON=/mu,
    resultDetails(result),
  );
  assert.match(
    result.stderr,
    /^Test suite wrapper failed:/mu,
    resultDetails(result),
  );
}

async function assertNoOwnedEventDirectories(project: string): Promise<void> {
  const entries = await readdir(join(project, '.krn/tmp'));
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith('strict-test-events-')),
    [],
    'strict event temp directories were not cleaned',
  );
}

async function makeTempRoot(prefix: string): Promise<string> {
  const parent = resolve(process.cwd(), '.krn/tmp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

async function makeProject(root: string, name: string): Promise<string> {
  const project = join(root, name);
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(project, '.krn/tmp'), { recursive: true });
  const nodeVersion = await readFile(
    join(process.cwd(), '.node-version'),
    'utf8',
  );
  await writeFile(join(project, '.node-version'), nodeVersion);
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
      rejection?: 'evidence' | 'wrapper';
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
        rejection: 'evidence',
      },
      {
        name: 'option skip is rejected',
        source:
          "import { test } from 'node:test'; test('option skip', { skip: 'not available' }, () => {});\n",
        rejection: 'evidence',
      },
      {
        name: 'registration skip is rejected',
        source:
          "import { test } from 'node:test'; test.skip('registration skip', () => {});\n",
        rejection: 'evidence',
      },
      {
        name: 'context todo is rejected',
        source:
          "import { test } from 'node:test'; test('context todo', (t) => t.todo('not implemented'));\n",
        rejection: 'evidence',
      },
      {
        name: 'registration todo is rejected',
        source:
          "import { test } from 'node:test'; test.todo('registration todo', () => {});\n",
        rejection: 'evidence',
      },
      {
        name: 'skipped suite is rejected even with zero summary skipped count',
        source:
          "import { describe, test } from 'node:test'; describe.skip('suite', () => test('nested', () => {}));\n",
        rejection: 'evidence',
      },
      {
        name: 'nested skip is rejected when a sibling passes',
        source:
          "import { describe, test } from 'node:test'; describe('suite', () => { test('nested skip', { skip: true }, () => {}); test('real', () => {}); });\n",
        rejection: 'evidence',
      },
      {
        name: 'empty file implicit pass is rejected',
        source: '',
        rejection: 'evidence',
      },
      {
        name: 'early-exit implicit pass is rejected',
        source: 'process.exit(0);\n',
        rejection: 'evidence',
      },
      {
        name: 'fake TAP totals cannot conceal a skipped test',
        source:
          "import { test } from 'node:test'; process.stdout.write('# tests 77\\n'); test('skipped', { skip: true }, () => {});\n",
        rejection: 'evidence',
      },
      {
        name: 'runner filter arguments are rejected instead of accepting a partial run',
        source:
          "import { test } from 'node:test'; test('filtered out', () => {});\n",
        args: (file) => ['--test-name-pattern=never-matches', file],
        rejection: 'wrapper',
      },
      {
        name: 'default selection with no test files is rejected',
        rejection: 'wrapper',
      },
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
          expectStrictAccepted(result, scenario.name);
        } else {
          const rejection = scenario.rejection;
          assert.ok(rejection);
          expectStrictRejected(result, scenario.name, rejection);
        }
        await assertNoOwnedEventDirectories(project);
      });
    }

    await t.test(
      'strict runner scrubs inherited NODE_TEST_CONTEXT and still runs the selected test',
      async () => {
        const project = await makeProject(root, 'inherited-context');
        const marker = join(project, '.krn/tmp/ran');
        const file = join(project, 'test/a.test.mjs');
        await writeFile(
          file,
          `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('declared', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`,
        );
        const env = fixtureEnv();
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(
          process.execPath,
          [testSuite, file],
          project,
          env,
        );
        const summary = expectStrictAccepted(result, 'scrubbed test context');
        assert.equal(summary.counts.tests, 1);
        assert.equal(await exists(marker), true);
        await assertNoOwnedEventDirectories(project);
      },
    );

    await t.test(
      'strict probe with inherited context refuses without discovery or execution',
      async () => {
        const project = await makeProject(root, 'strict-probe-context');
        const marker = join(project, '.krn/tmp/ran');
        await writeFile(
          join(project, 'test/a.test.mjs'),
          `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('declared', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`,
        );
        const env = fixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(process.execPath, [testSuite], project, env);
        expectStrictRejected(
          result,
          'strict probe with inherited context',
          'wrapper',
        );
        assert.doesNotMatch(result.stdout, /^KRN_DISCOVERED=/mu);
        assert.equal(await exists(marker), false);
        await assertNoOwnedEventDirectories(project);
      },
    );

    await t.test(
      'strict parent and non-strict nested probe discover without recursion',
      async () => {
        const project = await makeProject(root, 'nested-probe-chain');
        const marker = join(project, '.krn/tmp/runs.log');
        const file = join(project, 'test/a.test.mjs');
        const source = [
          "import assert from 'node:assert/strict';",
          "import { appendFileSync } from 'node:fs';",
          "import { spawnSync } from 'node:child_process';",
          "import { test } from 'node:test';",
          "test('nested probe is discovery-only', () => {",
          String.raw`  appendFileSync(${JSON.stringify(marker)}, 'run\n');`,
          '  assert.ok(process.env.NODE_TEST_CONTEXT);',
          '  assert.equal(process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS, undefined);',
          `  const probe = spawnSync(process.execPath, [${JSON.stringify(testSuite)}], { cwd: ${JSON.stringify(project)}, encoding: 'utf8', timeout: 10000, env: { ...process.env, KRN_SCOPE_PROBE: '1' } });`,
          '  assert.equal(probe.error, undefined, probe.stderr);',
          "  assert.equal(probe.status, 0, [probe.stdout, probe.stderr].join('\\n'));",
          '  assert.match(probe.stdout, /^KRN_DISCOVERED=/mu);',
          '  assert.doesNotMatch(probe.stdout, /^KRN_TEST_SUMMARY_JSON=/mu);',
          '});',
        ].join('\n');
        await writeFile(file, source);
        const result = runNode(
          process.execPath,
          [testSuite, file],
          project,
          fixtureEnv(),
        );
        expectStrictAccepted(result, 'nested discovery chain');
        assert.equal(await readFile(marker, 'utf8'), 'run\n');
        await assertNoOwnedEventDirectories(project);
      },
    );
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

    const symlinkRootProject = await makeProject(root, 'symlink-root-project');
    const symlinkTarget = join(symlinkRootProject, '.krn/worktrees/x');
    const symlinkMarker = join(symlinkRootProject, '.krn/tmp/foreign-ran');
    await mkdir(symlinkTarget, { recursive: true });
    await writeFile(
      join(symlinkTarget, 'foreign.test.mjs'),
      `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\nwriteFileSync(${JSON.stringify(symlinkMarker)}, 'ran');\ntest('foreign', () => {});\n`,
    );
    await rm(join(symlinkRootProject, 'test'), { recursive: true });
    await symlink(symlinkTarget, join(symlinkRootProject, 'test'), 'dir');

    await t.test(
      'child probe emits the exact project-only discovery and runs no tests',
      async () => {
        const env = nonStrictFixtureEnv();
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
        assert.doesNotMatch(result.stdout, /^KRN_TEST_SUMMARY_JSON=/mu);
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

        const env = nonStrictFixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(
          process.execPath,
          [testSuite],
          symlinkProject,
          env,
        );
        expectNonStrictProbeRejected(result, 'scope symlink outside test root');
      },
    );

    await t.test(
      'non-strict probe refuses a symlinked project test root',
      async () => {
        const env = nonStrictFixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        env.NODE_TEST_CONTEXT = 'child';
        const result = runNode(
          process.execPath,
          [testSuite],
          symlinkRootProject,
          env,
        );
        expectNonStrictProbeRejected(
          result,
          'symlinked project test root probe',
        );
        assert.equal(await exists(symlinkMarker), false);
      },
    );

    await t.test(
      'strict default selection refuses a symlinked project test root',
      async () => {
        const result = runNode(
          process.execPath,
          [testSuite],
          symlinkRootProject,
          fixtureEnv(),
        );
        expectStrictRejected(
          result,
          'symlinked project test root strict run',
          'wrapper',
        );
        assert.equal(await exists(symlinkMarker), false);
        await assertNoOwnedEventDirectories(symlinkRootProject);
      },
    );

    await t.test('empty discovery fails closed', async () => {
      const empty = await makeProject(root, 'empty-project');
      const env = nonStrictFixtureEnv();
      env.KRN_SCOPE_PROBE = '1';
      env.NODE_TEST_CONTEXT = 'child';
      const result = runNode(process.execPath, [testSuite], empty, env);
      expectNonStrictProbeRejected(result, 'empty scope discovery');
    });

    await t.test(
      'strict probe flag is refused without inherited test context',
      async () => {
        const env = fixtureEnv();
        env.KRN_SCOPE_PROBE = '1';
        const result = runNode(process.execPath, [testSuite], project, env);
        expectStrictRejected(result, 'top-level strict scope probe', 'wrapper');
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
      summary?: 'missing' | 'skip' | 'isolation-skip' | 'malformed-last';
      tapCount?: number;
      dirties?: boolean;
      movesHead?: boolean;
      fails?: boolean;
      gitRedirect?: 'hide-dirty' | 'foreign-head';
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
        tapCount: 99,
      },
      {
        name: 'legacy TAP text without structured evidence refuses publication',
        summary: 'missing',
      },
      {
        name: 'coherent structured skip summary refuses publication',
        summary: 'skip',
      },
      {
        name: 'an isolation skip refuses despite otherwise successful structured evidence',
        summary: 'isolation-skip',
      },
      {
        name: 'malformed last summary overrides earlier valid summary',
        summary: 'malformed-last',
      },
      {
        name: 'a gate that dirties the tree refuses publication',
        dirties: true,
      },
      {
        name: 'a gate that moves HEAD refuses publication',
        movesHead: true,
      },
      {
        name: 'a failed test refuses publication despite valid summary text',
        fails: true,
      },
      {
        name: 'Git redirection cannot hide actual checkout dirt',
        dirty: 'untracked',
        gitRedirect: 'hide-dirty',
      },
      {
        name: 'clean publication uses actual HEAD and removes Git context from gate',
        dirty: 'clean',
        tapCount: 99,
        gitRedirect: 'foreign-head',
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

        let foreignProject: string | undefined;
        if (scenario.gitRedirect) {
          foreignProject = await makeGitFixture(root, `foreign-${index}`);
          assert.ok(foreignProject);
          if (scenario.gitRedirect === 'foreign-head') {
            await writeFile(
              join(foreignProject, 'foreign-only.txt'),
              'foreign\n',
            );
            git(foreignProject, ['add', '-A']);
            git(foreignProject, ['commit', '--quiet', '-m', 'foreign head']);
          }
          assert.equal(
            git(foreignProject, [
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
            ]).stdout,
            '',
            'foreign repository must be clean before redirection',
          );
        }

        const head = git(project, ['rev-parse', 'HEAD']).stdout.trim();
        const foreignHead = foreignProject
          ? git(foreignProject, ['rev-parse', 'HEAD']).stdout.trim()
          : undefined;
        if (scenario.gitRedirect === 'foreign-head') {
          assert.ok(foreignHead);
          assert.notEqual(head, foreignHead);
        }
        const gateRan = join(project, '.krn/tmp/gate-ran.log');
        const ghCalls = join(project, '.krn/tmp/gh-calls.log');
        const gitContextLog = join(project, '.krn/tmp/gate-git-context.json');
        const env = fixtureEnv();
        env.PATH = `${join(project, '.krn/tmp/bin')}${delimiter}${env.PATH ?? ''}`;
        env.KRN_GH_BIN = join(project, '.krn/tmp/fake-gh');
        env.KRN_GATE_RAN = gateRan;
        env.KRN_GATE_GIT_CONTEXT_LOG = gitContextLog;
        if (foreignProject) {
          env.GIT_DIR = join(foreignProject, '.git');
          env.GIT_WORK_TREE = foreignProject;
          env.GIT_INDEX_FILE = join(foreignProject, '.git/index');
        }
        if (scenario.summary) env.KRN_FIXTURE_SUMMARY = scenario.summary;
        if (scenario.tapCount)
          env.KRN_FIXTURE_TAP_TESTS = String(scenario.tapCount);
        if (scenario.dirties) env.KRN_FIXTURE_DIRTIES = '1';
        if (scenario.movesHead) env.KRN_FIXTURE_MOVES_HEAD = '1';
        if (scenario.fails) env.KRN_FIXTURE_FAILS = '1';

        const result = runNode(process.execPath, [gateLocal], project, env);
        if (scenario.dirty === 'clean' && !scenario.summary) {
          assert.equal(result.signal, null, resultDetails(result));
          assert.equal(result.status, 0, resultDetails(result));
          assert.equal(await exists(gateRan), true, 'clean gate was not run');
          assert.equal(
            await readFile(gateRan, 'utf8'),
            'preflight\nisolation\n',
            'local gate must run preflight before the isolation tests',
          );
          const calls = (await readFile(ghCalls, 'utf8')).trim().split('\n');
          assert.equal(
            calls.length,
            1,
            `expected one fake gh call, got ${calls.length}`,
          );
          const call = calls[0];
          assert.ok(call);
          if (scenario.gitRedirect === 'foreign-head') {
            assert.deepEqual(
              {
                statusUsesActualHead: call.includes(
                  `repos/krn-works/krn/statuses/${head}`,
                ),
                gateGitContext: JSON.parse(
                  await readFile(gitContextLog, 'utf8'),
                ),
              },
              { statusUsesActualHead: true, gateGitContext: [] },
              call,
            );
          } else {
            assert.ok(
              call.includes(`repos/krn-works/krn/statuses/${head}`),
              call,
            );
          }
          assert.ok(
            call.includes(
              'description=Gate passed: 1 tests, 0 isolation skips',
            ),
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
  const nodeVersion = await readFile(
    join(process.cwd(), '.node-version'),
    'utf8',
  );
  await writeFile(join(project, '.node-version'), nodeVersion);
  await writeFile(join(project, '.gitignore'), '.krn/\n');
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'strict-gate-fixture',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          gate: 'node fake-gate.mjs full',
          preflight: 'node fake-gate.mjs preflight',
          test: 'node fake-gate.mjs isolation',
        },
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(project, 'test/a.test.mjs'),
    "import './helpers/isolation.ts';\nimport { test } from 'node:test'; test('fixture declaration', () => {});\n",
  );
  await writeFile(
    join(project, 'fake-gate.mjs'),
    `import { appendFileSync, writeFileSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nappendFileSync(process.env.KRN_GATE_RAN, process.argv[2] + '\\n');\nif (process.argv[2] === 'preflight') process.exit(0);\nwriteFileSync(process.env.KRN_GATE_GIT_CONTEXT_LOG, JSON.stringify(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'].filter((key) => process.env[key] !== undefined)));\nif (process.env.KRN_FIXTURE_DIRTIES === '1') writeFileSync('gate-created.txt', 'dirty\\n');\nif (process.env.KRN_FIXTURE_MOVES_HEAD === '1') execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'fixture moved head']);\nconst skipped = process.env.KRN_FIXTURE_SUMMARY === 'skip';\nconst counts = { tests: 1, passed: skipped ? 0 : 1, failed: 0, skipped: skipped ? 1 : 0, todo: 0, cancelled: 0 };\nconst summary = { version: 1, success: true, counts, files: [{ file: 'test/a.test.mjs', ...counts }] };\nconsole.log('# tests ' + (process.env.KRN_FIXTURE_TAP_TESTS || counts.tests));\nconsole.log('Isolation-dependent tests skipped: ' + (skipped || process.env.KRN_FIXTURE_SUMMARY === 'isolation-skip' ? 1 : 0));\nif (process.env.KRN_FIXTURE_SUMMARY !== 'missing') { console.log('KRN_TEST_SUMMARY_JSON=' + JSON.stringify(summary)); if (process.env.KRN_FIXTURE_SUMMARY === 'malformed-last') console.log('KRN_TEST_SUMMARY_JSON={malformed'); }\nif (process.env.KRN_FIXTURE_FAILS === '1') process.exitCode = 1;\n`,
  );
  const bin = join(project, '.krn/tmp/bin');
  await mkdir(bin);
  const fakeNpm = join(bin, 'npm');
  await writeFile(
    fakeNpm,
    `#!${process.execPath}
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const mode = new Map([
  ['run preflight', 'preflight'],
  ['run gate', 'full'],
  ['test -- test/a.test.mjs', 'isolation'],
]).get(args.join(' '));
assert.ok(mode, 'unexpected fixture npm arguments: ' + JSON.stringify(args));
const result = spawnSync(process.execPath, ['fake-gate.mjs', mode], { stdio: 'inherit' });
assert.equal(result.error, undefined);
process.exitCode = result.status ?? 1;
`,
  );
  await chmod(fakeNpm, 0o755);
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of gitContextKeys) delete env[key];
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
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
