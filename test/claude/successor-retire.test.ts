import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  failure,
  installAgent,
  installHerdr,
  ok,
  type Replies,
  type Reply,
  readCalls,
} from '../helpers/herdr-stub.ts';

const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);
const callerPane = 'caller-pane';
const callerTab = 'caller-tab';
const callerSession = JSON.parse(capture('agent-get-idle-claude.reply.jsonl'))
  .result.agent.agent_session.value as string;
const newPane = JSON.parse(capture('tab-create.reply.jsonl')).result.root_pane
  .pane_id as string;
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')),
);

// The capture `herdr agent get` answers for one pane, with the fields a test is
// about replaced.
type AgentReply = {
  fixture: string;
  exit?: number;
  agent?: string;
  status?: string;
  sessionId?: string;
  paneId?: string;
  tabId?: string;
};

type LaunchRecord = {
  pane_id: string;
  tab_id: string;
  session_id: string;
  name: string;
  recorded_at: string;
};

function temporary(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'successor-retire-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, bin };
}

// A capture printed on its own stream; a replaced field reprints the reply
// compact, as the server's JSON stays one line.
function agentReply(reply: AgentReply): Reply {
  const raw = capture(reply.fixture);
  if (reply.fixture.endsWith('.stderr.jsonl'))
    return failure(raw, reply.exit ?? 1);
  const parsed = JSON.parse(raw);
  const agent = parsed.result.agent;
  if (reply.agent) agent.agent = reply.agent;
  if (reply.status) agent.agent_status = reply.status;
  if (reply.sessionId) agent.agent_session.value = reply.sessionId;
  if (reply.paneId) agent.pane_id = reply.paneId;
  if (reply.tabId) agent.tab_id = reply.tabId;
  return { stdout: `${JSON.stringify(parsed)}\n`, status: reply.exit ?? 0 };
}

const modes = {
  success: {},
  'server-fails': { status: failure('cannot reach server\n') },
  'launch-fails': { 'pane run': failure('pane launch failed\n', 23) },
  'close-fails': { 'pane close': failure('pane close failed\n', 17) },
  'rename-fails': { 'tab rename': failure('tab rename failed\n', 18) },
} satisfies Record<string, Replies>;

// Herdr as captured; `agent get` on a pane no test names answers
// agent_not_found.
function herdrReplies(
  agents: Record<string, AgentReply>,
  mode: keyof typeof modes,
): Replies {
  return {
    status: captureReply('server-status.txt'),
    'pane get': captureReply('pane-get.reply.jsonl'),
    'tab create': captureReply('tab-create.reply.jsonl'),
    'pane run': ok(''),
    'agent get': captureReply('agent-get-missing.stderr.jsonl'),
    ...Object.fromEntries(
      Object.entries(agents).map(([pane, reply]) => [
        `agent get ${pane}`,
        agentReply(reply),
      ]),
    ),
    'pane close': captureReply('pane-close.reply.jsonl'),
    'tab rename': captureReply('tab-rename.reply.jsonl'),
    ...modes[mode],
  };
}

function makeRecord(paneId: string, sessionId = callerSession): LaunchRecord {
  return {
    pane_id: paneId,
    tab_id: `${paneId}-tab`,
    session_id: sessionId,
    name: 'Previous lead',
    recorded_at: '2026-10-31T10:00:00.000Z',
  };
}

function readLedger(path: string): LaunchRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function launch(
  t: { after(fn: () => void): void },
  options: {
    records?: LaunchRecord[];
    extraLines?: string[];
    replies?: Record<string, AgentReply>;
    mode?: keyof typeof modes;
    paneId?: string;
  } = {},
) {
  const { root, bin } = temporary(t);
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const ledgerPath = join(cwd, '.krn', 'successors', 'launches.jsonl');
  if (options.records) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${[
        ...(options.extraLines ?? []),
        ...options.records.map((record) => JSON.stringify(record)),
      ].join('\n')}\n`,
    );
  }

  const agents = {
    // The started successor, which the launch waits for in its new pane.
    [newPane]: {
      fixture: 'agent-get-working-claude.reply.jsonl',
      paneId: newPane,
    },
    [callerPane]: {
      fixture: 'agent-get-idle-claude.reply.jsonl',
      paneId: callerPane,
      tabId: callerTab,
      sessionId: callerSession,
      ...(options.paneId === 'caller-fails'
        ? { exit: 1, fixture: 'agent-get-missing.stderr.jsonl' }
        : {}),
      // Herdr answers agent_not_found for a pane that hosts only a shell.
      ...(options.paneId === 'caller-shell'
        ? { exit: 1, fixture: 'agent-get-shell.stderr.jsonl' }
        : {}),
    },
    ...options.replies,
  };
  const herdrCalls = installHerdr(
    bin,
    herdrReplies(agents, options.mode ?? 'success'),
  );
  const agentCalls = join(root, 'agent-calls');
  installAgent(bin, 'successor-agent', agentCalls);

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Deliver t-x', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: callerPane,
        KRN_SUCCESSOR_AGENT: 'successor-agent',
      },
      encoding: 'utf8',
    },
  );

  return {
    result,
    cwd,
    ledgerPath,
    herdrCalls,
    agentCalls,
  };
}

function predecessorReply(
  fixtureName: string,
  overrides: Partial<AgentReply> = {},
): Record<string, AgentReply> {
  return {
    'predecessor-pane': {
      fixture: fixtureName,
      paneId: 'predecessor-pane',
      ...overrides,
    },
  };
}

test('idle same-session predecessor closes and is dropped', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stdout, /retired: pane predecessor-pane session /u);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    [callerPane],
  );
  assert.ok(
    readCalls(run.herdrCalls).some(
      (call) => call.join(' ') === 'pane close predecessor-pane',
    ),
  );
  assert.ok(
    readCalls(run.herdrCalls).some(
      (call) =>
        call.join(' ') === 'tab rename caller-tab handed off → Next slice',
    ),
  );
});

test('working predecessor stays recorded and is not closed', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-working-claude.reply.jsonl', {
      sessionId: callerSession,
    }),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    ['predecessor-pane', callerPane],
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[1] === 'close'),
    false,
  );
});

test('reused pane with a different session is dropped without closing', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane', 'old-session')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    [callerPane],
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[1] === 'close'),
    false,
  );
});

test('agent_not_found predecessor is dropped', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-missing.stderr.jsonl', { exit: 1 }),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    [callerPane],
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[1] === 'close'),
    false,
  );
});

test('missing and empty ledger each record only the caller', async (t) => {
  for (const seed of ['missing', 'empty']) {
    await t.test(seed, (nested) => {
      const setup = launch(nested, {
        ...(seed === 'empty' ? { records: [] } : {}),
      });

      assert.equal(setup.result.status, 0, setup.result.stderr);
      assert.deepEqual(
        readLedger(setup.ledgerPath).map((record) => record.pane_id),
        [callerPane],
      );
      assert.equal(
        readCalls(setup.herdrCalls).some((call) => call[1] === 'close'),
        false,
      );
    });
  }
});

test('caller agent lookup failure skips retirement and rename but keeps launch success', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
    paneId: 'caller-fails',
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(existsSync(run.ledgerPath), true);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    ['predecessor-pane'],
  );
  const laterCalls = readCalls(run.herdrCalls).slice(4);
  assert.deepEqual(laterCalls, [
    [
      'pane',
      'run',
      newPane,
      '"$KRN_SUCCESSOR_AGENT"',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ],
    ['agent', 'get', newPane],
    ['agent', 'get', callerPane],
  ]);
});

test('failed pane run does not write the ledger or retire predecessors', (t) => {
  const initial = [makeRecord('predecessor-pane')];
  const run = launch(t, { records: initial, mode: 'launch-fails' });

  assert.equal(run.result.status, 23);
  assert.deepEqual(readLedger(run.ledgerPath), initial);
  assert.deepEqual(
    readCalls(run.herdrCalls).filter((call) => call[0] === 'agent'),
    [['agent', 'get', callerPane]],
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[1] === 'close'),
    false,
  );
});

test('fallback launch makes no Herdr agent calls and writes no ledger', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = installHerdr(bin, herdrReplies({}, 'server-fails'));
  const agentCalls = join(root, 'agent-calls');
  installAgent(bin, 'successor-agent', agentCalls);

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Deliver t-x'],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: callerPane,
        KRN_SUCCESSOR_AGENT: 'successor-agent',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readCalls(herdrCalls).some((call) => call[0] === 'agent'),
    false,
  );
  assert.equal(readCalls(agentCalls).length, 1);
  assert.equal(
    existsSync(join(root, '.krn', 'successors', 'launches.jsonl')),
    false,
  );
});

test('pane close failure keeps the record and does not fail the launch', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
    mode: 'close-fails',
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    ['predecessor-pane', callerPane],
  );
  assert.match(
    run.result.stderr,
    /successor retirement failed: pane predecessor-pane/u,
  );
});

test('caller already in ledger is recorded once', (t) => {
  const run = launch(t, {
    records: [makeRecord(callerPane, 'stale-session'), makeRecord(callerPane)],
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  const callerRecords = readLedger(run.ledgerPath).filter(
    (record) => record.pane_id === callerPane,
  );
  assert.equal(callerRecords.length, 1);
  assert.equal(callerRecords[0]?.session_id, callerSession);
});

test('done predecessor closes and is dropped', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl', {
      status: 'done',
    }),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    [callerPane],
  );
  assert.ok(
    readCalls(run.herdrCalls).some(
      (call) => call.join(' ') === 'pane close predecessor-pane',
    ),
  );
});

test('non-Claude caller is recorded without retiring predecessors or renaming', (t) => {
  const run = launch(t, {
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
    paneId: 'caller-shell',
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    ['predecessor-pane'],
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[0] === 'close'),
    false,
  );
  assert.equal(
    readCalls(run.herdrCalls).some((call) => call[1] === 'rename'),
    false,
  );
});

test('tab rename failure does not fail launch or prevent ledger recording', (t) => {
  const run = launch(t, { mode: 'rename-fails' });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(readLedger(run.ledgerPath).length, 1);
  assert.match(
    run.result.stderr,
    /successor retirement failed: tab caller-tab/u,
  );
});

test('malformed ledger lines are skipped and valid predecessors still retire', (t) => {
  const run = launch(t, {
    extraLines: [
      'not json',
      JSON.stringify({ pane_id: 'incomplete-pane' }),
      JSON.stringify(['array']),
    ],
    records: [makeRecord('predecessor-pane')],
    replies: predecessorReply('agent-get-idle-claude.reply.jsonl'),
  });

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stdout, /retired: pane predecessor-pane session /u);
  assert.deepEqual(
    readLedger(run.ledgerPath).map((record) => record.pane_id),
    [callerPane],
  );
  assert.ok(
    readCalls(run.herdrCalls).some(
      (call) => call.join(' ') === 'pane close predecessor-pane',
    ),
  );
});
