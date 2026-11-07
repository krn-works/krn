import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);
const fixtures = new URL('../fixtures/herdr/', import.meta.url);
// Replies captured verbatim from the live Herdr server, with the host path
// replaced by /work/repo. They live in this
// file so the observer runs unchanged against a tree without new fixtures.
const captures: Record<string, string> = {
  'agent-get-idle-claude.reply.jsonl':
    '{"id":"cli:agent:get","result":{"agent":{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"6d5dd06a-49cf-4b74-8309-cf67dcb7fe68"},"agent_status":"idle","cwd":"/work/repo","focused":false,"foreground_cwd":"/work/repo","pane_id":"w1D:p53","revision":2,"state_change_seq":1661,"tab_id":"w1D:t4Z","terminal_id":"term_65f2350762bb861","terminal_title":"✳ session continuity","terminal_title_stripped":"session continuity","workspace_id":"w1D"},"type":"agent_info"}}\n',
  'agent-get-working-claude.reply.jsonl':
    '{"id":"cli:agent:get","result":{"agent":{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"3f1b641a-c2c9-4bce-a4dd-9e7461a378a7"},"agent_status":"working","cwd":"/work/repo","focused":true,"foreground_cwd":"/work/repo","pane_id":"w1D:p5G","revision":2,"state_change_seq":1945,"tab_id":"w1D:t5C","terminal_id":"term_65f376c89a7b66f","terminal_title":"◐ continuity synthesis","terminal_title_stripped":"continuity synthesis","workspace_id":"w1D"},"type":"agent_info"}}\n',
  'agent-get-shell.reply.jsonl':
    '{"error":{"code":"agent_not_found","message":"agent target w1D:p5J not found"},"id":"cli:agent:get"}\n',
  'agent-get-missing.reply.jsonl':
    '{"error":{"code":"agent_not_found","message":"agent target w1D:pZZZ not found"},"id":"cli:agent:get"}\n',
  'tab-rename.reply.jsonl':
    '{"id":"cli:tab:rename","result":{"tab":{"agent_status":"unknown","focused":false,"label":"handed off → probe","number":174,"pane_count":1,"tab_id":"w1D:t5E","workspace_id":"w1D"},"type":"tab_info"}}\n',
  'pane-close.reply.jsonl': '{"id":"cli:pane:close","result":{"type":"ok"}}\n',
};
const callerPane = 'caller-pane';
const callerTab = 'caller-tab';
const callerSession = JSON.parse(
  captures['agent-get-idle-claude.reply.jsonl'] as string,
).result.agent.agent_session.value as string;
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')),
);

type Reply = {
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
  const replies = join(root, 'fixtures');
  mkdirSync(replies);
  for (const name of [
    'server-status.txt',
    'pane-get.reply.jsonl',
    'tab-create.reply.jsonl',
  ]) {
    writeFileSync(join(replies, name), readFileSync(new URL(name, fixtures)));
  }
  for (const [name, contents] of Object.entries(captures)) {
    writeFileSync(join(replies, name), contents);
  }
  return { root, bin };
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function herdrStub(): string {
  return [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'appendFileSync(process.env.HERDR_CALLS, JSON.stringify(args) + "\\n");',
    "if (args[0] === 'status') {",
    "  if (process.env.HERDR_MODE === 'server-fails') {",
    "    process.stderr.write('cannot reach server\\n');",
    '    process.exit(1);',
    '  }',
    '  process.stdout.write(readFileSync(process.env.STATUS_FIXTURE));',
    "} else if (args[0] === 'pane' && args[1] === 'get') {",
    '  process.stdout.write(readFileSync(process.env.PANE_FIXTURE));',
    "} else if (args[0] === 'tab' && args[1] === 'create') {",
    '  process.stdout.write(readFileSync(process.env.CREATE_FIXTURE));',
    "} else if (args[0] === 'pane' && args[1] === 'run') {",
    "  if (process.env.HERDR_MODE === 'launch-fails') {",
    "    process.stderr.write('pane launch failed\\n');",
    '    process.exit(23);',
    '  }',
    "} else if (args[0] === 'agent' && args[1] === 'get') {",
    '  const replies = JSON.parse(readFileSync(process.env.HERDR_AGENT_REPLIES));',
    '  const reply = replies[args[2]];',
    '  if (!reply) {',
    '    process.stdout.write(readFileSync(process.env.MISSING_FIXTURE));',
    '    process.exit(1);',
    '  }',
    '  const result = JSON.parse(readFileSync(process.env.FIXTURE_DIR + reply.fixture));',
    '  if (result.result?.agent) {',
    '    const agent = result.result.agent;',
    '    if (reply.agent) agent.agent = reply.agent;',
    '    if (reply.status) agent.agent_status = reply.status;',
    '    if (reply.sessionId) agent.agent_session.value = reply.sessionId;',
    '    if (reply.paneId) agent.pane_id = reply.paneId;',
    '    if (reply.tabId) agent.tab_id = reply.tabId;',
    '  }',
    '  process.stdout.write(JSON.stringify(result) + "\\n");',
    '  process.exit(Number(reply.exit ?? 0));',
    "} else if (args[0] === 'pane' && args[1] === 'close') {",
    "  if (process.env.HERDR_MODE === 'close-fails') {",
    "    process.stderr.write('pane close failed\\n');",
    '    process.exit(17);',
    '  }',
    '  process.stdout.write(readFileSync(process.env.CLOSE_FIXTURE));',
    "} else if (args[0] === 'tab' && args[1] === 'rename') {",
    "  if (process.env.HERDR_MODE === 'rename-fails') {",
    "    process.stderr.write('tab rename failed\\n');",
    '    process.exit(18);',
    '  }',
    '  process.stdout.write(readFileSync(process.env.RENAME_FIXTURE));',
    '} else {',
    '  process.exit(64);',
    '}',
    '',
  ].join('\n');
}

function agentStub(): string {
  return [
    `#!${process.execPath}`,
    "import { appendFileSync } from 'node:fs';",
    'appendFileSync(process.env.AGENT_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
    '',
  ].join('\n');
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

function readCalls(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
    replies?: Record<string, Reply>;
    mode?: string;
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

  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const agentCalls = join(root, 'agent-calls.jsonl');
  const repliesPath = join(root, 'agent-replies.json');
  writeFileSync(
    repliesPath,
    JSON.stringify({
      [callerPane]: {
        fixture: 'agent-get-idle-claude.reply.jsonl',
        paneId: callerPane,
        tabId: callerTab,
        sessionId: callerSession,
        ...(options.paneId === 'caller-fails'
          ? { exit: 1, fixture: 'agent-get-missing.reply.jsonl' }
          : {}),
        ...(options.paneId === 'caller-shell' ? { agent: 'shell' } : {}),
      },
      ...options.replies,
    }),
  );
  writeExecutable(join(bin, 'herdr'), herdrStub());
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: callerPane,
        HERDR_CALLS: herdrCalls,
        HERDR_AGENT_REPLIES: repliesPath,
        HERDR_MODE: options.mode ?? 'success',
        STATUS_FIXTURE: join(root, 'fixtures', 'server-status.txt'),
        PANE_FIXTURE: join(root, 'fixtures', 'pane-get.reply.jsonl'),
        CREATE_FIXTURE: join(root, 'fixtures', 'tab-create.reply.jsonl'),
        CLOSE_FIXTURE: join(root, 'fixtures', 'pane-close.reply.jsonl'),
        RENAME_FIXTURE: join(root, 'fixtures', 'tab-rename.reply.jsonl'),
        MISSING_FIXTURE: join(
          root,
          'fixtures',
          'agent-get-missing.reply.jsonl',
        ),
        FIXTURE_DIR: `${join(root, 'fixtures')}/`,
        AGENT_CALLS: agentCalls,
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
  overrides: Partial<Reply> = {},
): Record<string, Reply> {
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
    replies: predecessorReply('agent-get-missing.reply.jsonl', { exit: 1 }),
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
      'w2E:pH',
      '"$KRN_SUCCESSOR_AGENT"',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ],
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
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const agentCalls = join(root, 'agent-calls.jsonl');
  writeExecutable(join(bin, 'herdr'), herdrStub());
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff'],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        HERDR_PANE_ID: callerPane,
        HERDR_CALLS: herdrCalls,
        HERDR_MODE: 'server-fails',
        AGENT_CALLS: agentCalls,
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
