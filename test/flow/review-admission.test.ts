import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { reviewErrorExitCode } from '../../src/cli/main.ts';
import { reviewCommand } from '../../src/flow/cli.ts';
import * as flow from '../../src/flow/index.ts';
import { ReviewAbortedError } from '../../src/flow/panel.ts';
import { redFirst } from '../../src/flow/repository.ts';
import { ReviewBudgetError } from '../../src/flow/series.ts';
import { deterministicCauses } from '../../src/flow/types.ts';
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

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'review-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Admission fixture');
  git(repo, 'config', 'user.email', 'admission@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:KRN-WORKS/KRN.git');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture base');
  const base = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(join(repo, 'README.md'), 'broken contract\n');
  git(repo, 'add', 'README.md');
  git(
    repo,
    'commit',
    '-qm',
    [
      'feat: declare missing observer',
      '',
      'Ticket: t-fixture',
      'Change-contract: test/missing.test.ts:red->green',
    ].join('\n'),
  );
  const brokenHead = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '-q', '--detach', base);
  writeFileSync(join(repo, 'README.md'), 'clean candidate\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'feat: clean candidate');
  const cleanHead = git(repo, 'rev-parse', 'HEAD');

  const lens = join(directory, 'lens.txt');
  writeFileSync(lens, 'Check acceptance.\n');
  const pull = (head: string) => ({
    number: 17,
    title: 'feat: review candidate',
    base: {
      sha: base,
      ref: 'main',
      repo: { full_name: 'KRN-WORKS/KRN' },
    },
    head: { sha: head, repo: { full_name: 'fork-owner/krn' } },
  });
  const input = (head: string, prBound = true) => ({
    repo,
    base,
    head,
    lens,
    ...(prBound
      ? {
          pr: 17,
          readPull: async () => pull(head),
          readGateCheckRuns: async () => [],
        }
      : {}),
  });
  const args = (head: string) => [
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
    brokenHead,
    cleanHead,
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

test('PR-bound deterministic contract failures refuse before reserving or judging', async (t) => {
  const admissionError = flow.ReviewAdmissionError;
  assert.equal(typeof admissionError, 'function');

  const f = fixture(t);
  const host = mockHost(t);
  const report = await redFirst(f.repo, f.base, f.brokenHead);
  const causes = deterministicCauses(report.results, report.contracts ?? []);
  assert.ok(
    causes.length > 0,
    'broken declaration must yield a deterministic cause',
  );
  assert.equal(causes[0]?.path, 'test/missing.test.ts');

  await assert.rejects(
    flow.runReview(f.input(f.brokenHead)),
    (error: unknown) => {
      assert.ok(error instanceof admissionError);
      assert.match(
        error.message,
        /^review refused before reserving an attempt: deterministic checks failed\n/u,
      );
      assert.match(error.message, /INCOMPLETE test\/missing\.test\.ts@/u);
      return true;
    },
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 0);
  assert.equal(f.records().length, 0);
  assert.equal(f.hasRunState(), false);

  await assert.rejects(
    reviewCommand(f.args(f.brokenHead), {
      readPull: async () => f.pull(f.brokenHead),
      readGateCheckRuns: async () => [],
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.name : '',
        'ReviewUsageError',
      );
      assert.equal(reviewErrorExitCode(error), 64);
      assert.match(
        error instanceof Error ? error.message : String(error),
        /review refused before reserving an attempt/u,
      );
      return true;
    },
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 0);
  assert.equal(f.records().length, 0);
});

test('PR-bound clean red-first reserves one ordinal before running judges', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);

  const record = await flow.runReview(f.input(f.cleanHead));

  assert.equal(record.attempt?.ordinal, 1);
  assert.equal(f.reservations().length, 1);
  assert.ok(host.starts() > 0, 'clean PR review must run panel judges');
});

test('an aborted PR-bound review with a red-first cause refuses before reservation', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    flow.runReview({ ...f.input(f.brokenHead), signal: controller.signal }),
    ReviewAbortedError,
  );

  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 0);
});

test('non-PR deterministic failures keep the existing judge and record behavior', async (t) => {
  const f = fixture(t);
  const host = mockHost(t);

  const record = await flow.runReview(f.input(f.brokenHead, false));

  assert.equal(record.attempt, undefined);
  assert.ok(
    deterministicCauses(record.redFirst, record.contracts ?? []).length > 0,
  );
  assert.equal(f.reservations().length, 0);
  assert.equal(host.starts(), 3);
  assert.equal(f.records().length, 1);
});

test('admission refusal messages bound cause count and cause length', () => {
  const admissionError = flow.ReviewAdmissionError;
  assert.equal(typeof admissionError, 'function');
  const causes = Array.from({ length: 25 }, (_, index) => ({
    verdict: 'FAIL' as const,
    path: `test/${index}.test.ts`,
    commit: 'a'.repeat(40),
    cause: `${'x'.repeat(100)}\n${'y'.repeat(200)}`,
  }));

  const message = new admissionError(causes).message;
  const lines = message.split('\n');
  assert.equal(lines.length, 22);
  assert.equal(
    lines[0],
    'review refused before reserving an attempt: deterministic checks failed',
  );
  const firstCause = lines[1]?.split(': ').at(-1) ?? '';
  assert.equal(firstCause.length, 200);
  assert.equal(firstCause, `${'x'.repeat(100)} ${'y'.repeat(99)}`);
  assert.equal(lines.at(-1), '+5 more');

  const longMessage = new admissionError([
    {
      verdict: 'FAIL',
      path: `test/\u001b${'p'.repeat(240)}\r\ncontinued`,
      commit: `\u0085${'c'.repeat(240)}`,
      cause: `\u0007${'z'.repeat(240)}`,
    },
  ]).message;
  const refusal = longMessage.split('\n')[1] ?? '';
  const pathStart = refusal.indexOf(' ') + 1;
  const commitStart = refusal.indexOf('@', pathStart);
  const causeStart = refusal.indexOf(': ', commitStart);
  assert.equal(refusal.slice(pathStart, commitStart).length, 200);
  assert.equal(refusal.slice(commitStart + 1, causeStart).length, 200);
  assert.equal(refusal.slice(causeStart + 2).length, 200);
  assert.equal(
    [...refusal].some((character) => /\p{Cc}/u.test(character)),
    false,
  );
});
