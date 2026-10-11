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
  title?: string;
  r1TaskTrailer?: string;
  paperclipTask?: string;
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

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-pr-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const outside = join(directory, 'unrelated-cwd');
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
  await git(repo, ['add', 'src', 'test']);
  await git(repo, ['commit', '--quiet', '-m', 'initial fixture']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  await writeFile(join(repo, 'src', 'index.ts'), 'export const value = 2;\n');
  await git(repo, ['add', 'src']);
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    options.title ?? 'feat(review): add preflight (LON-230)',
    '-m',
    `Ticket: LON-230\nR1-task: ${options.r1TaskTrailer ?? 'none'}`,
  ]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const srcTreeSha = await git(repo, ['rev-parse', `${head}:src`]);
  const testTreeSha = await git(repo, ['rev-parse', `${head}:test`]);
  const title = options.title ?? 'feat(review): add preflight (LON-230)';
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
  const description = [
    `R1-task: ${options.paperclipTask ?? 'none'} (review-system reset fixture)`,
    '',
    '```krn-contract',
    '{"version":1,"targetRepo":"krn-works/krn","checks":["typecheck","lint","rules"]}',
    '```',
  ].join('\n');
  return {
    directory,
    repo,
    outside,
    base,
    head,
    srcTreeSha,
    testTreeSha,
    pull,
    statuses,
    description,
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
      description: value.description,
    })};
    const calls = [];
    const report = await runPreflight(fixture.input, {
      readPull: async (...args) => { calls.push(['pull', ...args]); return { ok: true, value: fixture.pull }; },
      readStatuses: async (...args) => { calls.push(['statuses', ...args]); return { ok: true, value: fixture.statuses }; },
      readPaperclipDescription: async (ticket) => { calls.push(['paperclip', ticket]); return { ok: true, value: fixture.description }; },
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
      r1TaskTrailer?: string;
      paperclipR1Task?: string;
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

test('preflight records a complete exact-head pass from an unrelated cwd', async (t) => {
  const value = await fixture(t);
  const result = runHarness(value, { overrides: true });
  assert.equal(result.status, 0, result.stderr);
  const { report, calls } = parseHarness(result);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.reasons, []);
  assert.equal(report.ticket, 'LON-230');
  assert.equal(report.r1TaskTrailer, 'none');
  assert.equal(report.paperclipR1Task, 'none');
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
    ['paperclip', 'LON-230'],
    ['statuses', value.repo, 'krn-works/krn', value.head],
  ]);
});

test('preflight returns the full title capture and rejects a mismatched Ticket trailer', async (t) => {
  const value = await fixture(t, {
    title: 'feat(review): add preflight (LON-231)',
  });
  const result = runHarness(value);
  const { report, calls } = parseHarness(result);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.ticket, 'LON-231');
  assert.ok(report.reasons.some((reason) => /Ticket trailer/u.test(reason)));
  assert.deepEqual(calls, [
    ['pull', value.repo, 'krn-works/krn', 27],
    ['paperclip', 'LON-231'],
    ['statuses', value.repo, 'krn-works/krn', value.head],
  ]);
});

test('preflight rejects a Paperclip R1-task mismatch', async (t) => {
  const value = await fixture(t, { paperclipTask: 'R1-15' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(report.reasons.some((reason) => /R1-task/u.test(reason)));
});

test('preflight accepts matching LON task identifiers in trailer and Paperclip', async (t) => {
  const value = await fixture(t, {
    r1TaskTrailer: 'LON-231',
    paperclipTask: 'LON-231',
  });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass');
  assert.equal(report.r1TaskTrailer, 'LON-231');
  assert.equal(report.paperclipR1Task, 'LON-231');
});

test('preflight checks equality between valid LON task identifiers', async (t) => {
  const value = await fixture(t, {
    r1TaskTrailer: 'LON-231',
    paperclipTask: 'LON-232',
  });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) => /R1-task trailer must match/u.test(reason)),
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
