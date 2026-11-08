import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  capture,
  failure,
  installHerdr,
  ok,
  type Replies,
  type Reply,
  readCalls,
} from '../helpers/herdr-stub.ts';

const api = await import('../../scripts/claude/successor-launch.ts');
let ledgerRoot = '';

// Every reply below is a verbatim Herdr capture, varied only in the fields a
// test is about.
const own = JSON.parse(capture('pane-get.reply.jsonl')).result.pane as {
  workspace_id: string;
  tab_id: string;
};
const predecessor = {
  KRN_PREDECESSOR_PANE: 'pred',
  KRN_PREDECESSOR_SESSION: 'session',
};
// `herdr agent wait` replies with the agent once its status matched (captured
// with --until working on an agent that was already working).
const settled = ok(capture('agent-wait.reply.jsonl'));
const waitTimeout = failure(capture('agent-wait-timeout.stderr.jsonl'));

function agent(status: string, session = 'session'): Reply {
  const reply = JSON.parse(capture('agent-get-idle-claude.reply.jsonl'));
  reply.result.agent.agent_status = status;
  reply.result.agent.agent_session.value = session;
  return ok(`${JSON.stringify(reply)}\n`);
}

function tabs(): Reply {
  const reply = JSON.parse(capture('tab-list.reply.jsonl'));
  const [template] = reply.result.tabs;
  const tab = (
    id: string,
    workspace: string,
    label: string,
    status: string,
  ) => ({
    ...template,
    tab_id: id,
    workspace_id: workspace,
    label,
    agent_status: status,
  });
  reply.result.tabs = [
    tab('idle', own.workspace_id, 'handed off → old', 'idle'),
    tab('done', own.workspace_id, 'handed off → finished', 'done'),
    tab('working', own.workspace_id, 'handed off → live', 'working'),
    tab('ordinary', own.workspace_id, 'ordinary', 'idle'),
    tab('other', 'w1D', 'handed off → foreign', 'idle'),
    tab(own.tab_id, own.workspace_id, 'handed off → current', 'idle'),
  ];
  return ok(`${JSON.stringify(reply)}\n`);
}

function retire(
  args: string[],
  pause?: (seconds: number) => void,
  now?: () => number,
): number {
  assert.equal(
    typeof api.retireMode,
    'function',
    'base must expose --retire implementation',
  );
  return api.retireMode([...args, '--cwd', ledgerRoot], pause, now);
}

function setup(
  t: { after(fn: () => void): void },
  options: { env?: Record<string, string>; replies?: Replies } = {},
) {
  const previousEnv = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'handed-tabs-'));
  ledgerRoot = root;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = installHerdr(bin, {
    'pane get': ok(capture('pane-get.reply.jsonl')),
    'tab list': ok(capture('tab-list.reply.jsonl')),
    'pane close': ok(capture('pane-close.reply.jsonl')),
    'tab close': ok(capture('tab-close.reply.jsonl')),
    ...options.replies,
  });
  for (const key of Object.keys(process.env))
    if (key.startsWith('HERDR_') || key.startsWith('KRN_PREDECESSOR_'))
      delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}:${previousEnv.PATH}`,
    HERDR_PANE_ID: 'self',
    ...options.env,
  });
  return { calls, root };
}

function stderrOf(run: () => number): { status: number; stderr: string } {
  let stderr = '';
  const old = process.stderr.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: run(), stderr };
  } finally {
    process.stderr.write = old;
  }
}

// A pause that moves the clock, so a wait deadline passes without sleeping.
function clock() {
  let now = 0;
  const pauses: number[] = [];
  return {
    pauses,
    pause(seconds: number) {
      pauses.push(seconds);
      now += seconds * 1000;
    },
    now: () => now,
  };
}

test('idle matching immediate predecessor and eligible handed-off tabs close; other tabs stay', (t) => {
  const x = setup(t, {
    env: predecessor,
    replies: { 'agent get pred': agent('idle'), 'tab list': tabs() },
  });
  assert.equal(retire(['--wait-seconds', '0']), 0);
  const c = readCalls(x.calls);
  assert.ok(c.some((a) => a.join(' ') === 'pane close pred'));
  assert.ok(c.some((a) => a.join(' ') === 'tab close idle'));
  assert.ok(c.some((a) => a.join(' ') === 'tab close done'));
  for (const id of ['working', 'ordinary', 'other', own.tab_id])
    assert.ok(!c.some((a) => a.join(' ') === `tab close ${id}`));
  assert.ok(
    !c.some((a) => a[1] === 'wait'),
    'an idle predecessor needs no wait',
  );
});
test('working predecessor at zero wait remains open and reports timeout', (t) => {
  const x = setup(t, {
    env: predecessor,
    replies: { 'agent get pred': agent('working') },
  });
  const { status, stderr } = stderrOf(() => retire(['--wait-seconds', '0']));
  assert.equal(status, 0);
  assert.match(stderr, /predecessor still working/u);
  assert.ok(!readCalls(x.calls).some((a) => a[1] === 'close'));
  assert.ok(!readCalls(x.calls).some((a) => a[1] === 'wait'));
});
test('predecessor that settles during the wait closes without polling', (t) => {
  const x = setup(t, {
    env: predecessor,
    replies: {
      'agent get pred': [agent('working'), agent('idle')],
      'agent wait pred': settled,
    },
  });
  const timing = clock();
  assert.equal(retire(['--wait-seconds', '5'], timing.pause, timing.now), 0);
  const agentCalls = readCalls(x.calls).filter((a) => a[0] === 'agent');
  assert.deepEqual(agentCalls, [
    ['agent', 'get', 'pred'],
    [
      'agent',
      'wait',
      'pred',
      '--until',
      'idle',
      '--until',
      'done',
      '--timeout',
      '5000',
    ],
    ['agent', 'get', 'pred'],
  ]);
  assert.deepEqual(timing.pauses, []);
  assert.ok(readCalls(x.calls).some((a) => a.join(' ') === 'pane close pred'));
});
test('a wait that times out pauses, re-reads and leaves a working predecessor open', (t) => {
  const x = setup(t, {
    env: predecessor,
    replies: {
      'agent get pred': agent('working'),
      'agent wait pred': waitTimeout,
    },
  });
  const timing = clock();
  const { status, stderr } = stderrOf(() =>
    retire(['--wait-seconds', '5'], timing.pause, timing.now),
  );
  assert.equal(status, 0);
  assert.match(stderr, /predecessor still working/u);
  assert.deepEqual(timing.pauses, [5]);
  assert.ok(!readCalls(x.calls).some((a) => a[1] === 'close'));
});
test('a settled predecessor whose session cannot be verified is polled, never waited on', (t) => {
  const reply = JSON.parse(capture('agent-get-idle-claude.reply.jsonl'));
  delete reply.result.agent.agent_session;
  const x = setup(t, {
    env: predecessor,
    replies: { 'agent get pred': ok(`${JSON.stringify(reply)}\n`) },
  });
  const timing = clock();
  const { stderr } = stderrOf(() =>
    retire(['--wait-seconds', '10'], timing.pause, timing.now),
  );
  assert.match(stderr, /predecessor still working/u);
  assert.deepEqual(timing.pauses, [5, 5]);
  assert.ok(
    !readCalls(x.calls).some((a) => a[1] === 'wait' || a[1] === 'close'),
  );
});
test('different predecessor session is not closed', (t) => {
  const x = setup(t, {
    env: { ...predecessor, KRN_PREDECESSOR_SESSION: 'expected' },
    replies: { 'agent get pred': agent('idle', 'other') },
  });
  retire(['--wait-seconds', '0']);
  assert.ok(!readCalls(x.calls).some((a) => a[1] === 'close'));
});
test('a predecessor pane that is already gone ends the wait at once', (t) => {
  // Herdr reports it as a JSON error on stderr, exit 1, not on stdout.
  const x = setup(t, {
    env: predecessor,
    replies: {
      'agent get pred': failure(capture('agent-get-missing.stderr.jsonl')),
      'tab list': tabs(),
    },
  });
  const timing = clock();
  const { status, stderr } = stderrOf(() =>
    retire([], timing.pause, timing.now),
  );
  assert.equal(status, 0);
  assert.deepEqual(timing.pauses, []);
  assert.doesNotMatch(stderr, /still working/u);
  assert.deepEqual(
    readCalls(x.calls).filter((a) => a[0] === 'agent'),
    [['agent', 'get', 'pred']],
  );
  assert.ok(
    readCalls(x.calls).some((a) => a.join(' ') === 'tab close idle'),
    'the handed-off tab sweep still runs',
  );
});
test('a predecessor that closes during the wait is recognised on the next read', (t) => {
  const x = setup(t, {
    env: predecessor,
    replies: {
      'agent get pred': [
        agent('working'),
        failure(capture('agent-get-missing.stderr.jsonl')),
      ],
      'agent wait pred': failure(capture('agent-wait-missing.stderr.jsonl')),
    },
  });
  const timing = clock();
  const { status, stderr } = stderrOf(() =>
    retire(['--wait-seconds', '30'], timing.pause, timing.now),
  );
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /still working/u);
  assert.deepEqual(
    readCalls(x.calls).filter((a) => a[0] === 'agent' && a[1] === 'get'),
    [
      ['agent', 'get', 'pred'],
      ['agent', 'get', 'pred'],
    ],
  );
  assert.ok(!readCalls(x.calls).some((a) => a[1] === 'close'));
});
test('missing Herdr context makes no Herdr calls', (t) => {
  const x = setup(t);
  delete process.env.HERDR_PANE_ID;
  assert.equal(retire([]), 0);
  assert.deepEqual(readCalls(x.calls), []);
});
test('pane get failure is best effort and does not close tabs', (t) => {
  const x = setup(t, {
    replies: { 'pane get': failure(capture('pane-get-missing.stderr.jsonl')) },
  });
  assert.equal(retire([]), 0);
  assert.ok(!readCalls(x.calls).some((a) => a.includes('close')));
});
test('wait bounds reject invalid values with usage status 64', (t) => {
  setup(t);
  assert.equal(retire(['--wait-seconds', '601']), 64);
  assert.equal(retire(['--wait-seconds', 'x']), 64);
});
test('failed predecessor close is reported on stderr and exits 0', (t) => {
  setup(t, {
    env: predecessor,
    replies: {
      'agent get pred': agent('idle'),
      'pane close': failure('pane close failed\n'),
    },
  });
  const { status, stderr } = stderrOf(() => retire(['--wait-seconds', '0']));
  assert.equal(status, 0);
  assert.match(stderr, /retire: failed to close predecessor pred/u);
});
