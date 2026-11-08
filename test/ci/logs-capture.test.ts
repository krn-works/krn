import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attemptJobsArgs,
  jobLogArgs,
  logsCommand,
  logsUsage,
  logTail,
  runAttemptArgs,
} from '../../src/ci/logs.ts';
import { capture } from '../receivers/capture.ts';

// Run 42486987437 (t-s6tq5ay): attempt 1 failed in Test (9/10); the re-run
// attempt 2 was cancelled, and `gh run view --log-failed` showed only its Check.
const repo = 'krn-works/krn';
const id = 42486987437;
const stdout = (name: string) =>
  capture('fixtures/gh', name).streams.stdout?.toString('utf8') ?? '';
const answers = new Map<string, string>([
  [JSON.stringify(runAttemptArgs(repo, id)), stdout('run-42486987437-attempt')],
  ...[1, 2].map(
    (attempt) =>
      [
        JSON.stringify(attemptJobsArgs(repo, id, attempt)),
        stdout(`run-42486987437-jobs-attempt-${attempt}`),
      ] as [string, string],
  ),
  ...[128750929767, 128751105094, 128751399200].map(
    (job) =>
      [JSON.stringify(jobLogArgs(repo, job)), stdout(`job-${job}-log`)] as [
        string,
        string,
      ],
  ),
]);
function strict(missing: Set<number> = new Set()) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    const job = [...missing].find(
      (item) => JSON.stringify(args) === JSON.stringify(jobLogArgs(repo, item)),
    );
    if (job !== undefined) throw new Error('HTTP 410: Gone\nmore');
    const answer = answers.get(JSON.stringify(args));
    if (answer === undefined)
      assert.fail(`unexpected gh request: ${JSON.stringify(args)}`);
    return answer;
  };
  return { gh, calls };
}

test('logs prints the failing attempt hidden behind a cancelled re-run', async () => {
  const fake = strict();
  const out = (
    await logsCommand(['--repo', repo, '--run', String(id)], fake)
  ).split('\n');
  assert.equal(out[0], `run ${id}: 2 attempts, 3 failed jobs`);
  const headers = out.filter((line) => line.startsWith('== '));
  assert.deepEqual(headers, [
    '== attempt 1 job 128750929767 Test (9/10): failure; failed step 4 Run test shard',
    '== attempt 1 job 128751105094 Check: failure; failed step 2 Require every job to succeed, or be skipped by the change filter',
    '== attempt 2 job 128751399200 Check: failure; failed step 2 Require every job to succeed, or be skipped by the change filter',
  ]);
  const shard = out.slice(2, out.indexOf(headers[1] ?? ''));
  assert.equal(shard.length, 40);
  assert.equal(shard.at(-1), '##[error]Process completed with exit code 1.');
  assert.ok(
    shard.some((line) =>
      line.startsWith(
        'Strict test evidence rejected: missing per-file summary',
      ),
    ),
  );
  assert.ok(!out.some((line) => line.includes('Post job cleanup.')));
  assert.ok(!out.some((line) => line.includes('\u001B')));
  assert.equal(fake.calls.length, 6);
});

test('logs keeps going when one job log is gone', async () => {
  const out = await logsCommand(
    ['--repo', repo, '--run', String(id), '--lines', '3'],
    strict(new Set([128751105094])),
  );
  assert.match(
    out,
    /Check: failure;[^\n]*\nlog unavailable: [^\n]*HTTP 410: Gone\n== attempt 2/u,
  );
  assert.ok(!out.includes('more'));
});

test('logs defaults the repository to the checkout remote', async () => {
  const fake = {
    calls: [] as string[][],
    gh: async (args: string[]) => {
      fake.calls.push(args);
      return '0';
    },
  };
  await assert.rejects(logsCommand(['--run', '5'], fake));
  assert.deepEqual(fake.calls[0], runAttemptArgs('{owner}/{repo}', 5));
});

test('logs rejects bad arguments with exit 64', async () => {
  for (const args of [
    [],
    ['--repo', repo],
    ['--run', '1', '--repo', 'a/b/c'],
    ['--repo', 'nope', '--run', '1'],
    ['--repo', repo, '--run', '1x'],
    ['--repo', repo, '--run', '1', '--lines', '0'],
    ['--repo', repo, '--run', '1', '--extra', 'x'],
  ])
    await assert.rejects(logsCommand(args, strict()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'exitCode'), 64);
      assert.equal(error.message, logsUsage);
      return true;
    });
});

test('logs exits 74 naming the request when GitHub refuses the run', async () => {
  await assert.rejects(
    logsCommand(['--repo', repo, '--run', '7'], strict()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'exitCode'), 74);
      assert.match(error.message, /unexpected gh request/u);
      return true;
    },
  );
});

test('log tail without an error line ends at the last line', () => {
  assert.deepEqual(
    logTail(
      '﻿2026-11-08T13:52:15.1Z a\n2026-11-08T13:52:15.2Z \u001B[31mb\u001B[0m\n',
      1,
    ),
    ['b'],
  );
});
