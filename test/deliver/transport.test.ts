import assert from 'node:assert/strict';
import test from 'node:test';

const api = await import('../../src/deliver/transport.ts').catch(
  () => undefined,
);

test('GitHub retries only transient failures with bounded injectable backoff', async () => {
  assert.equal(typeof api?.github, 'function');
  assert.ok(api);
  for (const stderr of [
    'HTTP 502: Bad Gateway\n',
    'Could not resolve host: api.github.com\n',
    'HTTP 429: rate limit exceeded\n',
    'error connecting to api.github.com\n',
  ]) {
    const waits: number[] = [];
    let calls = 0;
    const output = await api.github(
      ['api', 'resource'],
      '.',
      () => ({
        code: ++calls === 3 ? 0 : 1,
        stdout: calls === 3 ? 'receiver' : '',
        stderr,
      }),
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(output, 'receiver');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test('GitHub preserves original stderr and exit code on permanent and exhausted failures', async () => {
  assert.equal(typeof api?.github, 'function');
  assert.ok(api);
  for (const [stderr, expected] of [
    ['HTTP 403: Resource not accessible\n', 1],
    ['HTTP 404: Not Found\n', 1],
    ['HTTP 503: unavailable\n', 4],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      api.github(
        [],
        '.',
        () => {
          calls++;
          return { code: 23, stdout: '', stderr };
        },
        async () => {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof api.CommandFailure);
        assert.equal(error.commandExitCode, 23);
        assert.equal(error.result.stderr, stderr);
        return true;
      },
    );
    assert.equal(calls, expected);
  }
});
