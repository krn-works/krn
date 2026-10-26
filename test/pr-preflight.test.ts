import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../scripts/pr-preflight.mjs', import.meta.url),
);
const gitOverrideKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
] as const;

type FixtureOptions = {
  ticket?: string;
  title?: string;
  taskId?: string;
  taskStatus?: 'open' | 'closed';
  taskFile?: 'valid' | 'missing' | 'working-tree-only' | 'invalid';
  r1TaskTrailer?: string | null;
  additionalR1TaskTrailers?: string[];
  gateState?: string;
  gateDescription?: string;
  prBase?: string;
  prHead?: string;
};

async function git(repo: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of gitOverrideKeys) delete env[key];
  const result = spawnSync('git', args, {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function taskDocument(id: string, status: 'open' | 'closed' = 'open') {
  return `${JSON.stringify(
    {
      id,
      status,
      resolution:
        status === 'open'
          ? null
          : { kind: 'done', ref: null, note: 'Closed in delivery PR' },
      created: '2026-10-26',
      priority: 0,
      title: 'Fixture delivery task',
      after: [],
      body: [],
    },
    null,
    2,
  )}\n`;
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-pr-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const outside = join(directory, 'unrelated-cwd');
  const ticket = options.ticket ?? 'LON-230';
  const taskId = options.taskId ?? ticket;
  const taskFile = options.taskFile ?? 'valid';
  await Promise.all([
    mkdir(join(repo, 'src'), { recursive: true }),
    mkdir(join(repo, 'test'), { recursive: true }),
    mkdir(outside),
  ]);

  await git(repo, ['init', '--quiet']);
  await git(repo, ['config', 'user.name', 'Preflight Test']);
  await git(repo, ['config', 'user.email', 'preflight@example.test']);
  await git(repo, [
    'remote',
    'add',
    'origin',
    'https://github.com/krn-works/krn.git',
  ]);
  await writeFile(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'test', 'example.test.ts'), 'export {};\n');
  if (taskFile === 'valid' || taskFile === 'invalid') {
    await mkdir(join(repo, 'tasks'), { recursive: true });
    await writeFile(
      join(repo, 'tasks', `${taskId}.json`),
      taskFile === 'valid'
        ? taskDocument(taskId, options.taskStatus)
        : '{ invalid task json\n',
    );
  }
  await git(repo, ['add', 'src', 'test']);
  await git(repo, ['commit', '--quiet', '-m', 'initial fixture']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  await writeFile(join(repo, 'src', 'index.ts'), 'export const value = 2;\n');
  await git(repo, ['add', '--all']);
  const taskTrailers = [
    ...(options.r1TaskTrailer === null
      ? []
      : [`R1-task: ${options.r1TaskTrailer ?? 'none'}`]),
    ...(options.additionalR1TaskTrailers ?? []),
  ];
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    options.title ?? `feat(review): add preflight (${ticket})`,
    '-m',
    [`Ticket: ${ticket}`, ...taskTrailers].join('\n'),
  ]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const srcTreeSha = await git(repo, ['rev-parse', `${head}:src`]);
  const testTreeSha = await git(repo, ['rev-parse', `${head}:test`]);
  const title = options.title ?? `feat(review): add preflight (${ticket})`;
  const pull = {
    title,
    base: { sha: options.prBase ?? base },
    head: { sha: options.prHead ?? head },
  };
  const statuses = [
    {
      context: 'krn/gate-local',
      state: 'failure',
      description: 'Older status',
      creator: { login: 'old-bot' },
      created_at: '2026-10-11T09:00:00Z',
      updated_at: '2026-10-11T09:00:00Z',
    },
    {
      context: 'krn/gate-local',
      state: options.gateState ?? 'success',
      description:
        options.gateDescription ?? 'Gate passed: 12 tests, 0 isolation skips',
      creator: { login: 'preflight-test-bot' },
      created_at: '2026-10-11T10:30:00Z',
      updated_at: '2026-10-11T10:30:00Z',
    },
  ];
  if (taskFile === 'working-tree-only') {
    await mkdir(join(repo, 'tasks'), { recursive: true });
    await writeFile(
      join(repo, 'tasks', `${taskId}.json`),
      taskDocument(taskId, options.taskStatus),
    );
  }
  return {
    directory,
    repo,
    outside,
    base,
    head,
    ticket,
    srcTreeSha,
    testTreeSha,
    pull,
    statuses,
  };
}

function runHarness(
  value: Awaited<ReturnType<typeof fixture>>,
  options: { overrides?: boolean } = {},
) {
  const input = {
    repo: value.repo,
    base: value.base,
    head: value.head,
    pr: 27,
  };
  const harness = `
    import { runPreflight } from ${JSON.stringify(scriptPath)};
    const fixture = ${JSON.stringify({
      input,
      pull: value.pull,
      statuses: value.statuses,
    })};
    const calls = [];
    const report = await runPreflight(fixture.input, {
      readPull: async (...args) => { calls.push(['pull', ...args]); return { ok: true, value: fixture.pull }; },
      readStatuses: async (...args) => { calls.push(['statuses', ...args]); return { ok: true, value: fixture.statuses }; },
    });
    process.stdout.write(JSON.stringify({ report, calls }) + '\\n');
  `;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.overrides) {
    for (const key of gitOverrideKeys)
      env[key] = join(value.directory, `foreign-${key.toLowerCase()}`);
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: value.outside,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

function parseHarness(result: ReturnType<typeof runHarness>) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.stdout, `expected verdict JSON; stderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as {
    report: {
      verdict: 'pass' | 'fail';
      reasons: string[];
      ticket?: string;
      srcTreeSha?: string;
      testTreeSha?: string;
      gateLocalStatus?: {
        context: string;
        state: string;
        creator: string | null;
        description?: string | null;
      };
    };
    calls: unknown[][];
  };
}

test('a PR whose ticket is a committed task at head passes', async (t) => {
  const value = await fixture(t);
  const result = runHarness(value, { overrides: true });
  assert.equal(result.status, 0, result.stderr);
  const { report, calls } = parseHarness(result);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.reasons, []);
  assert.equal(report.ticket, 'LON-230');
  assert.equal(report.srcTreeSha, value.srcTreeSha);
  assert.equal(report.testTreeSha, value.testTreeSha);
  assert.deepEqual(report.gateLocalStatus, {
    context: 'krn/gate-local',
    state: 'success',
    creator: 'preflight-test-bot',
    description: 'Gate passed: 12 tests, 0 isolation skips',
  });
  assert.deepEqual(calls, [
    ['pull', value.repo, 'krn-works/krn', 27],
    ['statuses', value.repo, 'krn-works/krn', value.head],
  ]);
});

test('preflight accepts a closed task recorded in the delivery commit', async (t) => {
  const value = await fixture(t, { taskStatus: 'closed' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.reasons, []);
});

test('preflight refuses a task missing from the exact PR head', async (t) => {
  const value = await fixture(t, { taskFile: 'missing' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      /task LON-230 is missing from the PR head/u.test(reason),
    ),
    JSON.stringify(report.reasons),
  );
});

test('preflight refuses a task present only in the working tree', async (t) => {
  const value = await fixture(t, { taskFile: 'working-tree-only' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      /task LON-230 is missing from the PR head/u.test(reason),
    ),
    JSON.stringify(report.reasons),
  );
});

test('preflight refuses an invalid task file at the PR head', async (t) => {
  const value = await fixture(t, { taskFile: 'invalid' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      /task LON-230 at the PR head is invalid/u.test(reason),
    ),
    JSON.stringify(report.reasons),
  );
});

test('preflight returns the title capture and rejects a mismatched Ticket trailer', async (t) => {
  const value = await fixture(t, {
    ticket: 'LON-230',
    taskId: 'LON-231',
    title: 'feat(review): add preflight (LON-231)',
  });
  const result = runHarness(value);
  const { report, calls } = parseHarness(result);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.ticket, 'LON-231');
  assert.ok(report.reasons.some((reason) => /Ticket trailer/u.test(reason)));
  assert.deepEqual(calls, [
    ['pull', value.repo, 'krn-works/krn', 27],
    ['statuses', value.repo, 'krn-works/krn', value.head],
  ]);
});

test('preflight ignores legacy R1-task trailers', async (t) => {
  const value = await fixture(t, {
    r1TaskTrailer: 'malformed legacy value',
    additionalR1TaskTrailers: ['R1-task: duplicate legacy value'],
  });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.reasons, []);
});

test('preflight refuses a LON suffix with no matching task file at head', async (t) => {
  const value = await fixture(t, {
    ticket: 'LON-319',
    taskFile: 'missing',
    title: 'feat(review): add preflight (LON-319)',
  });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      /task LON-319 is missing from the PR head/u.test(reason),
    ),
    JSON.stringify(report.reasons),
  );
});

test('preflight rejects a PR head that differs from the requested exact head', async (t) => {
  const value = await fixture(t, { prHead: 'a'.repeat(40) });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(report.reasons.some((reason) => /PR head SHA/u.test(reason)));
});

test('preflight rejects non-success and isolation-skipping gate-local statuses', async (t) => {
  const failedStatus = await fixture(t, { gateState: 'failure' });
  const failed = parseHarness(runHarness(failedStatus)).report;
  assert.equal(failed.verdict, 'fail');
  assert.equal(failed.gateLocalStatus?.state, 'failure');
  assert.ok(
    failed.reasons.some((reason) =>
      /gate-local status is not success/u.test(reason),
    ),
  );

  const skippedStatus = await fixture(t, {
    gateDescription: 'Gate passed: 12 tests, 1 isolation skips',
  });
  const skipped = parseHarness(runHarness(skippedStatus)).report;
  assert.equal(skipped.verdict, 'fail');
  assert.ok(
    skipped.reasons.some((reason) => /zero isolation skips/u.test(reason)),
  );

  const tenSkippedStatus = await fixture(t, {
    gateDescription: 'Gate passed: 12 tests, 10 isolation skips',
  });
  const tenSkipped = parseHarness(runHarness(tenSkippedStatus)).report;
  assert.equal(tenSkipped.verdict, 'fail');
  assert.ok(
    tenSkipped.reasons.some((reason) => /zero isolation skips/u.test(reason)),
  );
});

test('CLI writes a JSON failure for invalid arguments', async (t) => {
  const value = await fixture(t);
  const result = spawnSync(process.execPath, [scriptPath, '--repo'], {
    cwd: value.outside,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout, `expected JSON verdict; stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    verdict: string;
    reasons: string[];
  };
  assert.equal(report.verdict, 'fail');
  assert.ok(report.reasons[0]?.includes('missing value'));
});
