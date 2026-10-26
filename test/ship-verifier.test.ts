import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { newReviewRecordSchema } from '../src/flow/types.ts';
import { serializeTask } from '../src/task/record.ts';
import {
  gateCheck,
  reviewEvidence,
  writeReviewEvidence,
} from './helpers/ship-evidence.ts';

const scriptUrl = new URL('../scripts/pr-preflight.mjs', import.meta.url);
// The CLI is a JavaScript boundary; validate its returned JSON below.
const { runPreflight } = await import(scriptUrl.href);
const reportSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string()),
  base: z.string().optional(),
  head: z.string().optional(),
  reviewRecords: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        base: z.string().optional(),
        headSha: z.string().optional(),
        panelVerdict: z.string().optional(),
        verdict: z.string().optional(),
        panel: z.unknown().optional(),
        judges: z
          .array(
            z.object({
              role: z.string(),
              state: z.string(),
              verdict: z.string().optional(),
              model: z.string(),
            }),
          )
          .optional(),
        lensSha256: z.string().optional(),
        toolSha: z.string().optional(),
        override: z.object({ reason: z.string() }).optional(),
        redFirstCount: z.number().optional(),
      }),
    )
    .default([]),
  gateCheckRun: z
    .object({
      id: z.number(),
      url: z.string(),
      conclusion: z.string().nullable(),
      status: z.string(),
    })
    .optional(),
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-ship-verifier-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repository');
  await mkdir(repo);
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ])
    delete env[key];
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Ship verifier fixture']);
  git(['config', 'user.email', 'ship@example.test']);
  git(['remote', 'add', 'origin', 'https://github.com/krn-works/krn.git']);
  await mkdir(join(repo, 'src'));
  await mkdir(join(repo, 'test'));
  await mkdir(join(repo, 'tasks'));
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  await writeFile(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'test', 'example.test.ts'), 'export {};\n');
  await writeFile(
    join(repo, 'tasks', 'LON-230.json'),
    serializeTask({
      id: 'LON-230',
      status: 'open',
      resolution: null,
      created: '2026-10-26',
      priority: 1,
      title: 'Ship fixture',
      after: [],
      body: [],
    }),
  );
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture root']);
  const base = git(['rev-parse', 'HEAD']);
  git([
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture head',
    '-m',
    'Ticket: LON-230',
  ]);
  const head = git(['rev-parse', 'HEAD']);
  const input = { repo, base, head, pr: 27 };
  const pull = {
    title: 'feat(ship): verify fixture (LON-230)',
    base: { sha: base },
    head: { sha: head },
  };
  const statuses = [
    {
      context: 'krn/gate-local',
      state: 'success',
      creator: { login: 'fixture' },
      description: 'Gate passed: 1 tests, 0 isolation skips',
    },
  ];
  const record = reviewEvidence(base, head);
  const recordPath = await writeReviewEvidence(repo, base, head, record);
  const verify = async (checks: unknown = [gateCheck()]) =>
    reportSchema.parse(
      await runPreflight(input, {
        readPull: async () => ({ ok: true, value: pull }),
        readStatuses: async () => ({ ok: true, value: statuses }),
        readCheckRuns: async (...args: unknown[]) => {
          assert.deepEqual(args, [repo, 'krn-works/krn', head]);
          return { ok: true, value: checks };
        },
      }),
    );
  const save = (value: unknown) =>
    writeFile(recordPath, `${JSON.stringify(value)}\n`);
  return {
    directory,
    repo,
    git,
    env,
    input,
    pull,
    statuses,
    base,
    head,
    record,
    recordPath,
    verify,
    save,
  };
}

function refused(report: z.infer<typeof reportSchema>, reason: RegExp) {
  assert.equal(report.verdict, 'fail', JSON.stringify(report));
  assert.match(report.reasons.join('\n'), reason);
}

test('complete review and Actions gate pass with reproducible evidence and no repository writes', async (t) => {
  const value = await fixture(t);
  const beforeStatus = value.git(['status', '--porcelain']);
  const beforeHead = value.git(['rev-parse', 'HEAD']);
  const bytes = await readFile(value.recordPath);
  const report = await value.verify();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.deepEqual(report.reasons, []);
  assert.equal(report.base, value.base);
  assert.equal(report.head, value.head);
  assert.deepEqual(report.reviewRecords, [
    {
      path: value.recordPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base: value.base,
      headSha: value.head,
      panelVerdict: 'PASS',
      verdict: 'PASS',
      panel: value.record.panel,
      judges: value.record.judges.map(({ role, state, verdict, model }) => ({
        role,
        state,
        verdict,
        model,
      })),
      lensSha256: value.record.lensSha256,
      toolSha: value.record.toolSha,
      redFirstCount: 0,
    },
  ]);
  assert.deepEqual(report.gateCheckRun, {
    id: 1,
    url: gateCheck().html_url,
    status: 'completed',
    conclusion: 'success',
  });
  assert.equal(value.git(['status', '--porcelain']), beforeStatus);
  assert.equal(value.git(['rev-parse', 'HEAD']), beforeHead);
  assert.deepEqual(await readFile(value.recordPath), bytes);
});

test('no review record refuses admission', async (t) => {
  const value = await fixture(t);
  await rm(value.recordPath);
  refused(await value.verify(), /review.*missing/u);
});

test('a record stored for another head does not satisfy review', async (t) => {
  const value = await fixture(t);
  await rename(
    dirname(value.recordPath),
    join(dirname(dirname(value.recordPath)), value.base),
  );
  refused(await value.verify(), /review.*missing/u);
});

test('a record whose head differs from its directory is refused', async (t) => {
  const value = await fixture(t);
  await value.save({ ...value.record, headSha: value.base });
  refused(await value.verify(), /review.*head.*match/u);
});

test('unparsable review JSON is refused', async (t) => {
  const value = await fixture(t);
  await writeFile(value.recordPath, '{broken');
  refused(await value.verify(), /review.*JSON/u);
});

for (const key of ['panel', 'lensSha256', 'toolSha'] as const) {
  test(`review missing ${key} is refused by the strict schema`, async (t) => {
    const value = await fixture(t);
    const record: Record<string, unknown> = { ...value.record };
    delete record[key];
    await value.save(record);
    refused(await value.verify(), /review.*schema/u);
  });
}

test('a schema-valid partial panel is refused', async (t) => {
  const value = await fixture(t);
  const record = {
    ...value.record,
    panelVerdict: 'INCOMPLETE',
    panel: {
      ...value.record.panel,
      requestedRoles: ['standards'],
      partial: true,
    },
    judges: value.record.judges.slice(0, 1),
  };
  newReviewRecordSchema.parse(record);
  await value.save(record);
  refused(await value.verify(), /review.*INCOMPLETE/u);
});

test('a schema-valid incomplete judge is refused', async (t) => {
  const value = await fixture(t);
  const record = {
    ...value.record,
    panelVerdict: 'INCOMPLETE',
    judges: [
      {
        state: 'incomplete',
        role: 'standards',
        reason: 'nonzero_exit',
        reasonKind: 'exit',
        sessionId: 'incomplete',
        exitCode: 1,
        model: 'fixture-standards',
        reasoningEffort: 'high',
      },
      ...value.record.judges.slice(1),
    ],
  };
  newReviewRecordSchema.parse(record);
  await value.save(record);
  refused(await value.verify(), /review.*INCOMPLETE/u);
});

function failedReview(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...value.record,
    panelVerdict: 'FAIL',
    judges: value.record.judges.map((judge, index) =>
      index === 0 ? { ...judge, verdict: 'FAIL' } : judge,
    ),
  };
}

const override = {
  reason: 'Lead accepts the recorded defect',
  evidence: 'Observed receiver proof',
  appendedAt: '2026-10-26T11:00:00Z',
};

test('FAIL without override is refused', async (t) => {
  const value = await fixture(t);
  await value.save(newReviewRecordSchema.parse(failedReview(value)));
  refused(await value.verify(), /review.*FAIL/u);
});

test('FAIL with a valid override passes and reports its reason', async (t) => {
  const value = await fixture(t);
  await value.save(
    newReviewRecordSchema.parse({ ...failedReview(value), override }),
  );
  const report = await value.verify();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.equal(report.reviewRecords[0]?.verdict, 'overridden');
  assert.equal(report.reviewRecords[0]?.override?.reason, override.reason);
});

test('an override without a complete FAIL is refused', async (t) => {
  const value = await fixture(t);
  await value.save({ ...value.record, override });
  refused(await value.verify(), /override.*complete FAIL/u);
});

for (const malformed of [true, { reason: 'Missing evidence and timestamp' }]) {
  test(`a malformed override ${JSON.stringify(malformed)} is refused`, async (t) => {
    const value = await fixture(t);
    await value.save({ ...failedReview(value), override: malformed });
    refused(await value.verify(), /review.*schema/u);
  });
}

test('a PASS in one worktree cannot hide a FAIL in another', async (t) => {
  const value = await fixture(t);
  const worktree = join(value.directory, 'registered worktree');
  value.git(['worktree', 'add', '--quiet', '--detach', worktree, value.head]);
  const path = await writeReviewEvidence(
    worktree,
    value.base,
    value.head,
    failedReview(value),
  );
  const report = await value.verify();
  refused(report, /review.*FAIL/u);
  assert.equal(report.reviewRecords.length, 2);
  assert.ok(report.reviewRecords.some((record) => record.path === path));
});

test('review is discovered in a registered worktree when invoked from another worktree', async (t) => {
  const value = await fixture(t);
  const worktree = join(value.directory, 'registered worktree');
  value.git(['worktree', 'add', '--quiet', '--detach', worktree, value.head]);
  const path = await writeReviewEvidence(worktree, value.base, value.head);
  await rm(value.recordPath);
  const report = await value.verify();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.equal(report.reviewRecords[0]?.path, path);
});

test('a branch review base ancestral only to head is refused against the PR base', async (t) => {
  const value = await fixture(t);
  value.git([
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'branch head',
    '-m',
    'Ticket: LON-230',
  ]);
  const head = value.git(['rev-parse', 'HEAD']);
  await writeReviewEvidence(value.repo, value.head, head);
  const report = reportSchema.parse(
    await runPreflight(
      { ...value.input, head },
      {
        readPull: async () => ({
          ok: true,
          value: { ...value.pull, head: { sha: head } },
        }),
        readStatuses: async () => ({ ok: true, value: value.statuses }),
        readCheckRuns: async () => ({ ok: true, value: [gateCheck()] }),
      },
    ),
  );
  refused(report, /review base.*ancestor of.*--base/u);
});

test('a review base not ancestral to head or PR base reports both failures', async (t) => {
  const value = await fixture(t);
  value.git(['checkout', '--quiet', '--detach', value.base]);
  value.git(['commit', '--quiet', '--allow-empty', '-m', 'unrelated sibling']);
  await value.save({ ...value.record, base: value.git(['rev-parse', 'HEAD']) });
  const report = await value.verify();
  refused(report, /review base.*ancestor of.*--base/u);
  assert.match(report.reasons.join('\n'), /review base.*ancestor of.*--head/u);
});

test('a non-SHA review base is refused', async (t) => {
  const value = await fixture(t);
  await value.save({ ...value.record, base: 'HEAD~1' });
  refused(await value.verify(), /review base.*full.*commit/u);
});

for (const target of ['record', 'head directory', 'state directory'] as const) {
  test(`a symlinked ${target} is refused`, async (t) => {
    const value = await fixture(t);
    const path =
      target === 'record'
        ? value.recordPath
        : target === 'head directory'
          ? dirname(value.recordPath)
          : join(value.repo, '.krn');
    const moved = join(value.directory, 'symlink-target');
    await rename(path, moved);
    await symlink(moved, path);
    refused(await value.verify(), /review.*(?:unsafe|regular|symlink)/u);
  });
}

test('an oversized review record is refused', async (t) => {
  const value = await fixture(t);
  await writeFile(
    value.recordPath,
    `${JSON.stringify(value.record)}${' '.repeat(1024 * 1024)}`,
  );
  refused(await value.verify(), /review.*(?:size|large|MiB)/u);
});

test('BOM is refused rather than stripped from review bytes', async (t) => {
  const value = await fixture(t);
  await writeFile(value.recordPath, `\uFEFF${JSON.stringify(value.record)}`);
  refused(await value.verify(), /review.*JSON/u);
});

test('CRLF JSON is accepted and hashed without byte normalization', async (t) => {
  const value = await fixture(t);
  const bytes = Buffer.from(
    `${JSON.stringify(value.record, null, 2).replaceAll('\n', '\r\n')}\r\n`,
  );
  await writeFile(value.recordPath, bytes);
  const report = await value.verify();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.equal(
    report.reviewRecords[0]?.sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
});

for (const [name, checks] of [
  ['no check-runs', []],
  ['gate failure', [{ ...gateCheck(), conclusion: 'failure' }]],
  [
    'gate in progress',
    [{ ...gateCheck(), status: 'in_progress', conclusion: null }],
  ],
  ['gate neutral', [{ ...gateCheck(), conclusion: 'neutral' }]],
  [
    'newer failed rerun',
    [
      gateCheck(),
      {
        ...gateCheck(2),
        created_at: '2026-10-26T11:00:00Z',
        conclusion: 'failure',
      },
    ],
  ],
  [
    'newer failure with equal timestamp',
    [{ ...gateCheck(2), conclusion: 'failure' }, gateCheck()],
  ],
  ['foreign-only gate', [{ ...gateCheck(), app: { slug: 'other-app' } }]],
  ['other green checks', [{ ...gateCheck(), name: 'unrelated' }]],
] as const) {
  test(`${name} refuses CI admission`, async (t) => {
    const value = await fixture(t);
    refused(await value.verify(checks), /gate.*check-run/u);
  });
}

test('a newer gate from another app cannot hide the Actions gate', async (t) => {
  const value = await fixture(t);
  const report = await value.verify([
    gateCheck(),
    { ...gateCheck(2), app: { slug: 'other-app' }, conclusion: 'failure' },
  ]);
  assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
  assert.equal(report.gateCheckRun?.id, 1);
});

test('Ticket, task, gate-local, review and CI failures are reported together', async (t) => {
  const value = await fixture(t);
  value.pull.title = 'feat(ship): unknown task (LON-999)';
  const status = value.statuses[0];
  assert.ok(status);
  status.state = 'failure';
  status.description = 'Gate passed: 1 tests, 2 isolation skips';
  await rm(value.recordPath);
  const report = await value.verify([]);
  refused(report, /Ticket trailer/u);
  for (const reason of [
    /task LON-999.*missing/u,
    /gate-local.*not success/u,
    /zero isolation skips/u,
    /review.*missing/u,
    /gate.*check-run/u,
  ])
    assert.match(report.reasons.join('\n'), reason);
});

async function cliFixture(
  value: Awaited<ReturnType<typeof fixture>>,
  checks: unknown[],
  total = checks.length,
) {
  const bin = join(value.directory, 'bin');
  await mkdir(bin);
  const gh = join(bin, 'gh');
  await writeFile(
    gh,
    `#!${process.execPath}
const resource = process.argv[3];
const pull = ${JSON.stringify(value.pull)};
const statuses = ${JSON.stringify(value.statuses)};
const checks = ${JSON.stringify(checks)};
if (resource.includes('/pulls/')) console.log(JSON.stringify(pull));
else if (resource.includes('/statuses')) console.log(JSON.stringify(statuses));
else if (resource.includes('/check-runs')) {
  const url = new URL(resource, 'https://api.github.com/');
  const page = Number(url.searchParams.get('page') || 1);
  console.log(JSON.stringify({ total_count: ${total}, check_runs: checks.slice((page - 1) * 100, page * 100) }));
} else process.exitCode = 1;
`,
  );
  await chmod(gh, 0o755);
  return () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(scriptUrl),
        '--repo',
        value.repo,
        '--base',
        value.base,
        '--head',
        value.head,
        '--pr',
        '27',
      ],
      {
        cwd: value.directory,
        env: { ...value.env, PATH: `${bin}:${value.env.PATH}` },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
}

test('CLI reads the real API boundary and preserves JSON and exit codes 0/1', async (t) => {
  const value = await fixture(t);
  const invoke = await cliFixture(value, [gateCheck()]);
  const pass = invoke();
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(reportSchema.parse(JSON.parse(pass.stdout)).verdict, 'pass');
  await rm(value.recordPath);
  const fail = invoke();
  assert.equal(fail.status, 1, fail.stderr);
  refused(reportSchema.parse(JSON.parse(fail.stdout)), /review.*missing/u);
});

test('CLI paginates all check-runs before selecting the newest gate', async (t) => {
  const value = await fixture(t);
  const checks = [
    gateCheck(),
    ...Array.from({ length: 99 }, (_, index) => ({
      ...gateCheck(index + 10),
      name: 'unrelated',
    })),
    {
      ...gateCheck(200),
      created_at: '2026-10-26T11:00:00Z',
      conclusion: 'failure',
    },
  ];
  const result = (await cliFixture(value, checks))();
  assert.equal(result.status, 1, result.stderr);
  const report = reportSchema.parse(JSON.parse(result.stdout));
  refused(report, /gate.*check-run/u);
  assert.equal(report.gateCheckRun?.id, 200);
});

test('CLI refuses check-run evidence exceeding the pagination bound', async (t) => {
  const value = await fixture(t);
  const checks = Array.from({ length: 1001 }, (_, index) =>
    gateCheck(index + 1),
  );
  const result = (await cliFixture(value, checks))();
  assert.equal(result.status, 1, result.stderr);
  refused(reportSchema.parse(JSON.parse(result.stdout)), /check-runs.*read/u);
});

test('repository ship policy declares the existing verifier argv', async () => {
  assert.deepEqual(
    JSON.parse(
      await readFile(new URL('../krn.ship.json', import.meta.url), 'utf8'),
    ),
    { version: 1, verify: ['scripts/pr-preflight.mjs'] },
  );
});
