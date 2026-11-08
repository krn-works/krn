import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandFailure, github } from '../../src/deliver/transport.ts';
import { capture } from '../receivers/capture.ts';

// KRN-12: gh 2.101.0 answering a missing pull request (test/fixtures/gh).
const notFound = capture('fixtures/gh', 'pr-not-found');

test('a captured gh 404 fails at once with gh stderr as the message', async () => {
  const stdout = notFound.streams.stdout?.toString('utf8') ?? '';
  const stderr = notFound.streams.stderr?.toString('utf8') ?? '';
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    github(
      ['api', 'repos/krn-works/krn/pulls/999999'],
      '.',
      () => {
        calls++;
        return { code: notFound.exitCode, stdout, stderr };
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.message, 'gh: Not Found (HTTP 404)\n');
      assert.equal(error.commandExitCode, 1);
      assert.equal(error.result.stdout, stdout);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('the transient pattern reads the captured gh status form', async () => {
  // gh writes "gh: <reason> (HTTP <code>)"; only the code differs for a 502.
  const stderr = (notFound.streams.stderr?.toString('utf8') ?? '').replace(
    'Not Found (HTTP 404)',
    'Bad Gateway (HTTP 502)',
  );
  let calls = 0;
  const output = await github(
    [],
    '.',
    () => ({
      code: ++calls === 2 ? 0 : 1,
      stdout: calls === 2 ? 'ok' : '',
      stderr,
    }),
    async () => {},
  );
  assert.equal(output, 'ok');
  assert.equal(calls, 2);
});
