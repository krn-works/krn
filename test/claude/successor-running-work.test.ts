import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  capture,
  captureReply,
  installAgent,
  installHerdr,
  ok,
  type Replies,
  readCalls,
} from '../helpers/herdr-stub.ts';

const api = await import('../../scripts/claude/successor-launch.ts');
const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);

// The idle agent of the captured pane: its claude process has two live bash
// children (ps-children-of-idle-agent.txt, as `ps` printed them).
const busyPane = 'w1D:pJB';
const busyTab = 'w1D:tJ3';
const session = JSON.parse(capture('agent-get-idle-claude.reply.jsonl')).result
  .agent.agent_session.value as string;
const own = JSON.parse(capture('pane-get.reply.jsonl')).result.pane as {
  workspace_id: string;
};
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')),
);
const record = JSON.stringify({
  pane_id: busyPane,
  tab_id: busyTab,
  session_id: session,
  name: 'old',
  recorded_at: '2026-11-10T15:27:18.440Z',
});

type Cleanup = { after(fn: () => void): void };

function setup(t: Cleanup, children: boolean, replies: Replies) {
  const root = mkdtempSync(join(tmpdir(), 'running-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // A fake `ps` answers the child listing of the agent process.
  const listing = new URL(
    '../fixtures/herdr/ps-children-of-idle-agent.txt',
    import.meta.url,
  );
  const ps = join(bin, 'ps');
  writeFileSync(
    ps,
    children
      ? `#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done <'${fileURLToPath(listing)}'\n`
      : '#!/bin/sh\nexit 1\n',
  );
  chmodSync(ps, 0o755);
  return { root, bin, calls: installHerdr(bin, replies) };
}

function agentReply(pane: string) {
  const reply = JSON.parse(capture('agent-get-idle-claude.reply.jsonl'));
  reply.result.agent.pane_id = pane;
  return ok(`${JSON.stringify(reply)}\n`);
}

function tabList() {
  const reply = JSON.parse(capture('tab-list.reply.jsonl'));
  reply.result.tabs = [
    {
      ...reply.result.tabs[0],
      tab_id: busyTab,
      workspace_id: own.workspace_id,
      label: 'handed off → old',
      agent_status: 'idle',
    },
  ];
  return ok(`${JSON.stringify(reply)}\n`);
}

function replies(children: boolean): Replies {
  return {
    'pane get': captureReply('pane-get.reply.jsonl'),
    'agent get': agentReply(busyPane),
    'tab list': tabList(),
    'pane list': captureReply('pane-list.reply.jsonl'),
    'pane process-info': captureReply(
      children
        ? 'pane-process-info-idle-with-monitors.reply.jsonl'
        : 'pane-process-info-working.reply.jsonl',
    ),
    'pane close': captureReply('pane-close.reply.jsonl'),
    'tab close': captureReply('tab-close.reply.jsonl'),
  };
}

function closesOf(calls: string) {
  return readCalls(calls)
    .filter((call) => call[1] === 'close')
    .map((call) => call.join(' '));
}

// `--retire` with the busy pane as the named predecessor, or recorded in the
// ledger.
function retire(t: Cleanup, children: boolean, ledger: boolean) {
  const { root, bin, calls } = setup(t, children, replies(children));
  if (ledger) {
    mkdirSync(join(root, '.krn', 'successors'), { recursive: true });
    writeFileSync(
      join(root, '.krn', 'successors', 'launches.jsonl'),
      `${record}\n`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [script, '--retire', '--wait-seconds', '0', '--cwd', root],
    {
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: 'self',
        ...(ledger
          ? {}
          : {
              KRN_PREDECESSOR_PANE: busyPane,
              KRN_PREDECESSOR_SESSION: session,
            }),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { stderr: result.stderr, closes: closesOf(calls) };
}

const kept = new RegExp(`retire: kept ${busyPane}: running work`, 'u');

test('an idle agent with a live child shell keeps its pane and tab on every retire path', (t) => {
  for (const ledger of [false, true]) {
    const run = retire(t, true, ledger);
    assert.deepEqual(run.closes, [], `ledger=${ledger}`);
    assert.match(run.stderr, kept);
  }
});

test('an idle agent without children is closed as before', (t) => {
  const direct = retire(t, false, false);
  assert.ok(direct.closes.includes(`pane close ${busyPane}`));
  const ledger = retire(t, false, true);
  assert.ok(ledger.closes.includes(`pane close ${busyPane}`));
  assert.ok(ledger.closes.includes(`tab close ${busyTab}`));
  assert.doesNotMatch(ledger.stderr, /running work/u);
});

test('a foreground process other than the agent is running work', (t) => {
  const info = JSON.parse(capture('pane-process-info-working.reply.jsonl'));
  info.result.process_info.foreground_processes.push({
    ...info.result.process_info.foreground_processes[0],
    name: 'node',
    pid: 1,
  });
  const { bin } = setup(t, false, {
    'pane process-info': ok(`${JSON.stringify(info)}\n`),
  });
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previous;
  });
  assert.equal(api.hostsRunningWork(busyPane), true);
});

test('launch keeps a recorded predecessor whose agent has a live child shell', (t) => {
  const created = JSON.parse(capture('tab-create.reply.jsonl')).result.root_pane
    .pane_id as string;
  const { root, bin, calls } = setup(t, true, {
    ...replies(true),
    status: captureReply('server-status.txt'),
    'tab create': captureReply('tab-create.reply.jsonl'),
    'pane run': ok(''),
    'tab rename': captureReply('tab-rename.reply.jsonl'),
    'agent get caller': agentReply('caller'),
    [`agent get ${busyPane}`]: agentReply(busyPane),
    [`agent get ${created}`]: captureReply(
      'agent-get-working-claude.reply.jsonl',
    ),
  });
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, '.krn', 'successors'), { recursive: true });
  writeFileSync(
    join(cwd, '.krn', 'successors', 'launches.jsonl'),
    `${record}\n`,
  );
  installAgent(bin, 'successor-agent', join(dirname(calls), 'agent-calls'));
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--operator-token',
      '--name',
      'Next',
      '--prompt',
      'Deliver t-x',
      '--cwd',
      cwd,
    ],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: 'caller',
        KRN_SUCCESSOR_AGENT: 'successor-agent',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, kept);
  assert.deepEqual(closesOf(calls), []);
});
