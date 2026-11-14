import assert from 'node:assert/strict';
import test from 'node:test';
import { gitLockError } from '../../src/ci/git-lock.ts';

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

test('run kills a command that outlives its timeout and reports a transient timeout', async () => {
  assert.ok(api);
  const result = api.run('sleep', ['30'], '.', undefined, 200);
  assert.equal(result.code, 70);
  assert.match(result.stderr, /ETIMEDOUT/u);
});

test('GitHub bounds each call and retries a timed-out call as transient', async () => {
  assert.ok(api);
  const bounds: Array<number | undefined> = [];
  const waits: number[] = [];
  const output = await api.github(
    ['api', 'resource'],
    '.',
    (_cmd, _args, _cwd, _input, timeoutMs) => {
      bounds.push(timeoutMs);
      return bounds.length === 1
        ? { code: 70, stdout: '', stderr: 'spawnSync gh ETIMEDOUT' }
        : { code: 0, stdout: 'ok', stderr: '' };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(output, 'ok');
  assert.deepEqual(bounds, [api.GH_CALL_TIMEOUT_MS, api.GH_CALL_TIMEOUT_MS]);
  assert.equal(api.GH_CALL_TIMEOUT_MS, 10_000);
  assert.deepEqual(waits, [1000]);
  const logBounds: Array<number | undefined> = [];
  await api.github(['run', 'view', '1', '--log-failed'], '.', (...call) => {
    logBounds.push(call[4]);
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(logBounds, [api.GH_LOG_TIMEOUT_MS]);
});

test('gitLockError names every transient lock refusal a fetch or push prints', () => {
  for (const stderr of [
    "fatal: cannot lock ref 'refs/remotes/origin/main'",
    "error: unable to update local ref 'refs/remotes/origin/main'",
    "fatal: Unable to create '/r/.git/index.lock': File exists.",
    "error: cannot open '/r/.git/refs/remotes/origin/main.lock': File exists",
  ])
    assert.match(stderr, gitLockError, stderr);
  assert.doesNotMatch("fatal: couldn't find remote ref x", gitLockError);
});
