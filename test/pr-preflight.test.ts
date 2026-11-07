import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deterministicCauses, reviewRecordSchema } from '../src/flow/types.ts';
import {
  gateCheck,
  reviewEvidence,
  writeReviewEvidence,
} from './helpers/ship-evidence.ts';

// Verbatim archived v1 receiver record; embedded for frozen-base replay.
const archivedBytes = String.raw`{
  "schemaVersion": 1,
  "headSha": "255083535f0a92f8c89d8574fe79d3073143ac4e",
  "base": "05c9eb332a7f5b43d3839bfc184696d2f3977255",
  "createdAt": "2026-10-27T20:26:45.660Z",
  "panelVerdict": "PASS",
  "redFirst": [],
  "contracts": [
    {
      "commit": "255083535f0a92f8c89d8574fe79d3073143ac4e",
      "path": "test/task/ergonomics.test.ts",
      "kind": "green->green",
      "green": {
        "path": "test/task/ergonomics.test.ts",
        "side": "head",
        "sha": "255083535f0a92f8c89d8574fe79d3073143ac4e",
        "classification": "pass",
        "exitCode": 0,
        "durationMs": 20390,
        "outputSha256": "9fe01742eb99fa2a8b72ce6629fe95bd13607c6e2b5bd6c2ecfa8a85d566b886",
        "summary": ""
      },
      "proven": true
    }
  ],
  "redFirstCauses": [],
  "judges": [
    {
      "state": "complete",
      "role": "standards",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "a3f0d904-6cd4-40ee-ba16-cd9097242078",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    },
    {
      "state": "complete",
      "role": "spec",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "c0b41936-56ad-48b6-9eac-e588a59a43ca",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    },
    {
      "state": "complete",
      "role": "adversarial",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "132d815b-3ba4-452d-ae74-5db64abd3fc8",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    }
  ],
  "lensSha256": "8b8526e5fd6048f6ba2c4b57f397675304762835b04a60e5220489ae8dfbedd1",
  "panel": {
    "requestedRoles": [
      "standards",
      "spec",
      "adversarial"
    ],
    "requiredRoles": [
      "standards",
      "spec",
      "adversarial"
    ],
    "partial": false
  },
  "toolSha": "05c9eb332a7f5b43d3839bfc184696d2f3977255"
}
`;
const archivedResult = reviewRecordSchema.safeParse(JSON.parse(archivedBytes));
assert.equal(
  archivedResult.success,
  true,
  'archived v1 receiver record must parse',
);
if (!archivedResult.success)
  throw new Error('archived v1 receiver record is invalid');
const archived = archivedResult.data;

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
  baseHistory?: 'moved-ancestor' | 'side-branch';
  gatePolicy?: boolean;
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
  if (options.gatePolicy) {
    await mkdir(join(repo, 'spec'), { recursive: true });
    await writeFile(
      join(repo, 'spec', 'ci-admission.json'),
      '{"schemaVersion":1,"checkRunName":"Check","appId":15368}\n',
    );
  }
  if (taskFile === 'valid' || taskFile === 'invalid') {
    await mkdir(join(repo, 'tasks'), { recursive: true });
    await writeFile(
      join(repo, 'tasks', `${taskId}.json`),
      taskFile === 'valid'
        ? taskDocument(taskId, options.taskStatus)
        : '{ invalid task json\n',
    );
  }
  await git(repo, [
    'add',
    'src',
    'test',
    ...(options.gatePolicy ? ['spec'] : []),
  ]);
  await git(repo, ['commit', '--quiet', '-m', 'initial fixture']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  if (options.gatePolicy)
    await writeFile(
      join(repo, 'spec', 'ci-admission.json'),
      '{"schemaVersion":1,"checkRunName":"gate","appId":15368}\n',
    );
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
  await writeReviewEvidence(repo, base, head);
  const srcTreeSha = await git(repo, ['rev-parse', `${head}:src`]);
  const testTreeSha = await git(repo, ['rev-parse', `${head}:test`]);
  let requestedBase = base;
  let prBase = options.prBase ?? base;
  if (options.baseHistory) {
    await git(repo, ['checkout', '--quiet', '-b', 'moved-main', base]);
    await writeFile(join(repo, 'main.txt'), 'main advanced\n');
    await git(repo, ['add', 'main.txt']);
    await git(repo, ['commit', '--quiet', '-m', 'advance main']);
    requestedBase = await git(repo, ['rev-parse', 'HEAD']);
    if (options.baseHistory === 'side-branch') {
      await git(repo, ['checkout', '--quiet', '-b', 'side-base', base]);
      await writeFile(join(repo, 'side.txt'), 'side branch\n');
      await git(repo, ['add', 'side.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'advance side base']);
      prBase = await git(repo, ['rev-parse', 'HEAD']);
    }
    await git(repo, ['checkout', '--quiet', '--detach', head]);
  }
  const title = options.title ?? `feat(review): add preflight (${ticket})`;
  const pull = {
    number: 27,
    title,
    base: { sha: prBase, ref: 'main', repo: { full_name: 'krn-works/krn' } },
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
    requestedBase,
    head,
    ticket,
    srcTreeSha,
    testTreeSha,
    pull,
    statuses,
    gatePolicy: options.gatePolicy ?? false,
  };
}

function runHarness(
  value: Awaited<ReturnType<typeof fixture>>,
  options: { overrides?: boolean; checks?: unknown[] } = {},
) {
  const input = {
    repo: value.repo,
    base: value.requestedBase,
    head: value.head,
    pr: 27,
  };
  const harness = `
    import { runPreflight } from ${JSON.stringify(scriptPath)};
    const fixture = ${JSON.stringify({
      input,
      pull: value.pull,
      statuses: value.statuses,
      checks: options.checks ?? [
        {
          ...gateCheck(),
          head_sha: value.head,
          ...(value.gatePolicy ? { name: 'Check', app: { id: 15368 } } : {}),
        },
      ],
    })};
    const calls = [];
    const report = await runPreflight(fixture.input, {
      readPull: async (...args) => { calls.push(['pull', ...args]); return { ok: true, value: fixture.pull }; },
      readStatuses: async (...args) => { calls.push(['statuses', ...args]); return { ok: true, value: fixture.statuses }; },
      readCheckRuns: async (...args) => { calls.push(['checks', ...args]); return { ok: true, value: fixture.checks }; },
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
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(
    isHarnessResult(parsed),
    'preflight harness returns its JSON contract',
  );
  return parsed;
}

function isHarnessResult(value: unknown): value is {
  report: {
    verdict: 'pass' | 'fail';
    reasons: string[];
    base?: string;
    prBase?: string;
    ticket?: string;
    srcTreeSha?: string;
    testTreeSha?: string;
    gateCheckRun?: {
      id: number;
      url: string;
      status: string;
      conclusion: string | null;
      name: string;
      head: string;
      appId: number | null;
    };
  };
  calls: unknown[][];
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('report' in value) ||
    !('calls' in value)
  )
    return false;
  if (!Array.isArray(value.calls) || !value.calls.every(Array.isArray))
    return false;
  const report = value.report;
  if (
    typeof report !== 'object' ||
    report === null ||
    !('verdict' in report) ||
    !('reasons' in report)
  )
    return false;
  if (report.verdict !== 'pass' && report.verdict !== 'fail') return false;
  if (
    !Array.isArray(report.reasons) ||
    !report.reasons.every((reason) => typeof reason === 'string')
  )
    return false;
  for (const key of [
    'base',
    'prBase',
    'ticket',
    'srcTreeSha',
    'testTreeSha',
  ] as const) {
    const field = Object.getOwnPropertyDescriptor(report, key);
    if (field && typeof field.value !== 'string') return false;
  }
  return true;
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
  assert.equal('gateLocalStatus' in report, false);
  assert.deepEqual(calls, [
    ['pull', value.repo, 'krn-works/krn', 27],
    ['checks', value.repo, 'krn-works/krn', value.head],
  ]);
});

test('preflight selects App admission policy from base, not PR head', async (t) => {
  const value = await fixture(t, { gatePolicy: true });
  value.statuses.length = 0;
  const parsed = parseHarness(runHarness(value));
  assert.equal(parsed.report.verdict, 'pass', parsed.report.reasons.join('; '));
  assert.equal(
    parsed.calls.some(([role]) => role === 'statuses'),
    false,
  );
  assert.deepEqual(parsed.report.gateCheckRun, {
    id: 1,
    url: 'https://github.com/krn-works/krn/actions/runs/1',
    status: 'completed',
    conclusion: 'success',
    name: 'Check',
    head: value.head,
    appId: 15368,
  });
});

test('preflight accepts a PR base that is an ancestor of the requested base', async (t) => {
  const value = await fixture(t, { baseHistory: 'moved-ancestor' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.reasons, []);
  assert.equal(report.base, value.requestedBase);
  assert.equal(report.prBase, value.base);
});

test('preflight refuses a PR base outside the requested base history', async (t) => {
  const value = await fixture(t, { baseHistory: 'side-branch' });
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.equal(report.base, value.requestedBase);
  assert.equal(report.prBase, value.pull.base.sha);
  assert.ok(
    report.reasons.includes('PR base SHA is not in the requested base history'),
    JSON.stringify(report.reasons),
  );
});

test('preflight admits a reserved review when the PR base moves on the same ref', async (t) => {
  const value = await fixture(t);
  const movedBase = await git(value.repo, [
    'commit-tree',
    `${value.base}^{tree}`,
    '-p',
    value.base,
    '-m',
    'advance base',
  ]);
  value.requestedBase = movedBase;
  value.pull.base.sha = movedBase;
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass', report.reasons.join('\n'));
  assert.equal(report.prBase, movedBase);
  assert.equal(value.pull.base.ref, 'main');
  assert.equal(value.pull.head.sha, value.head);
});

test('preflight refuses a reviewed base outside the requested base history', async (t) => {
  const value = await fixture(t);
  const unrelatedBase = await git(value.repo, [
    'commit-tree',
    `${value.base}^{tree}`,
    '-m',
    'unrelated base',
  ]);
  value.requestedBase = unrelatedBase;
  value.pull.base.sha = unrelatedBase;
  const { report } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      reason.includes('review base must be an ancestor of --base:'),
    ),
    JSON.stringify(report.reasons),
  );
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
    ['checks', value.repo, 'krn-works/krn', value.head],
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

test('preflight ignores optional local diagnostic failures and skips', async (t) => {
  const value = await fixture(t, {
    gatePolicy: true,
    gateState: 'failure',
    gateDescription: 'Gate passed: 12 tests, 10 isolation skips',
  });
  const { report, calls } = parseHarness(runHarness(value));
  assert.equal(report.verdict, 'pass', report.reasons.join('; '));
  assert.equal(
    calls.some(([role]) => role === 'statuses'),
    false,
  );
});

for (const [label, patch] of [
  ['wrong head', { head_sha: 'f'.repeat(40) }],
  ['wrong App', { app: { id: 1, slug: 'other-app' } }],
  ['wrong name', { name: 'gate' }],
  ['failed', { conclusion: 'failure' }],
  ['pending', { status: 'in_progress', conclusion: null }],
  ['malformed', { id: 'invalid' }],
  ['missing', null],
] as const) {
  test(`preflight refuses ${label} full Product gate without local status`, async (t) => {
    const value = await fixture(t, { gatePolicy: true });
    value.statuses.length = 0;
    const checks =
      patch === null
        ? []
        : [
            {
              ...gateCheck(),
              name: 'Check',
              app: { id: 15368 },
              head_sha: value.head,
              ...patch,
            },
          ];
    const { report, calls } = parseHarness(runHarness(value, { checks }));
    assert.equal(report.verdict, 'fail');
    assert.match(report.reasons.join('; '), /check-runs?|check_runs/u);
    assert.equal(
      calls.some(([role]) => role === 'statuses'),
      false,
    );
  });
}

test('CLI writes a JSON failure for invalid arguments', async (t) => {
  const value = await fixture(t);
  const result = spawnSync(process.execPath, [scriptPath, '--repo'], {
    cwd: value.outside,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout, `expected JSON verdict; stderr: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(
    isCliFailure(parsed),
    'CLI failure output satisfies its JSON contract',
  );
  const report = parsed;
  assert.equal(report.verdict, 'fail');
  assert.ok(report.reasons[0]?.includes('missing value'));
});

function isCliFailure(
  value: unknown,
): value is { verdict: string; reasons: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'verdict' in value &&
    typeof value.verdict === 'string' &&
    'reasons' in value &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string')
  );
}

test('preflight accepts contract-aware and legacy records and blocks deterministic failures even with an override', async (t) => {
  const value = await fixture(t);
  const legacy = reviewEvidence(value.base, value.head);
  assert.equal(parseHarness(runHarness(value)).report.verdict, 'pass');
  const run = {
    path: 'test/example.test.ts',
    side: 'head' as const,
    sha: value.head,
    classification: 'pass' as const,
    exitCode: 0,
    durationMs: 0,
    outputSha256: 'b'.repeat(64),
    summary: '',
  };
  const contract = {
    commit: value.head,
    path: run.path,
    kind: 'green->green' as const,
    green: run,
    proven: true,
  };
  await writeReviewEvidence(value.repo, value.base, value.head, {
    ...legacy,
    contracts: [contract],
    redFirstCauses: [],
  });
  assert.equal(parseHarness(runHarness(value)).report.verdict, 'pass');
  const failedRun = {
    ...run,
    classification: 'assertion' as const,
    exitCode: 1,
  };
  const failedContract = { ...contract, green: failedRun, proven: false };
  await writeReviewEvidence(value.repo, value.base, value.head, {
    ...legacy,
    panelVerdict: 'FAIL',
    redFirst: [failedRun],
    contracts: [failedContract],
    redFirstCauses: deterministicCauses([failedRun], [failedContract]),
    judges: legacy.judges.map((judge) => ({ ...judge, verdict: 'FAIL' })),
    override: {
      reason: 'judge override',
      evidence: 'operator decision',
      appendedAt: new Date().toISOString(),
    },
  });
  const failed = parseHarness(runHarness(value)).report;
  assert.equal(failed.verdict, 'fail');
  assert.ok(
    failed.reasons.some((reason) =>
      reason.includes('deterministic red-first FAIL'),
    ),
    failed.reasons.join('\n'),
  );
  await writeReviewEvidence(value.repo, value.base, value.head, {
    ...legacy,
    contracts: [{ ...contract, proven: false }],
  });
  assert.ok(
    parseHarness(runHarness(value)).report.reasons.some((reason) =>
      reason.includes('strict schema'),
    ),
  );
});

test('preflight derives head failures without contracts and rejects inconsistent stored verdicts or causes', async (t) => {
  const value = await fixture(t);
  const legacy = reviewEvidence(value.base, value.head);
  const failedRun = {
    path: 'test/example.test.ts',
    side: 'head',
    sha: value.head,
    classification: 'assertion',
    exitCode: 1,
    durationMs: 0,
    outputSha256: 'b'.repeat(64),
    summary: '',
  };
  for (const metadata of [
    { panelVerdict: 'PASS' },
    { panelVerdict: 'FAIL', redFirstCauses: [] },
  ]) {
    await writeReviewEvidence(value.repo, value.base, value.head, {
      ...legacy,
      ...metadata,
      redFirst: [failedRun],
    });
    const report = parseHarness(runHarness(value)).report;
    assert.equal(report.verdict, 'fail');
    assert.ok(
      report.reasons.some((reason) => reason.includes('strict schema')),
      report.reasons.join('\n'),
    );
  }
  await writeReviewEvidence(value.repo, value.base, value.head, {
    ...legacy,
    panelVerdict: 'FAIL',
    redFirst: [failedRun],
    judges: legacy.judges.map((judge) => ({ ...judge, verdict: 'FAIL' })),
    override: {
      reason: 'judge override',
      evidence: 'operator decision',
      appendedAt: new Date().toISOString(),
    },
  });
  const report = parseHarness(runHarness(value)).report;
  assert.equal(report.verdict, 'fail');
  assert.ok(
    report.reasons.some((reason) =>
      reason.includes('deterministic red-first FAIL'),
    ),
    report.reasons.join('\n'),
  );
});

for (const version of [1, 2]) {
  test(`preflight reader accepts archived v1 and observed v${version} evidence`, async (t) => {
    const value = await fixture(t);
    const bytes = archivedBytes;
    value.head = archived.headSha;
    const timing = {
      startedAt: '2026-10-28T00:00:00.000Z',
      endedAt: '2026-10-28T00:00:01.000Z',
      durationMs: 1000,
    };
    const usage = {
      state: 'observed',
      tokens: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      turnsStarted: 1,
      turnsCompleted: 1,
      invalidFields: 0,
      missingRequiredTurns: 0,
      complete: true,
      multiTurnSemantics: 'single-turn',
    };
    const record =
      version === 1
        ? archived
        : {
            ...archived,
            schemaVersion: 2,
            round: 1,
            timing,
            redFirstTiming: timing,
            judges: archived.judges.map((judge) => ({
              ...judge,
              timing,
              usage,
            })),
          };
    const directory = join(value.repo, '.krn', 'runs', 'review', value.head);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'record.json');
    await writeFile(path, version === 1 ? bytes : JSON.stringify(record));
    const accepted = parseHarness(runHarness(value)).report;
    // The archive commits are absent from this private repository; inspect the
    // real reader's schema result separately from unrelated admission checks.
    assert.equal(
      accepted.reasons.some((reason) =>
        /review record.*schema|exact-head review record is missing/u.test(
          reason,
        ),
      ),
      false,
      JSON.stringify(accepted),
    );
    if (version === 2) {
      const judge = record.judges[0];
      assert.ok(judge?.usage, 'v2 receiver record carries observed usage');
      judge.usage.tokens.inputTokens = -1;
      await writeFile(path, JSON.stringify(record));
      const refused = parseHarness(runHarness(value)).report;
      assert.ok(
        refused.reasons.some((reason) =>
          /review record does not satisfy the strict schema/u.test(reason),
        ),
        JSON.stringify(refused),
      );
    }
  });
}
