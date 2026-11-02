import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliEntry = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const observer = 'test/observer.test.js';
const secondObserver = 'test/second-observer.test.js';
const testSuiteFiles = [
  'scripts/test-suite.mjs',
  'scripts/isolation-gate.mjs',
  'scripts/test-events-reporter.mjs',
  'scripts/lib/test-shards.mjs',
  'scripts/lib/test-timings.mjs',
  'scripts/test-summary-policy.mjs',
  'scripts/probe-isolation.mjs',
];

interface VerifyOptions {
  readonly base: string;
  readonly observers?: readonly string[];
  readonly skipped?: readonly string[];
}

interface VerifyLine {
  readonly step: string;
  readonly status: string;
  readonly detail: string;
}

interface VerifyResult {
  readonly lines: readonly VerifyLine[];
  readonly exitCode: 0 | 1 | 75;
  readonly headSha: string;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut?: boolean;
  readonly logTruncated?: boolean;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
) => CommandResult | Promise<CommandResult>;

interface RedFirstResult {
  readonly path: string;
  readonly side: 'base' | 'head';
  readonly sha: string;
  readonly classification:
    | 'pass'
    | 'assertion'
    | 'missing-module'
    | 'procedural'
    | 'other'
    | 'skipped'
    | 'timeout';
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly summary: string;
  readonly cause?: 'capability' | 'runner-config' | 'contract';
}

interface RedFirstReport {
  readonly baseSha: string;
  readonly headSha: string;
  readonly contracts: readonly unknown[];
  readonly results: readonly RedFirstResult[];
}

interface VerifyFixtureOptions {
  readonly cliScripts?: boolean;
  readonly observerPaths?: readonly string[];
  readonly failingPaths?: readonly string[];
  readonly testSuiteScripts?: boolean;
}

type RunVerify = (
  options: VerifyOptions,
  dependencies: {
    readonly cwd: string;
    readonly commandRunner?: CommandRunner;
    readonly redFirst?: (
      root: string,
      base: string,
      head: string,
    ) => Promise<RedFirstReport>;
  },
) => Promise<VerifyResult>;

interface VerifyModule {
  readonly runVerify: RunVerify;
  readonly parseVerifyArgs: (args: readonly string[]) => VerifyOptions;
}

async function loadVerify(): Promise<VerifyModule> {
  let imported: unknown;
  try {
    imported = await import('../../src/verify/index.ts');
  } catch (error) {
    assert.fail(
      `runVerify module import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof imported !== 'object' || imported === null)
    assert.fail('src/verify/index.ts did not load as a module');
  assert.equal(
    typeof Reflect.get(imported, 'runVerify'),
    'function',
    'src/verify/index.ts must export runVerify',
  );
  return imported as VerifyModule;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function makeRepository(options: VerifyFixtureOptions = {}): Promise<{
  readonly directory: string;
  readonly root: string;
  readonly base: string;
  readonly head: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-verify-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Verify Test']);
  git(root, ['config', 'user.email', 'verify@example.test']);
  const scripts = options.cliScripts
    ? {
        lint: 'node -e "console.log(\'child output\')"',
        check: 'node -e "console.log(\'child output\')"',
        preflight: 'node -e "console.log(\'child output\')"',
      }
    : {};
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'verify-fixture', scripts }, null, 2)}\n`,
  );
  const observerPaths = options.observerPaths ?? [observer];
  for (const path of observerPaths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      "import test from 'node:test';\ntest('observer', () => {});\n",
    );
  }
  if (options.testSuiteScripts) await copyTestSuiteScripts(root);
  git(root, [
    'add',
    'package.json',
    ...observerPaths,
    ...(options.testSuiteScripts ? testSuiteFiles : []),
  ]);
  git(root, ['commit', '--quiet', '-m', 'fixture base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  for (const path of observerPaths) {
    const fails = options.failingPaths?.includes(path) ?? false;
    await writeFile(
      join(root, path),
      fails
        ? "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('fixture failure', () => assert.fail('fixture assertion'));\n"
        : "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('fixture pass', () => assert.ok(true));\n",
    );
  }
  git(root, ['add', ...observerPaths]);
  git(root, ['commit', '--quiet', '-m', 'fixture head']);
  const head = git(root, ['rev-parse', 'HEAD']);
  return {
    directory,
    root,
    base,
    head,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function copyTestSuiteScripts(root: string): Promise<void> {
  for (const path of testSuiteFiles) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(sourceRoot, path)));
  }
}

function makeRedFirstResult(
  path: string,
  side: 'base' | 'head',
  sha: string,
  classification: RedFirstResult['classification'],
  cause?: RedFirstResult['cause'],
): RedFirstResult {
  return {
    path,
    side,
    sha,
    classification,
    exitCode: classification === 'pass' ? 0 : 1,
    durationMs: 1,
    outputSha256: '0'.repeat(64),
    summary: '',
    ...(cause ? { cause } : {}),
  };
}

function report(
  base: string,
  head: string,
  entries: readonly RedFirstResult[],
  contracts: readonly unknown[] = [],
): RedFirstReport {
  return { baseSha: base, headSha: head, contracts, results: entries };
}

function passingReport(base: string, head: string): RedFirstReport {
  return report(base, head, [
    makeRedFirstResult(observer, 'base', base, 'assertion'),
    makeRedFirstResult(observer, 'head', head, 'pass'),
  ]);
}

function fakeCommandRunner(
  calls: string[][],
  codeFor: (command: string, args: readonly string[]) => number | null = () =>
    0,
): CommandRunner {
  return (command, args, _cwd, logPath) => {
    calls.push([command, ...args]);
    writeFileSync(logPath, 'captured child output\n');
    return { exitCode: codeFor(command, args) };
  };
}

test('verify runs every step and reports one successful line per step', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const calls: string[][] = [];
    const result = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner(calls),
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.lines.map(({ step }) => step),
      [
        'lint',
        'check',
        'targeted',
        'red-first',
        'preflight',
        'diff-check',
        'overall',
      ],
    );
    assert.ok(result.lines.every(({ status }) => status !== 'FAIL'));
    assert.deepEqual(calls, [
      ['npm', 'run', 'lint'],
      ['npm', 'run', 'check'],
      ['node', 'scripts/test-suite.mjs', observer],
      ['npm', 'run', 'preflight'],
      ['git', 'diff', '--check', fixture.base, fixture.head],
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('runVerify formats a verbatim red-first report captured from the real runner', async () => {
  const { runVerify } = await loadVerify();
  const captured = JSON.parse(
    await readFile(
      new URL('../fixtures/verify/red-first-report.json', import.meta.url),
      'utf8',
    ),
  ) as RedFirstReport;
  const paths = [
    ...new Set(
      captured.results
        .filter((entry) => entry.side === 'base')
        .map((entry) => entry.path),
    ),
  ];
  const fixture = await makeRepository({ observerPaths: paths });
  try {
    const verification = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () => captured,
      },
    );
    const red = verification.lines.find(({ step }) => step === 'red-first');
    assert.equal(red?.status, 'FAIL');
    assert.match(red?.detail ?? '', /procedural/u);
    assert.equal(verification.exitCode, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('a timed-out or signalled step with exit 0 is not a PASS', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    for (const outcome of [
      { timedOut: true, signal: null },
      { timedOut: false, signal: 'SIGTERM' as const },
    ]) {
      const result = await runVerify(
        { base: fixture.base },
        {
          cwd: fixture.root,
          commandRunner: (command, args, _cwd, logPath) => {
            writeFileSync(logPath, 'captured child output\n');
            return command === 'npm' && args[1] === 'lint'
              ? { exitCode: 0, ...outcome }
              : { exitCode: 0 };
          },
          redFirst: async () => passingReport(fixture.base, fixture.head),
        },
      );
      const lint = result.lines.find(({ step }) => step === 'lint');
      assert.equal(lint?.status, 'FAIL');
      assert.equal(result.exitCode, 1);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('a flag-skipped step makes overall incomplete with exit code 1', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const result = await runVerify(
      { base: fixture.base, skipped: ['red-first'] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () => assert.fail('red-first should be skipped'),
      },
    );
    const overall = result.lines.at(-1);
    assert.equal(overall?.step, 'overall');
    assert.equal(overall?.status, 'FAIL');
    assert.match(overall?.detail ?? '', /^incomplete: skipped red-first /u);
    assert.equal(result.exitCode, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('a failed child step does not stop later steps', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const calls: string[][] = [];
    const result = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner(calls, (_command, args) =>
          args.includes('check') ? 2 : 0,
        ),
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.lines[1]?.status, 'FAIL');
    assert.match(
      result.lines[1]?.detail ?? '',
      /\.krn\/tmp\/verify-[^ ]+\/check\.log/u,
    );
    assert.deepEqual(
      result.lines.map(({ step }) => step),
      [
        'lint',
        'check',
        'targeted',
        'red-first',
        'preflight',
        'diff-check',
        'overall',
      ],
    );
    assert.equal(calls.length, 5);
  } finally {
    await fixture.cleanup();
  }
});

test('verify reports a HEAD change made during the final step', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const commandRunner: CommandRunner = (command, args, cwd, logPath) => {
      writeFileSync(logPath, 'captured child output\n');
      if (command === 'git' && args[0] === 'diff') {
        writeFileSync(join(cwd, 'late.txt'), 'committed during verification\n');
        git(cwd, ['add', 'late.txt']);
        git(cwd, ['commit', '--quiet', '-m', 'move HEAD during verification']);
      }
      return { exitCode: 0 };
    };
    const verification = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner,
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    );
    const overall = verification.lines.at(-1);
    assert.equal(verification.exitCode, 1);
    assert.equal(overall?.status, 'FAIL');
    assert.match(overall?.detail ?? '', /head moved/u);
  } finally {
    await fixture.cleanup();
  }
});

test('verify returns 75 if a tracked file becomes dirty during a step', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const commandRunner: CommandRunner = (command, args, cwd, logPath) => {
      writeFileSync(logPath, 'captured child output\n');
      if (command === 'git' && args[0] === 'diff')
        writeFileSync(join(cwd, 'package.json'), '{"dirty":true}\n');
      return { exitCode: 0 };
    };
    const verification = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner,
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    );
    const overall = verification.lines.at(-1);
    assert.equal(verification.exitCode, 75);
    assert.equal(overall?.status, 'FAIL');
    assert.match(overall?.detail ?? '', /commit first/u);
  } finally {
    await fixture.cleanup();
  }
});

test('timeout and signal failures name their cause instead of spawn', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    for (const failed of [
      { exitCode: null, signal: 'SIGTERM' },
      { exitCode: null, timedOut: true },
    ] satisfies readonly CommandResult[]) {
      const verification = await runVerify(
        { base: fixture.base },
        {
          cwd: fixture.root,
          commandRunner: (command, args, _cwd, logPath) => {
            writeFileSync(logPath, 'captured child output\n');
            return command === 'npm' && args.includes('lint')
              ? failed
              : { exitCode: 0 };
          },
          redFirst: async () => passingReport(fixture.base, fixture.head),
        },
      );
      const lint = verification.lines[0];
      assert.equal(lint?.status, 'FAIL');
      assert.match(
        lint?.detail ?? '',
        failed.timedOut ? /timeout/u : /signal=SIGTERM/u,
      );
      assert.doesNotMatch(lint?.detail ?? '', /exit=spawn/u);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('red-first calls out a base missing-module as an import failure', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const result = await runVerify(
      { base: fixture.base, observers: [observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () =>
          report(fixture.base, fixture.head, [
            makeRedFirstResult(
              observer,
              'base',
              fixture.base,
              'missing-module',
            ),
            makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
          ]),
      },
    );
    const red = result.lines.find(({ step }) => step === 'red-first');
    assert.equal(red?.status, 'FAIL');
    assert.match(
      red?.detail ?? '',
      /base=missing-module \(import, not assertion\)/u,
    );
    assert.equal(result.exitCode, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('only an assertion counts as a red base result', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository({
    observerPaths: [observer, secondObserver],
  });
  try {
    const cases: readonly [RedFirstResult['classification'], RegExp][] = [
      ['other', /base=other \(not assertion\)/u],
      ['procedural', /base=procedural \(not assertion\)/u],
      ['timeout', /base=timeout \(not assertion\)/u],
      ['skipped', /base=skipped \(not assertion\)/u],
      ['missing-module', /base=missing-module \(import, not assertion\)/u],
      ['pass', /base=pass \(not assertion\)/u],
    ];
    for (const [classification, expected] of cases) {
      const verification = await runVerify(
        { base: fixture.base, observers: [observer] },
        {
          cwd: fixture.root,
          commandRunner: fakeCommandRunner([]),
          redFirst: async () =>
            report(fixture.base, fixture.head, [
              makeRedFirstResult(
                observer,
                'base',
                fixture.base,
                classification,
              ),
              makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
              makeRedFirstResult(secondObserver, 'base', fixture.base, 'pass'),
              makeRedFirstResult(secondObserver, 'head', fixture.head, 'pass'),
            ]),
        },
      );
      const red = verification.lines.find(({ step }) => step === 'red-first');
      assert.equal(red?.status, 'FAIL', classification);
      assert.match(red?.detail ?? '', expected, classification);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('changed tests that pass at base need at least one red observer', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const greenAtBase = async () =>
      report(fixture.base, fixture.head, [
        makeRedFirstResult(observer, 'base', fixture.base, 'pass'),
        makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
      ]);
    const implicit = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: greenAtBase,
      },
    );
    const implicitRed = implicit.lines.find(({ step }) => step === 'red-first');
    assert.equal(implicitRed?.status, 'FAIL');
    assert.match(implicitRed?.detail ?? '', /no changed test is red at base/u);
    const explicit = await runVerify(
      { base: fixture.base, observers: [observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: greenAtBase,
      },
    );
    const explicitRed = explicit.lines.find(({ step }) => step === 'red-first');
    assert.equal(explicitRed?.status, 'FAIL');
    assert.match(explicitRed?.detail ?? '', /base=pass \(not assertion\)/u);
  } finally {
    await fixture.cleanup();
  }
});

test('an explicit observer absent from the red-first report fails', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const result = await runVerify(
      { base: fixture.base, observers: [observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () => report(fixture.base, fixture.head, []),
      },
    );
    const red = result.lines.find(({ step }) => step === 'red-first');
    assert.equal(red?.status, 'FAIL');
    assert.match(red?.detail ?? '', /observer\.test\.js missing=base,head/u);
  } finally {
    await fixture.cleanup();
  }
});

test('red-first data errors in a change contract fail the step', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const verification = await runVerify(
      { base: fixture.base, observers: [observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () =>
          report(
            fixture.base,
            fixture.head,
            [
              makeRedFirstResult(observer, 'base', fixture.base, 'assertion'),
              makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
            ],
            [
              {
                path: observer,
                kind: 'red->green',
                cause: 'capability',
                red: makeRedFirstResult(
                  observer,
                  'base',
                  fixture.base,
                  'assertion',
                ),
                green: makeRedFirstResult(
                  observer,
                  'head',
                  fixture.head,
                  'pass',
                ),
                proven: false,
              },
            ],
          ),
      },
    );
    const red = verification.lines.find(({ step }) => step === 'red-first');
    assert.equal(red?.status, 'FAIL');
    assert.match(red?.detail ?? '', /capability/u);
  } finally {
    await fixture.cleanup();
  }
});

test('an unproven change contract fails with its deterministic cause', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const verification = await runVerify(
      { base: fixture.base, observers: [observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () =>
          report(
            fixture.base,
            fixture.head,
            [
              makeRedFirstResult(observer, 'base', fixture.base, 'assertion'),
              makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
            ],
            [
              {
                path: observer,
                commit: fixture.head,
                kind: 'red->green',
                red: makeRedFirstResult(observer, 'base', fixture.base, 'pass'),
                green: makeRedFirstResult(
                  observer,
                  'head',
                  fixture.head,
                  'pass',
                ),
                proven: false,
              },
            ],
          ),
      },
    );
    const red = verification.lines.find(({ step }) => step === 'red-first');
    assert.equal(red?.status, 'FAIL');
    assert.match(
      red?.detail ?? '',
      /the test does not fail without the change/u,
    );
    assert.equal(verification.exitCode, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('an explicit observer keeps every changed test targeted and green', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository({
    observerPaths: [observer, secondObserver],
  });
  try {
    const calls: string[][] = [];
    const verification = await runVerify(
      { base: fixture.base, observers: [observer, observer] },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner(calls),
        redFirst: async () =>
          report(fixture.base, fixture.head, [
            makeRedFirstResult(observer, 'base', fixture.base, 'assertion'),
            makeRedFirstResult(observer, 'head', fixture.head, 'pass'),
            makeRedFirstResult(
              secondObserver,
              'base',
              fixture.base,
              'assertion',
            ),
            makeRedFirstResult(
              secondObserver,
              'head',
              fixture.head,
              'assertion',
            ),
          ]),
      },
    );
    assert.deepEqual(
      calls.find((call) => call[0] === 'node'),
      ['node', 'scripts/test-suite.mjs', observer, secondObserver],
    );
    const targeted = verification.lines.find(({ step }) => step === 'targeted');
    const red = verification.lines.find(({ step }) => step === 'red-first');
    assert.equal(targeted?.status, 'PASS');
    assert.equal(red?.status, 'FAIL');
    assert.match(
      red?.detail ?? '',
      /second-observer\.test\.js head=assertion/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('skip flags omit the step and malformed arguments use exit code 64', async () => {
  const { parseVerifyArgs, runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    const options = parseVerifyArgs([
      '--base',
      fixture.base,
      '--skip',
      'targeted',
      '--skip',
      'red-first',
    ]);
    const calls: string[][] = [];
    const result = await runVerify(options, {
      cwd: fixture.root,
      commandRunner: fakeCommandRunner(calls),
      redFirst: async () => {
        assert.fail('red-first should be skipped');
      },
    });
    assert.equal(result.lines[2]?.status, 'SKIP');
    assert.equal(result.lines[2]?.detail, 'skipped by flag');
    assert.equal(result.lines[3]?.status, 'SKIP');
    assert.equal(
      calls.some((call) => call[0] === 'node'),
      false,
    );

    assert.throws(
      () => parseVerifyArgs(['--base', fixture.base, '--skip', 'unknown']),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
    assert.throws(
      () => parseVerifyArgs([]),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('verify rejects dirty tracked files and unsafe observer paths as usage errors', async () => {
  const { runVerify } = await loadVerify();
  const fixture = await makeRepository();
  try {
    await writeFile(join(fixture.root, 'tracked.txt'), 'dirty\n');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: fixture.root });
    const dirty = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(dirty instanceof Error);
    assert.equal('exitCode' in dirty ? dirty.exitCode : undefined, 75);
    assert.match(dirty.message, /commit first/u);

    spawnSync('git', ['reset', '--quiet', 'HEAD', '--', 'tracked.txt'], {
      cwd: fixture.root,
    });
    await rm(join(fixture.root, 'tracked.txt'));
    await writeFile(join(fixture.root, 'untracked.txt'), 'ignored\n');
    const untracked = await runVerify(
      { base: fixture.base },
      {
        cwd: fixture.root,
        commandRunner: fakeCommandRunner([]),
        redFirst: async () => passingReport(fixture.base, fixture.head),
      },
    );
    assert.equal(untracked.exitCode, 0);
    await assert.rejects(
      runVerify(
        { base: 'missing-base-ref' },
        { cwd: fixture.root, commandRunner: fakeCommandRunner([]) },
      ),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
    await assert.rejects(
      runVerify(
        { base: fixture.base, observers: ['../observer.test.js'] },
        { cwd: fixture.root, commandRunner: fakeCommandRunner([]) },
      ),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
    await symlink(
      'observer.test.js',
      join(fixture.root, 'test/linked.test.js'),
    );
    git(fixture.root, ['add', 'test/linked.test.js']);
    git(fixture.root, ['commit', '--quiet', '-m', 'fixture symlink observer']);
    await assert.rejects(
      runVerify(
        { base: fixture.base, observers: ['test/linked.test.js'] },
        { cwd: fixture.root, commandRunner: fakeCommandRunner([]) },
      ),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('CLI runs the real targeted step, bounds logs, and reports a failing fixture test', async () => {
  const outcomes = [
    {
      path: 'test/pass.test.mjs',
      failing: false,
      expected: 'targeted PASS completed',
    },
    {
      path: 'test/fail.test.mjs',
      failing: true,
      expected: 'targeted FAIL exit=1',
    },
  ] as const;
  for (const outcome of outcomes) {
    const fixture = await makeRepository({
      cliScripts: true,
      observerPaths: [outcome.path],
      failingPaths: outcome.failing ? [outcome.path] : [],
      testSuiteScripts: true,
    });
    try {
      const shimDirectory = join(fixture.directory, 'bin');
      await mkdir(shimDirectory);
      await writeFile(
        join(shimDirectory, 'npm'),
        "#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('lint') ? 'x'.repeat(9_000_000) : 'child output\\n');\n",
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          cliEntry,
          'verify',
          '--base',
          fixture.base,
          '--observer',
          outcome.path,
          '--skip',
          'red-first',
        ],
        {
          cwd: fixture.root,
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}`,
          },
        },
      );
      // red-first is skipped by flag, so even a clean run is incomplete.
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      if (!outcome.failing)
        assert.match(
          result.stdout,
          /^overall FAIL incomplete: skipped red-first /mu,
        );
      assert.equal(result.stderr, '');
      assert.match(result.stdout, new RegExp(outcome.expected, 'u'));
      assert.equal(result.stdout.includes('child output'), false);
      const lines = result.stdout.trim().split('\n');
      assert.deepEqual(
        lines.map((entry) => entry.split(' ')[0]),
        [
          'lint',
          'check',
          'targeted',
          'red-first',
          'preflight',
          'diff-check',
          'overall',
        ],
      );
      const logDirectory = join(fixture.root, '.krn', 'tmp');
      const logDirectories = (await readdir(logDirectory)).filter((entry) =>
        /^verify-[0-9a-f-]+$/u.test(entry),
      );
      assert.equal(logDirectories.length, 1);
      const logs = join(logDirectory, logDirectories[0] ?? '');
      const lintLine = lines.find((entry) => entry.startsWith('lint '));
      assert.match(lintLine ?? '', /log truncated/u);
      const lintLog = await readFile(join(logs, 'lint.log'));
      assert.ok(lintLog.byteLength <= 8 * 1024 * 1024);
      assert.match(lintLog.toString('utf8'), /\n\[log truncated\]\n$/u);
      assert.match(
        await readFile(join(logs, 'check.log'), 'utf8'),
        /child output/u,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test('CLI reports usage, dirty-tree, and unexpected errors with their exit codes', async () => {
  const fixture = await makeRepository();
  try {
    const usage = spawnSync(process.execPath, [cliEntry, 'verify'], {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(usage.status, 64);
    assert.match(
      usage.stderr,
      /Exit codes: 0 pass.*75 dirty tracked worktree/u,
    );

    const tracked = join(fixture.root, 'tracked.txt');
    await writeFile(tracked, 'dirty\n');
    git(fixture.root, ['add', 'tracked.txt']);
    const dirty = spawnSync(
      process.execPath,
      [cliEntry, 'verify', '--base', fixture.base],
      { cwd: fixture.root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(dirty.status, 75);
    assert.match(dirty.stderr, /commit first/u);

    git(fixture.root, ['reset', '--quiet', 'HEAD', '--', 'tracked.txt']);
    await rm(tracked);
    const outside = join(fixture.directory, 'outside');
    await mkdir(outside);
    await mkdir(join(fixture.root, '.krn'));
    await symlink(outside, join(fixture.root, '.krn', 'tmp'), 'dir');
    const internal = spawnSync(
      process.execPath,
      [cliEntry, 'verify', '--base', fixture.base],
      { cwd: fixture.root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(internal.status, 70);
    assert.match(internal.stderr, /unsafe repository temporary directory/u);
  } finally {
    await fixture.cleanup();
  }
});
