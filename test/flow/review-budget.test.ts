import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { z } from 'zod';
import { reviewErrorExitCode } from '../../src/cli/main.ts';
import { reviewCommand } from '../../src/flow/cli.ts';
import { runReview } from '../../src/flow/index.ts';
import { loadPriorReview } from '../../src/flow/prior.ts';
import { appendOverride } from '../../src/flow/record.ts';
import { type ReviewRecord, reviewRecordSchema } from '../../src/flow/types.ts';
import {
  CodexHost,
  type CodexSessionResult,
  type CodexStartInput,
} from '../../src/hosts/codex.ts';

const attemptSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  repository: z.string(),
  pr: z.number(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  exception: z.unknown().optional(),
});
const reportSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string()),
  reviewRecords: z.array(z.record(z.string(), z.unknown())),
});
const preflightUrl = new URL('../../scripts/pr-preflight.mjs', import.meta.url);
const blocking = {
  severity: 'BLOCKING',
  title: 'Empty input fails',
  path: 'README.md',
  line: 1,
  defect: 'Empty input throws.',
  fix: 'Handle empty input.',
};

function git(repo: string, ...args: string[]) {
  const child = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'review-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Budget fixture');
  git(repo, 'config', 'user.email', 'budget@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:KRN-WORKS/KRN.git');
  for (const path of ['src', 'test', 'tasks']) mkdirSync(join(repo, path));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(repo, 'test', 'example.test.ts'), 'export {};\n');
  writeFileSync(
    join(repo, 'tasks', 't-fixture.json'),
    `${JSON.stringify(
      {
        id: 't-fixture',
        status: 'open',
        resolution: null,
        created: '2026-10-28',
        priority: 0,
        title: 'Fixture',
        after: [],
        body: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'README.md'), 'base');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const heads = [1, 2, 3, 4].map((index) => {
    writeFileSync(join(repo, 'README.md'), `candidate ${index}`);
    git(
      repo,
      'commit',
      '-qam',
      `feat: candidate ${index} (t-fixture)\n\nTicket: t-fixture`,
    );
    return git(repo, 'rev-parse', 'HEAD');
  });
  const lens = join(directory, 'lens.txt');
  writeFileSync(lens, 'Check acceptance.');
  let currentBase = base;
  let baseRef = 'main';
  let metadata: unknown;
  const pull = (head: string) => ({
    number: 17,
    title: 'feat: candidate (t-fixture)',
    base: {
      sha: currentBase,
      ref: baseRef,
      repo: { full_name: 'KRN-WORKS/KRN' },
    },
    head: { sha: head, repo: { full_name: 'fork-owner/krn' } },
  });
  const input = (head: string, root = repo) => ({
    repo: root,
    base: currentBase,
    head,
    lens,
    toolSha: base,
    pr: 17,
    readPull: async () => metadata ?? pull(head),
    readGateCheckRuns: async () => [],
  });
  const args = (head: string, root = repo) => [
    '--repo',
    root,
    '--base',
    currentBase,
    '--head',
    head,
    '--lens',
    lens,
    '--pr',
    '17',
  ];
  const files = () =>
    globSync('.krn/runs/review-series/**/*.json', { cwd: repo }).map((path) =>
      join(repo, path),
    );
  const reservations = () =>
    files().filter((path) => /\/attempts\/\d+\/reservation\.json$/u.test(path));
  const records = () =>
    files().filter((path) => /\/records\/\d+\.json$/u.test(path));
  const recordPath = (ordinal: number) =>
    records().find((path) => path.endsWith(`/records/${ordinal}.json`)) ??
    join(repo, '.krn/runs/review', heads[ordinal - 1] ?? '', 'record.json');
  const verify = async (head: string) => {
    const { runPreflight } = await import(preflightUrl.href);
    assert.equal(typeof runPreflight, 'function');
    const raw: unknown = await runPreflight(
      { repo, base: currentBase, head, pr: 17 },
      {
        readPull: async () => ({ ok: true, value: pull(head) }),
        readStatuses: async () => ({
          ok: true,
          value: [
            {
              context: 'krn/gate-local',
              state: 'success',
              creator: { login: 'fixture' },
              description: 'Gate passed: 1 tests, 0 isolation skips',
            },
          ],
        }),
        readCheckRuns: async () => ({
          ok: true,
          value: [
            {
              id: 1,
              name: 'gate',
              head_sha: head,
              app: { slug: 'github-actions' },
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/krn-works/krn/actions/runs/1',
            },
          ],
        }),
      },
    );
    return reportSchema.parse(raw);
  };
  return {
    directory,
    repo,
    base,
    heads,
    lens,
    pull,
    input,
    args,
    files,
    reservations,
    records,
    recordPath,
    verify,
    metadata: (value: unknown) => {
      metadata = value;
    },
    baseRef: (value: string) => {
      baseRef = value;
    },
    baseSha: (value: string) => {
      currentBase = value;
    },
  };
}
function head(f: ReturnType<typeof fixture>, index: number) {
  const value = f.heads[index];
  assert.ok(value);
  return value;
}
function bound(record: ReviewRecord) {
  const attempt: unknown = Reflect.get(record, 'attempt');
  const result = attemptSchema.safeParse(attempt);
  assert.equal(
    result.success,
    true,
    'PR record must carry bounded attempt provenance',
  );
  if (!result.success) throw new Error('invalid attempt');
  return result.data;
}
function mockHost(t: TestContext) {
  let starts = 0;
  let fail = false;
  let incomplete = false;
  t.mock.method(
    CodexHost.prototype,
    'start',
    async (input: CodexStartInput) => {
      starts++;
      const prior = input.prompt.includes('PRIOR BLOCKING FINDINGS');
      const message = JSON.stringify({
        verdict: fail && !prior ? 'FAIL' : 'PASS',
        findings: fail && !prior ? [blocking] : [],
        ...(prior
          ? {
              prior: [0, 1, 2].map((index) => ({
                index,
                status: 'RESOLVED',
                evidence: 'Checked the fix.',
              })),
            }
          : {}),
      });
      const id = `session-${starts}`;
      const result: CodexSessionResult = {
        sessionId: id,
        reasonKind: 'turn_complete',
        reasonSha256: 'a'.repeat(64),
        reasonLength: message.length,
        claimsDone: !incomplete,
        finalMessage: message,
        exitCode: 0,
        signal: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        usageObservation: {
          turnsStarted: 1,
          turnsCompleted: 1,
          invalidFields: 0,
          missingRequiredTurns: 0,
        },
      };
      return { id, wait: async () => result };
    },
  );
  return {
    starts: () => starts,
    fail: (value: boolean) => {
      fail = value;
    },
    incomplete: (value: boolean) => {
      incomplete = value;
    },
  };
}

for (const prior of [false, true])
  test(`two ${prior ? 'reused first FAIL' : 'fresh'} calls exhaust the PR budget before the fake host`, async (t) => {
    const f = fixture(t);
    const host = mockHost(t);
    host.fail(prior);
    const first = await runReview(f.input(head(f, 0)));
    const priorPath = f.recordPath(1);
    const secondHead = head(f, 1);
    assert.ok(priorPath);
    const extra = prior ? ['--prior-record', priorPath] : [];
    await reviewCommand([...f.args(secondHead), ...extra], {
      readPull: async () => f.pull(secondHead),
      readGateCheckRuns: async () => [],
    });
    const before = host.starts();
    const thirdHead = head(f, 2);
    await assert.rejects(
      reviewCommand([...f.args(thirdHead), ...extra], {
        readPull: async () => f.pull(thirdHead),
        readGateCheckRuns: async () => [],
      }),
      /budget|two attempts/iu,
    );
    assert.equal(
      host.starts(),
      before,
      'attempt 3 must refuse before the fake host',
    );
    assert.equal(f.reservations().length, 2);
    assert.equal(bound(first).ordinal, 1);
  });

test('head, session, worktree, remote spelling and shifted main preserve the base repository series', async (t) => {
  const f = fixture(t);
  mockHost(t);
  await runReview(f.input(head(f, 0)));
  const linked = join(f.directory, 'linked');
  git(f.repo, 'worktree', 'add', '-q', '--detach', linked, head(f, 1));
  git(
    f.repo,
    'remote',
    'set-url',
    'origin',
    'https://github.com/krn-works/krn.git',
  );
  f.baseSha(head(f, 0));
  const second = await runReview(f.input(head(f, 1), linked));
  assert.equal(bound(second).ordinal, 2);
  assert.equal(bound(second).repository, 'krn-works/krn');
  assert.equal(bound(second).baseSha, head(f, 0));
  await assert.rejects(runReview(f.input(head(f, 2))), /budget|two attempts/iu);
});

test('input and authoritative PR errors consume zero attempts', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const target = head(f, 0);
  for (const metadata of [
    {},
    { ...f.pull(target), number: 18 },
    { ...f.pull(target), base: { ...f.pull(target).base, sha: target } },
    f.pull(head(f, 1)),
  ]) {
    f.metadata(metadata);
    await assert.rejects(runReview(f.input(target)), /PR|metadata/iu);
  }
  f.metadata(undefined);
  for (const extra of [
    { panel: [] },
    { prepassChecklist: '\0' },
    { prepassChecklist: '界'.repeat(32768) },
  ])
    await assert.rejects(runReview({ ...f.input(target), ...extra }));
  await assert.rejects(
    reviewCommand([...f.args(target), '--unknown'], {
      readPull: async () => f.pull(target),
      readGateCheckRuns: async () => [],
    }),
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 0);
  const record = await runReview(f.input(target));
  assert.equal(bound(record).ordinal, 1);
});

test('an established PR base ref is immutable and wrong exceptions consume nothing', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  await runReview(f.input(head(f, 0)));
  f.baseRef('release');
  await assert.rejects(runReview(f.input(head(f, 1))), /base ref/iu);
  f.baseRef('main');
  await runReview(f.input(head(f, 1)));
  const path = join(f.directory, 'exception.json');
  const exception = {
    schemaVersion: 1,
    repository: 'krn-works/krn',
    pr: 17,
    baseRef: 'main',
    ordinal: 3,
    headSha: head(f, 2),
    authority: 'Explicit operator grant',
    evidence: 'Verbatim exception for this ordinal and head',
  };
  for (const changed of [
    { pr: 18 },
    { repository: 'other/repo' },
    { baseRef: 'release' },
    { ordinal: 4 },
    { headSha: head(f, 3) },
    { authority: '' },
    { unknown: true },
  ]) {
    writeFileSync(path, JSON.stringify({ ...exception, ...changed }));
    await assert.rejects(
      runReview({ ...f.input(head(f, 2)), budgetException: path }),
    );
  }
  assert.equal(f.reservations().length, 2);
  assert.equal(host.starts(), 6);
  writeFileSync(path, JSON.stringify(exception));
  const third = await runReview({
    ...f.input(head(f, 2)),
    budgetException: path,
  });
  assert.equal(bound(third).ordinal, 3);
  assert.deepEqual(bound(third).exception, exception);
  const admitted = await f.verify(head(f, 2));
  assert.equal(admitted.verdict, 'pass', admitted.reasons.join('\n'));
  await assert.rejects(
    runReview({ ...f.input(head(f, 3)), budgetException: path }),
    /exception/iu,
  );
  await assert.rejects(runReview(f.input(head(f, 3))), /budget/iu);
  assert.equal(f.reservations().length, 3);
});

test('receiver verifies exact record, reservation and PR binding', async (t) => {
  const f = fixture(t);
  mockHost(t);
  const target = head(f, 0);
  const record = await runReview(f.input(target));
  const path = f.recordPath(1);
  assert.ok(path);
  const attempt: unknown = Reflect.get(record, 'attempt');
  assert.ok(typeof attempt === 'object' && attempt !== null);
  for (const mismatch of [
    { repository: 'other/repo' },
    { pr: 18 },
    { baseRef: 'release' },
    { ordinal: 2 },
    { id: '00000000-0000-4000-8000-000000000000' },
    { baseSha: target },
    { headSha: head(f, 1) },
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ ...record, attempt: { ...attempt, ...mismatch } }),
    );
    const report = await f.verify(target);
    assert.equal(report.verdict, 'fail');
    assert.match(report.reasons.join('\n'), /binding|schema/iu);
  }
  writeFileSync(path, JSON.stringify(record));
  assert.equal((await f.verify(target)).verdict, 'pass');
});

test('help states prior panel roles, deterministic blocking and separate budget exceptions', () => {
  const cli = new URL('../../src/cli/main.ts', import.meta.url);
  const result = spawnSync(
    process.execPath,
    [cli.pathname, 'review', '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /same panel roles/u);
  assert.match(result.stdout, /Deterministic checks always block/u);
  assert.match(result.stdout, /--budget-exception/u);
  assert.match(result.stdout, /override does not grant review budget/u);
});

for (const corruption of [
  'invalid JSON',
  'gap',
  'missing reservations',
  'missing reservation file',
  'missing metadata',
  'symlink',
  'BOM',
])
  test(`series ${corruption} fails closed before host cost`, async (t) => {
    const f = fixture(t);
    const host = mockHost(t);
    await runReview(f.input(head(f, 0)));
    const reservation = f.reservations()[0];
    assert.ok(reservation);
    const series = dirname(dirname(dirname(reservation)));
    if (corruption === 'invalid JSON') writeFileSync(reservation, '{}');
    if (corruption === 'BOM')
      writeFileSync(reservation, `\ufeff${readFileSync(reservation, 'utf8')}`);
    if (corruption === 'gap') {
      mkdirSync(join(series, 'attempts', '3'));
      writeFileSync(
        join(series, 'attempts', '3', 'reservation.json'),
        readFileSync(reservation),
      );
    }
    if (corruption === 'missing reservations')
      rmSync(join(series, 'attempts'), { recursive: true });
    if (corruption === 'missing reservation file') rmSync(reservation);
    if (corruption === 'missing metadata') rmSync(join(series, 'series.json'));
    if (corruption === 'symlink') {
      const copy = join(f.directory, 'copy.json');
      writeFileSync(copy, readFileSync(reservation));
      rmSync(reservation);
      symlinkSync(copy, reservation);
    }
    await assert.rejects(runReview(f.input(head(f, 1))));
    assert.equal(host.starts(), 3);
    assert.equal((await f.verify(head(f, 0))).verdict, 'fail');
  });

test('prior verification preserves panel roles before reserving an attempt', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  host.fail(true);
  await runReview(f.input(head(f, 0)));
  const path = f.recordPath(1);
  assert.ok(path);
  await assert.rejects(
    runReview({
      ...f.input(head(f, 1)),
      panel: ['standards'],
      priorRecord: path,
    }),
    /same panel roles/iu,
  );
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

test('prior verification refuses duplicate roles in a legacy record', (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'legacy-prior.json');
  const prior = {
    schemaVersion: 1,
    headSha: head(f, 0),
    base: f.base,
    createdAt: '2026-01-01T00:00:00.000Z',
    panelVerdict: 'FAIL',
    redFirst: [],
    judges: ['standards', 'standards', 'adversarial'].map((role) => ({
      state: 'complete',
      role,
      verdict: 'FAIL',
      findings: [blocking],
      sessionId: `prior-${role}`,
      finalMessage: 'Prior evidence',
    })),
  };
  assert.equal(reviewRecordSchema.safeParse(prior).success, true);
  writeFileSync(path, JSON.stringify(prior));
  assert.throws(
    () =>
      loadPriorReview(f.repo, head(f, 1), path, {
        panel: ['standards', 'spec', 'adversarial'],
      }),
    /same panel roles/iu,
  );
});

test('current incomplete evidence refuses admission while complete attempt 2 may follow incomplete 1', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  host.incomplete(true);
  await runReview(f.input(head(f, 0)));
  assert.equal((await f.verify(head(f, 0))).verdict, 'fail');
  host.incomplete(false);
  await runReview(f.input(head(f, 1)));
  const report = await f.verify(head(f, 1));
  assert.equal(report.verdict, 'pass', report.reasons.join('\n'));
  assert.deepEqual(
    Object.keys(report.reviewRecords[0] ?? {}).sort(),
    [
      'path',
      'sha256',
      'headSha',
      'base',
      'panelVerdict',
      'verdict',
      'panel',
      'judges',
      'lensSha256',
      'toolSha',
      'redFirstCount',
    ].sort(),
  );
  const path = f.recordPath(2);
  assert.ok(path);
  const bytes = readFileSync(path, 'utf8');
  const raw: unknown = JSON.parse(bytes);
  assert.ok(typeof raw === 'object' && raw !== null && 'attempt' in raw);
  Reflect.deleteProperty(raw, 'attempt');
  writeFileSync(path, JSON.stringify(raw));
  const unbound = await f.verify(head(f, 1));
  assert.equal(unbound.verdict, 'fail');
  assert.match(unbound.reasons.join('\n'), /unbound legacy/iu);
});

test('an earlier PASS cannot hide the current incomplete attempt on the same exact head', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const target = head(f, 0);
  const first = await runReview(f.input(target));
  host.incomplete(true);
  await assert.doesNotReject(() => runReview(f.input(target)));
  const report = await f.verify(target);
  assert.equal(report.verdict, 'fail');
  assert.match(report.reasons.join('\n'), /INCOMPLETE/u);
  const currentPath = f.recordPath(2);
  assert.ok(currentPath);
  rmSync(currentPath);
  const reservation = f
    .reservations()
    .find((path) => path.includes('/attempts/2/'));
  assert.ok(reservation);
  const raw: unknown = JSON.parse(readFileSync(reservation, 'utf8'));
  assert.ok(typeof raw === 'object' && raw !== null);
  Reflect.set(raw, 'id', bound(first).id);
  writeFileSync(reservation, JSON.stringify(raw));
  const missing = await f.verify(target);
  assert.equal(missing.verdict, 'fail');
  assert.match(missing.reasons.join('\n'), /incomplete/u);
});

test('acceptance override preserves PR binding and cannot bypass deterministic FAIL', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  host.fail(true);
  const first = await runReview(f.input(head(f, 0)));
  const target = head(f, 0);
  await reviewCommand(
    [
      '--repo',
      f.repo,
      '--base',
      f.base,
      '--head',
      target,
      '--pr',
      '17',
      '--override',
      '--reason',
      'Operator accepts defect',
      '--evidence',
      'Concrete evidence',
    ],
    {
      readPull: async () => f.pull(target),
      readGateCheckRuns: async () => [],
    },
  );
  const path = f.recordPath(1);
  assert.ok(path);
  const updated = reviewRecordSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  assert.deepEqual(bound(updated), bound(first));
  assert.equal((await f.verify(target)).verdict, 'pass');
  const failed = {
    path: 'test/contract.test.ts',
    side: 'head',
    sha: target,
    classification: 'assertion',
    exitCode: 1,
    durationMs: 0,
    outputSha256: 'a'.repeat(64),
    summary: 'assertion',
  };
  writeFileSync(
    path,
    JSON.stringify({
      ...updated,
      redFirst: [failed],
      redFirstCauses: [
        { path: failed.path, verdict: 'FAIL', cause: 'head: assertion' },
      ],
    }),
  );
  const refused = await f.verify(target);
  assert.equal(refused.verdict, 'fail');
  assert.match(refused.reasons.join('\n'), /deterministic red-first FAIL/u);
  assert.throws(() =>
    appendOverride(f.repo, target, { reason: 'retry', evidence: 'none' }),
  );
  assert.equal(host.starts(), 3);
});

// Separate processes exercise the same real API/CLI and atomic filesystem owner.
async function childReview(
  f: ReturnType<typeof fixture>,
  target: string,
  crash = false,
) {
  const script = join(f.directory, `caller-${target}.mjs`);
  const source = `
import { reviewCommand } from ${JSON.stringify(new URL('../../src/flow/cli.ts', import.meta.url).href)};
import { CodexHost } from ${JSON.stringify(new URL('../../src/hosts/codex.ts', import.meta.url).href)};
CodexHost.prototype.start = async () => { ${crash ? 'process.exit(77);' : ''}
const text = JSON.stringify({ verdict: 'PASS', findings: [] });
return { id: 'child', wait: async () => ({ sessionId: 'child', reasonKind: 'turn_complete', reasonSha256: 'a'.repeat(64), reasonLength: text.length, claimsDone: true, finalMessage: text, exitCode: 0, signal: null, usage: {}, usageObservation: { turnsStarted: 1, turnsCompleted: 1, invalidFields: 0, missingRequiredTurns: 0 } }) }; };
try { await reviewCommand(${JSON.stringify(f.args(target))}, { readPull: async () => (${JSON.stringify(f.pull(target))}), readGateCheckRuns: async () => [] }); }
catch (error) { process.stderr.write(error.message); process.exitCode = 64; }
`;
  writeFileSync(script, source);
  return new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (value: string) => {
        stderr += value;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
    },
  );
}

test('concurrent processes cannot reuse an ordinal or exceed two reservations', async (t) => {
  const f = fixture(t);
  const outcomes = await Promise.all(
    f.heads.map((target) => childReview(f, target)),
  );
  const ordinals = f
    .reservations()
    .map(
      (path) =>
        attemptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).ordinal,
    )
    .sort();
  assert.deepEqual(ordinals, [1, 2]);
  assert.equal(
    outcomes.filter(({ code }) => code === 0).length,
    2,
    JSON.stringify(outcomes),
  );
  assert.equal(outcomes.filter(({ code }) => code === 64).length, 2);
});

test('crash after reservation consumes one without a final record and later complete evidence admits', async (t) => {
  const f = fixture(t);
  const outcome = await childReview(f, head(f, 0), true);
  assert.equal(outcome.code, 77, outcome.stderr);
  assert.equal(f.reservations().length, 1);
  assert.equal(f.records().length, 0);
  const incomplete = await f.verify(head(f, 0));
  assert.equal(incomplete.verdict, 'fail');
  assert.match(incomplete.reasons.join('\n'), /incomplete/iu);
  mockHost(t);
  const second = await runReview(f.input(head(f, 0)));
  assert.equal(bound(second).ordinal, 2);
  const complete = await f.verify(head(f, 0));
  assert.equal(complete.verdict, 'pass', complete.reasons.join('\n'));
  assert.equal(reviewErrorExitCode(new Error('operational failure')), 70);
  assert.equal(
    existsSync(join(f.repo, '.krn/runs/review', head(f, 0), 'record.json')),
    false,
  );
});

test('missing reservation metadata after a crash never reopens its consumed slot', async (t) => {
  const f = fixture(t);
  const target = head(f, 0);
  assert.equal((await childReview(f, target, true)).code, 77);
  const reservation = f.reservations()[0];
  assert.ok(reservation);
  rmSync(reservation);
  const host = mockHost(t);
  await assert.rejects(runReview(f.input(head(f, 1))), /missing|corrupt/iu);
  assert.equal(host.starts(), 0);
  assert.equal((await f.verify(target)).verdict, 'fail');
});
