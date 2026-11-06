import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GateTimeout,
  type GateWaitOptions,
  waitForGate,
} from '../../src/deliver/gate-wait.ts';

const head = 'a'.repeat(40);
function fixture(initialStatus = 'in_progress') {
  let time = 0;
  const calls: number[] = [];
  const logs: string[] = [];
  let status = initialStatus;
  let id = 1;
  let missing = false;
  const options: GateWaitOptions = {
    repo: 'o/r',
    pr: 7,
    head,
    policy: { source: 'pinned-app', checkRunName: 'krn/gate', appId: 5548482 },
    gh: async () =>
      JSON.stringify([
        {
          check_runs: missing
            ? []
            : [
                {
                  id,
                  name: 'krn/gate',
                  head_sha: head,
                  status,
                  conclusion: status === 'completed' ? 'success' : null,
                  app: { id: 5548482 },
                },
              ],
        },
      ]),
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    pollMs: 10,
    timeoutMs: 500,
    orphanAfterMs: 100,
    orphanRerun: async () => {
      calls.push(time);
      return 'RERUN queued';
    },
    log: (line) => {
      logs.push(line);
    },
  };
  return {
    options,
    calls,
    logs,
    complete: () => {
      status = 'completed';
      id++;
    },
    missing: () => {
      missing = true;
    },
    next: () => {
      id++;
    },
  };
}

test('orphan reruns once after sustained pending and follows newer success', async () => {
  const f = fixture();
  const sleep = f.options.sleep;
  f.options.sleep = async (ms) => {
    await sleep(ms);
    if (f.options.now() >= 160) f.complete();
  };
  assert.equal(await waitForGate(f.options), 'success');
  assert.deepEqual(f.calls, [100]);
  assert.deepEqual(f.logs, ['orphan: RERUN queued']);
});
test('retryable probes are spaced, with at most one successful rerun', async () => {
  const f = fixture();
  f.options.orphanRerun = async () => {
    f.calls.push(f.options.now());
    if (f.calls.length < 3)
      throw Object.assign(new Error('building'), { exitCode: 75 });
    return 'queued';
  };
  await assert.rejects(waitForGate(f.options), GateTimeout);
  assert.deepEqual(f.calls, [100, 200, 300]);
});
test('nonretryable errors are logged once as safe single lines', async () => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    const f = fixture();
    f.options.orphanRerun = async () => {
      f.calls.push(f.options.now());
      throw Object.assign(new Error(`bad\u0000\u200b${separator}injected`), {
        exitCode: 65,
      });
    };
    await assert.rejects(waitForGate(f.options), GateTimeout);
    assert.deepEqual(f.calls, [100]);
    assert.deepEqual(f.logs, ['orphan: bad']);
  }
});
for (const mode of ['main', 'early', 'missing', 'disabled'] as const) {
  test(`no orphan rerun: ${mode}`, async () => {
    const f = fixture();
    if (mode === 'main') f.options.onMain = true;
    if (mode === 'early') {
      const sleep = f.options.sleep;
      f.options.sleep = async (ms) => {
        await sleep(ms);
        if (f.options.now() >= 50) f.complete();
      };
    }
    if (mode === 'missing') f.missing();
    if (mode === 'disabled') delete f.options.orphanRerun;
    if (mode === 'early') assert.equal(await waitForGate(f.options), 'success');
    else await assert.rejects(waitForGate(f.options), GateTimeout);
    assert.deepEqual(f.calls, []);
  });
}
test('newest gate id resets the pending window', async () => {
  const f = fixture();
  const sleep = f.options.sleep;
  f.options.sleep = async (ms) => {
    await sleep(ms);
    if (f.options.now() === 90) f.next();
  };
  await assert.rejects(waitForGate(f.options), GateTimeout);
  assert.deepEqual(f.calls, [190]);
});

test('queued orphan uses the default two-minute window', async () => {
  const f = fixture('queued');
  delete f.options.orphanAfterMs;
  f.options.timeoutMs = 150000;
  f.options.pollMs = 10000;
  await assert.rejects(waitForGate(f.options), GateTimeout);
  assert.deepEqual(f.calls, [120000]);
});
