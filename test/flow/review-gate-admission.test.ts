import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { reviewErrorExitCode } from '../../src/cli/main.ts';
import { reviewCommand } from '../../src/flow/cli.ts';
import type {
  ListedGateCheckRun,
  ReviewGateCheckRun,
} from '../../src/flow/gate-admission.ts';
import * as flow from '../../src/flow/index.ts';
import {
  CodexHost,
  type CodexSessionResult,
  type CodexStartInput,
} from '../../src/hosts/codex.ts';

function git(repo: string, ...args: string[]): string {
  const child = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

function fixture(
  t: TestContext,
  options: {
    readonly basePolicy?: 'pinned' | 'legacy' | 'invalid';
    readonly headPolicy?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'review-gate-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Gate admission fixture');
  git(repo, 'config', 'user.email', 'gate-admission@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:KRN-WORKS/KRN.git');
  mkdirSync(join(repo, 'spec'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  const policyPath = join(repo, 'spec', 'ci-admission.json');
  const basePolicy = options.basePolicy ?? 'pinned';
  if (basePolicy === 'pinned')
    writeFileSync(
      policyPath,
      '{"schemaVersion":1,"checkRunName":"Check","appId":15368}\n',
    );
  if (basePolicy === 'invalid')
    writeFileSync(policyPath, '{"schemaVersion":2}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture base');
  const base = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(join(repo, 'README.md'), 'clean candidate\n');
  if (options.headPolicy)
    writeFileSync(
      policyPath,
      '{"schemaVersion":1,"checkRunName":"Check","appId":15368}\n',
    );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'feat: clean candidate');
  const head = git(repo, 'rev-parse', 'HEAD');

  const lens = join(directory, 'lens.txt');
  writeFileSync(lens, 'Check acceptance.\n');
  const pull = () => ({
    number: 17,
    title: 'feat: review candidate',
    base: {
      sha: base,
      ref: 'main',
      repo: { full_name: 'KRN-WORKS/KRN' },
    },
    head: { sha: head },
  });
  const input = (prBound = true) => ({
    repo,
    base,
    head,
    lens,
    ...(prBound ? { pr: 17, readPull: async () => pull() } : {}),
  });
  const args = () => [
    '--repo',
    repo,
    '--base',
    base,
    '--head',
    head,
    '--lens',
    lens,
    '--pr',
    '17',
  ];
  const reservations = () =>
    globSync('.krn/runs/review-series/**/reservation.json', { cwd: repo });
  const records = () => globSync('.krn/runs/**/*.json', { cwd: repo });
  return {
    repo,
    base,
    head,
    input,
    args,
    pull,
    reservations,
    records,
    hasRunState: () => existsSync(join(repo, '.krn', 'runs')),
  };
}

function mockHost(t: TestContext) {
  let starts = 0;
  t.mock.method(
    CodexHost.prototype,
    'start',
    async (_input: CodexStartInput) => {
      starts++;
      const message = JSON.stringify({ verdict: 'PASS', findings: [] });
      const id = `session-${starts}`;
      const result: CodexSessionResult = {
        sessionId: id,
        reasonKind: 'turn_complete',
        reasonSha256: 'a'.repeat(64),
        reasonLength: message.length,
        claimsDone: true,
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
  return { starts: () => starts };
}

function gateRun(
  headSha: string,
  overrides: Partial<ReviewGateCheckRun> = {},
): ReviewGateCheckRun {
  return {
    id: 41,
    name: 'Check',
    head_sha: headSha,
    status: 'completed',
    app: { id: 15368 },
    conclusion: 'failure',
    started_at: '2026-11-02T06:27:20Z',
    html_url: 'https://github.com/krn-works/krn/runs/41',
    ...overrides,
  };
}

test('a failed exact-head gate refuses before a PR review attempt is reserved', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const readGateCheckRuns = async (
    repository: string,
    headSha: string,
  ): Promise<ListedGateCheckRun[]> => {
    assert.equal(repository, 'krn-works/krn');
    assert.equal(headSha, f.head);
    const { parseGateCheckRuns } = await import(
      '../../src/flow/gate-admission.ts'
    );
    const captured = parseGateCheckRuns(
      readFileSync(
        new URL(
          '../fixtures/github-check-runs/review-gate-failure.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.name, 'Check');
    assert.equal(captured[0]?.app?.id, 15368);
    assert.equal(captured[0]?.conclusion, 'failure');
    return captured.map((check) => ({ ...check, head_sha: headSha }));
  };

  const result = await flow.runReview({ ...f.input(), readGateCheckRuns }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(
    f.reservations().length,
    0,
    'a failed exact-head gate must refuse before reserving an attempt',
  );
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /Check/u);
  assert.match(result.message, /failure/u);
  assert.match(
    result.message,
    /https:\/\/github\.com\/krn-works\/krn\/runs\/125129571037/u,
  );
  assert.equal(f.records().length, 0);
  assert.equal(f.hasRunState(), false);
  assert.equal(host.starts(), 0);

  await assert.rejects(
    reviewCommand(f.args(), {
      readPull: async () => f.pull(),
      readGateCheckRuns,
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.name : '',
        'ReviewUsageError',
      );
      assert.equal(reviewErrorExitCode(error), 64);
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Check/u,
      );
      assert.match(
        error instanceof Error ? error.message : String(error),
        /failure/u,
      );
      assert.match(
        error instanceof Error ? error.message : String(error),
        /https:\/\/github\.com\/krn-works\/krn\/runs\/125129571037/u,
      );
      return true;
    },
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(f.records().length, 0);
  assert.equal(host.starts(), 0);
});

test('a pending exact-head gate permits one PR review attempt', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const record = await flow.runReview({
    ...f.input(),
    readGateCheckRuns: () => [
      gateRun(f.head, { conclusion: null, status: 'in_progress' }),
    ],
  });
  assert.equal(record.attempt?.ordinal, 1);
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

for (const conclusion of [
  'cancelled',
  'neutral',
  'skipped',
  'stale',
  'action_required',
  'success',
  null,
] as const)
  test(`a latest exact-head gate ${conclusion ?? 'pending'} conclusion is allowed`, async (t) => {
    const f = fixture(t);
    const host = mockHost(t);
    await flow.runReview({
      ...f.input(),
      readGateCheckRuns: () => [
        gateRun(f.head, {
          conclusion,
          ...(conclusion === null ? { status: 'queued' } : {}),
        }),
      ],
    });
    assert.equal(f.reservations().length, 1);
    assert.equal(host.starts(), 3);
  });

test('an absent matching gate check permits a PR review attempt', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  await flow.runReview({ ...f.input(), readGateCheckRuns: () => [] });
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

test('a gate failure from another app or head does not refuse review', async (t) => {
  for (const otherRun of [
    gateRun('f'.repeat(40)),
    gateRun('a'.repeat(40), { app: { id: 1234 } }),
  ]) {
    await t.test(
      otherRun.head_sha === 'f'.repeat(40) ? 'another head' : 'another app',
      async (subtest) => {
        const f = fixture(subtest);
        const host = mockHost(subtest);
        await flow.runReview({
          ...f.input(),
          readGateCheckRuns: () => [
            {
              ...otherRun,
              head_sha:
                otherRun.head_sha === 'f'.repeat(40)
                  ? otherRun.head_sha
                  : f.head,
            },
          ],
        });
        assert.equal(f.reservations().length, 1);
        assert.equal(host.starts(), 3);
      },
    );
  }
});

test('the latest matching rerun determines whether the gate refuses review', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  await flow.runReview({
    ...f.input(),
    readGateCheckRuns: () => [
      gateRun(f.head, {
        id: 99,
        started_at: '2026-11-02T06:00:00Z',
        conclusion: 'failure',
      }),
      gateRun(f.head, {
        id: 20,
        started_at: '2026-11-02T07:00:00Z',
        conclusion: 'failure',
      }),
      gateRun(f.head, {
        id: 21,
        started_at: '2026-11-02T07:00:00Z',
        conclusion: 'success',
      }),
    ],
  });
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

test('a gate check reader error refuses without reserving or starting judges', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  await assert.rejects(
    flow.runReview({
      ...f.input(),
      readGateCheckRuns: () => {
        throw new Error('injected reader failure');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof flow.ReviewAdmissionError);
      assert.match(error.message, /gate check read failed/u);
      return true;
    },
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(f.records().length, 0);
  assert.equal(host.starts(), 0);
});

for (const conclusion of ['timed_out', 'startup_failure'] as const)
  test(`a latest exact-head gate ${conclusion} refuses review`, async (t) => {
    const f = fixture(t);
    const host = mockHost(t);
    const result = await flow
      .runReview({
        ...f.input(),
        readGateCheckRuns: () => [gateRun(f.head, { conclusion })],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.equal(
      f.reservations().length,
      0,
      `${conclusion} must refuse before reserving an attempt`,
    );
    assert.ok(result instanceof flow.ReviewAdmissionError);
    assert.match(result.message, new RegExp(conclusion, 'u'));
    assert.equal(f.records().length, 0);
    assert.equal(host.starts(), 0);
  });

test('a queued null-started rerun is newer than failures and ties by id', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  await flow.runReview({
    ...f.input(),
    readGateCheckRuns: () => [
      gateRun(f.head, {
        id: 99,
        started_at: '2026-11-02T06:00:00Z',
        conclusion: 'failure',
      }),
      gateRun(f.head, {
        id: 20,
        started_at: null,
        status: 'completed',
        conclusion: 'failure',
      }),
      gateRun(f.head, {
        id: 21,
        started_at: null,
        status: 'queued',
        conclusion: null,
      }),
    ],
  });
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

for (const malformed of [
  {
    name: 'non-JSON response',
    response: '{bad',
    reason: 'response is not valid JSON',
  },
  {
    name: 'non-array response',
    response: JSON.stringify({ check_runs: [] }),
    reason: 'response has an invalid check-runs shape',
  },
  {
    name: 'page without check_runs',
    response: JSON.stringify([{}]),
    reason: 'response has an invalid check-runs shape',
  },
  {
    name: 'malformed check run',
    response: JSON.stringify([{ check_runs: [{}] }]),
    reason: 'response has an invalid check-runs shape',
  },
  {
    name: 'completed check without a conclusion',
    response: JSON.stringify([
      {
        check_runs: [
          {
            id: 2,
            name: 'Check',
            head_sha: 'a'.repeat(40),
            status: 'completed',
            app: { id: 15368 },
            conclusion: null,
            started_at: '2026-11-02T06:27:20Z',
            html_url: 'https://github.com/krn-works/krn/runs/2',
          },
        ],
      },
    ]),
    reason: 'matching gate check run has an invalid shape',
  },
])
  test(`malformed gate response ${malformed.name} refuses admission`, async (t) => {
    const f = fixture(t);
    const host = mockHost(t);
    const result = await flow
      .runReview({
        ...f.input(),
        readGateCheckRuns: async () => {
          const { parseGateCheckRuns } = await import(
            '../../src/flow/gate-admission.ts'
          );
          return parseGateCheckRuns(
            malformed.response.replaceAll('a'.repeat(40), f.head),
          );
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.equal(
      f.reservations().length,
      0,
      'malformed gate output must refuse before reserving an attempt',
    );
    assert.ok(result instanceof flow.ReviewAdmissionError);
    assert.match(result.message, /gate check read failed/u);
    assert.ok(result.message.includes(malformed.reason));
    assert.equal(f.records().length, 0);
    assert.equal(host.starts(), 0);
  });

test('a GateCheckReadError preserves its bounded reader reason', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const result = await flow
    .runReview({
      ...f.input(),
      readGateCheckRuns: async () => {
        const { GateCheckReadError } = await import(
          '../../src/flow/gate-admission.ts'
        );
        throw new GateCheckReadError('reader response is invalid');
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.equal(f.reservations().length, 0);
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /gate check read failed/u);
  assert.match(result.message, /reader response is invalid/u);
  assert.equal(f.records().length, 0);
  assert.equal(host.starts(), 0);
});

test('an invalid gate policy at the base refuses before reading checks', async (t) => {
  const f = fixture(t, { basePolicy: 'invalid' });
  const host = mockHost(t);
  let reads = 0;
  const result = await flow
    .runReview({
      ...f.input(),
      readGateCheckRuns: () => {
        reads++;
        return [];
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.equal(f.reservations().length, 0);
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /base gate policy is invalid/u);
  assert.equal(reads, 0);
  assert.equal(host.starts(), 0);
});

test('the legacy base policy matches only gate from GitHub Actions', async (t) => {
  const f = fixture(t, { basePolicy: 'legacy' });
  const host = mockHost(t);
  const result = await flow
    .runReview({
      ...f.input(),
      readGateCheckRuns: () => [
        gateRun(f.head, {
          name: 'gate',
          app: { slug: 'github-actions' },
        }),
      ],
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.equal(f.reservations().length, 0);
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /gate/u);
  assert.match(result.message, /failure/u);
  assert.equal(host.starts(), 0);
});

test('a pinned policy added only at head cannot select its gate check', async (t) => {
  const f = fixture(t, { basePolicy: 'legacy', headPolicy: true });
  const host = mockHost(t);
  await flow.runReview({
    ...f.input(),
    readGateCheckRuns: () => [gateRun(f.head)],
  });
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

test('a non-PR review never reads gate checks', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  let reads = 0;
  const record = await flow.runReview({
    ...f.input(false),
    readGateCheckRuns: () => {
      reads++;
      throw new Error('non-PR review must not read gate checks');
    },
  });
  assert.equal(reads, 0);
  assert.equal(record.attempt, undefined);
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 3);
});

const longRunUrl = `https://github.com/${'o'.repeat(39)}/${'r'.repeat(100)}/runs/1234567890123456`;

test('a long but valid check run URL is parsed and a pending gate is allowed', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  assert.ok(longRunUrl.length > 180);
  const record = await flow.runReview({
    ...f.input(),
    readGateCheckRuns: async () => {
      const { parseGateCheckRuns } = await import(
        '../../src/flow/gate-admission.ts'
      );
      return parseGateCheckRuns(
        JSON.stringify([
          {
            check_runs: [
              gateRun(f.head, {
                status: 'queued',
                conclusion: null,
                started_at: null,
                html_url: longRunUrl,
              }),
            ],
          },
        ]),
      );
    },
  });
  assert.equal(record.attempt?.ordinal, 1);
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);
});

test('a failed gate with a long check run URL refuses with a bounded cause', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const result = await flow
    .runReview({
      ...f.input(),
      readGateCheckRuns: async () => {
        const { parseGateCheckRuns } = await import(
          '../../src/flow/gate-admission.ts'
        );
        return parseGateCheckRuns(
          JSON.stringify([
            { check_runs: [gateRun(f.head, { html_url: longRunUrl })] },
          ]),
        );
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.equal(f.reservations().length, 0);
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /Check/u);
  assert.doesNotMatch(result.message, /gate check read failed/u);
  for (const line of result.message.split('\n'))
    assert.ok(line.length <= 260, `cause line is bounded: ${line.length}`);
  assert.equal(f.records().length, 0);
  assert.equal(host.starts(), 0);
});

test('unusual check runs from other apps do not block a gate decision', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const parseGateCheckRuns = async (response: string) =>
    (await import('../../src/flow/gate-admission.ts')).parseGateCheckRuns(
      response,
    );
  const others = [
    {
      id: 7,
      name: 'x'.repeat(400),
      head_sha: f.head,
      app: { id: 1 },
      html_url: null,
      status: 'mystery',
      conclusion: 'unheard_of',
    },
    { id: 8, name: 'lint', head_sha: f.head, app: null, html_url: null },
  ];
  const record = await flow.runReview({
    ...f.input(),
    readGateCheckRuns: async () =>
      await parseGateCheckRuns(
        JSON.stringify([
          {
            check_runs: [
              ...others,
              gateRun(f.head, { status: 'in_progress', conclusion: null }),
            ],
          },
        ]),
      ),
  });
  assert.equal(record.attempt?.ordinal, 1);
  assert.equal(f.reservations().length, 1);
  assert.equal(host.starts(), 3);

  const g = fixture(t);
  const refused = await flow
    .runReview({
      ...g.input(),
      readGateCheckRuns: async () =>
        await parseGateCheckRuns(
          JSON.stringify([
            {
              check_runs: [
                ...others.map((o) => ({ ...o, head_sha: g.head })),
                gateRun(g.head),
              ],
            },
          ]),
        ),
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(refused instanceof flow.ReviewAdmissionError);
  assert.match(refused.message, /Check/u);
  assert.equal(g.reservations().length, 0);
});

test('a failed gate with a null check run URL still refuses', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const result = await flow
    .runReview({
      ...f.input(),
      readGateCheckRuns: () => [gateRun(f.head, { html_url: null })],
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(result instanceof flow.ReviewAdmissionError);
  assert.match(result.message, /no check run URL/u);
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 0);
});
