import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentInfo } from '../../scripts/claude/successor-launch.ts';

const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);
const fixtures = new URL('../fixtures/herdr/', import.meta.url);
// A session running inside Herdr must not leak its pane into the launcher.
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith('HERDR_') &&
      !name.startsWith('CODEX_') &&
      !name.startsWith('CLAUDE') &&
      name !== 'KRN_SUCCESSOR_AGENT',
  ),
);
const api = await import('../../scripts/claude/successor-launch.ts').catch(
  () => undefined,
);

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, fixtures));
}

function temporary(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'successor-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
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
    "} else if (args[0] === 'agent' && args[1] === 'get') {",
    '  // The new pane answers its fixtures in order, the last one repeating.',
    "  const asked = readFileSync(process.env.HERDR_CALLS, 'utf8')",
    "    .split('\\n')",
    '    .filter((line) => line === JSON.stringify(args)).length;',
    "  const replies = process.env.NEW_PANE_FIXTURE.split('\\n');",
    '  const name = args[2] === process.env.NEW_PANE',
    '    ? replies[Math.min(asked, replies.length) - 1]',
    '    : process.env.AGENT_FIXTURE;',
    '  // Herdr prints a reply on stdout and a server error on stderr, exit 1.',
    "  if (name.endsWith('.stderr.jsonl')) {",
    '    process.stderr.write(readFileSync(name));',
    '    process.exit(1);',
    '  }',
    '  process.stdout.write(readFileSync(name));',
    "} else if (args[0] === 'tab' && args[1] === 'create') {",
    "  if (process.env.HERDR_MODE === 'invalid-create') {",
    "    process.stdout.write('not a Herdr reply\\n');",
    '  } else {',
    '    process.stdout.write(readFileSync(process.env.CREATE_FIXTURE));',
    '  }',
    "} else if (args[0] === 'pane' && args[1] === 'run') {",
    "  if (process.env.HERDR_MODE === 'launch-fails') {",
    "    process.stderr.write('pane launch failed\\n');",
    '    process.exit(23);',
    '  }',
    "} else if (args[0] === 'tab' && args[1] === 'rename') {",
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
    'process.exit(Number(process.env.AGENT_EXIT ?? 0));',
    '',
  ].join('\n');
}

// The pane `herdr tab create` returned; `agent get` on it answers what Herdr
// shows there once `pane run` was admitted.
const newPane = JSON.parse(fixture('tab-create.reply.jsonl').toString('utf8'))
  .result.root_pane.pane_id as string;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, fixtures));
}

function herdrEnvironment(root: string, calls: string, bin: string) {
  return {
    ...hostEnvironment,
    PATH: bin,
    HERDR_CALLS: calls,
    STATUS_FIXTURE: fixturePath('server-status.txt'),
    CREATE_FIXTURE: fixturePath('tab-create.reply.jsonl'),
    PANE_FIXTURE: fixturePath('pane-get.reply.jsonl'),
    AGENT_FIXTURE: fixturePath('agent-get-working-claude.reply.jsonl'),
    NEW_PANE: newPane,
    NEW_PANE_FIXTURE: fixturePath('agent-get-working-claude.reply.jsonl'),
    RENAME_FIXTURE: fixturePath('tab-rename.reply.jsonl'),
    AGENT_CALLS: join(root, 'agent-calls.jsonl'),
    KRN_SUCCESSOR_AGENT: 'successor-agent',
  };
}

function readCalls(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

test('captured Herdr replies expose the IDs returned by the real server', () => {
  assert.equal(typeof api?.parseArgs, 'function');
  assert.ok(api);

  const created = JSON.parse(
    fixture('tab-create.reply.jsonl').toString('utf8'),
  );
  const tab = JSON.parse(fixture('tab-get.reply.jsonl').toString('utf8'));
  const pane = JSON.parse(fixture('pane-get.reply.jsonl').toString('utf8'));
  const closed = JSON.parse(fixture('tab-close.reply.jsonl').toString('utf8'));

  assert.equal(created.result.tab.tab_id, tab.result.tab.tab_id);
  assert.equal(created.result.root_pane.pane_id, pane.result.pane.pane_id);
  assert.equal(closed.result.type, 'ok');
  assert.match(
    fixture('server-status.txt').toString('utf8'),
    /status: running/u,
  );
});

test('captured Herdr replies sit on the stream Herdr prints them on', () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.some((name) => name.endsWith('.stderr.jsonl')));
  for (const name of names) {
    const lines = fixture(name).toString('utf8').split('\n');
    assert.equal(lines.pop(), '', `${name} ends with a newline`);
    for (const line of lines) {
      const reply = JSON.parse(line);
      if (name.endsWith('.stderr.jsonl')) {
        assert.equal(typeof reply.error?.code, 'string', name);
        assert.equal(reply.result, undefined, name);
      } else {
        assert.equal(typeof reply.result?.type, 'string', name);
        assert.equal(reply.error, undefined, name);
      }
    }
  }
});

test('argument parser accepts the required flags and resolves cwd', () => {
  assert.equal(typeof api?.parseArgs, 'function');
  assert.ok(api);
  assert.deepEqual(
    api.parseArgs(
      [
        '--prompt',
        'Read the handoff',
        '--cwd',
        'work tree',
        '--name',
        'Next slice',
      ],
      '/repo',
    ),
    {
      name: 'Next slice',
      prompt: 'Read the handoff',
      cwd: resolve('/repo', 'work tree'),
    },
  );
  assert.throws(() => api.parseArgs(['--name', 'Next slice']), /--prompt/u);
  assert.throws(
    () => api.parseArgs(['--name', 'Next slice', '--prompt']),
    /expected a value after --prompt/u,
  );
  assert.throws(
    () => api.parseArgs(['--name', '--prompt', 'Read the handoff']),
    /expected a value after --name/u,
  );
  assert.deepEqual(
    api.parseArgs(
      ['--name', '--next', '--prompt', '--resume from handoff'],
      '/repo',
    ),
    { name: '--next', prompt: '--resume from handoff', cwd: '/repo' },
  );
  assert.throws(
    () =>
      api.parseArgs([
        '--name',
        'Next slice',
        '--prompt',
        'Read the handoff',
        '--cwd',
        'one',
        '--cwd',
        'two',
      ]),
    /duplicate argument: --cwd/u,
  );
  assert.deepEqual(
    api.parseArgs(
      [
        '--name',
        'n',
        '--prompt',
        'p',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'max',
      ],
      '/repo',
    ),
    {
      name: 'n',
      prompt: 'p',
      cwd: '/repo',
      model: 'claude-opus-5-5',
      effort: 'max',
    },
  );
  assert.throws(
    () => api.parseArgs(['--name', 'n', '--prompt', 'p', '--effort', 'huge']),
    /--effort must be one of low, medium, high, xhigh, max/u,
  );
  assert.deepEqual(
    api.parseArgs(
      ['--name', 'n', '--prompt', 'p', '--start-seconds', '600'],
      '/repo',
    ),
    { name: 'n', prompt: 'p', cwd: '/repo', startSeconds: 600 },
  );
  for (const value of ['601', '-1', '1.5', '05', 'soon'])
    assert.throws(
      () =>
        api.parseArgs([
          '--name',
          'n',
          '--prompt',
          'p',
          '--start-seconds',
          value,
        ]),
      /--start-seconds must be a whole number from 0 to 600/u,
      value,
    );
});

test('Herdr launch uses the captured pane and tab IDs without starting fallback', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const agentCalls = join(root, 'agent-calls.jsonl');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeExecutable(join(bin, 'herdr'), herdrStub());
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_MODE: 'success',
      },
      encoding: 'utf8',
    },
  );
  const captured = JSON.parse(
    fixture('tab-create.reply.jsonl').toString('utf8'),
  );
  const paneId = captured.result.root_pane.pane_id;
  const tabId = captured.result.tab.tab_id;

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `successor: herdr tab ${tabId} pane ${paneId} agent claude working\n`,
  );
  assert.deepEqual(readCalls(herdrCalls), [
    ['status'],
    [
      'tab',
      'create',
      '--cwd',
      cwd,
      '--label',
      'Next slice',
      '--env',
      'KRN_SUCCESSOR_AGENT=successor-agent',
      '--env',
      'KRN_SUCCESSOR_NAME=Next slice',
      '--env',
      'KRN_SUCCESSOR_PROMPT=First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
      '--no-focus',
    ],
    [
      'pane',
      'run',
      paneId,
      '"$KRN_SUCCESSOR_AGENT"',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ],
    ['agent', 'get', paneId],
  ]);
  assert.equal(existsSync(agentCalls), false);
});

test('caller pane workspace is passed to the new tab', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeExecutable(join(bin, 'herdr'), herdrStub());
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_PANE_ID: 'caller-pane',
      },
      encoding: 'utf8',
    },
  );
  const paneReply = JSON.parse(
    fixture('pane-get.reply.jsonl').toString('utf8'),
  );
  const created = JSON.parse(
    fixture('tab-create.reply.jsonl').toString('utf8'),
  );
  const caller = JSON.parse(
    fixture('agent-get-working-claude.reply.jsonl').toString('utf8'),
  ).result.agent;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readCalls(herdrCalls), [
    ['status'],
    ['pane', 'get', 'caller-pane'],
    ['agent', 'get', 'caller-pane'],
    [
      'tab',
      'create',
      '--workspace',
      paneReply.result.pane.workspace_id,
      '--cwd',
      cwd,
      '--label',
      'Next slice',
      '--env',
      'KRN_SUCCESSOR_AGENT=successor-agent',
      '--env',
      'KRN_SUCCESSOR_NAME=Next slice',
      '--env',
      'KRN_SUCCESSOR_PROMPT=First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
      '--env',
      `KRN_PREDECESSOR_PANE=caller-pane`,
      '--env',
      `KRN_PREDECESSOR_SESSION=${caller.agent_session.value}`,
      '--no-focus',
    ],
    [
      'pane',
      'run',
      created.result.root_pane.pane_id,
      '"$KRN_SUCCESSOR_AGENT"',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ],
    ['agent', 'get', created.result.root_pane.pane_id],
    ['agent', 'get', 'caller-pane'],
    ['tab', 'rename', caller.tab_id, 'handed off → Next slice'],
  ]);
});

test('a successor Herdr never shows fails the launch and keeps the predecessor tab', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeExecutable(join(bin, 'herdr'), herdrStub());
  const created = JSON.parse(
    fixture('tab-create.reply.jsonl').toString('utf8'),
  ).result;

  const result = spawnSync(
    process.execPath,
    [
      script,
      '--name',
      'Next slice',
      '--prompt',
      'Read handoff',
      '--cwd',
      cwd,
      '--start-seconds',
      '0',
    ],
    {
      cwd: root,
      env: {
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_PANE_ID: 'caller-pane',
        KRN_SUCCESSOR_AGENT: 'claude',
        // `pane run` was admitted, yet the pane still hosts only its shell.
        NEW_PANE_FIXTURE: fixturePath('agent-get-shell.stderr.jsonl'),
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `successor not started: herdr pane ${created.root_pane.pane_id} shows no claude agent after 0 s; tab ${created.tab.tab_id} kept for inspection\n`,
  );
  const calls = readCalls(herdrCalls);
  assert.deepEqual(calls.slice(-2), [
    [
      'pane',
      'run',
      created.root_pane.pane_id,
      '"$KRN_SUCCESSOR_AGENT"',
      '--permission-mode',
      'bypassPermissions',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ],
    ['agent', 'get', created.root_pane.pane_id],
  ]);
  assert.equal(
    calls.some((call) => call[0] === 'tab' && call[1] === 'rename'),
    false,
  );
  assert.equal(
    existsSync(join(cwd, '.krn', 'successors', 'launches.jsonl')),
    false,
  );
});

test('a successor held on a startup dialog is reported with its pane and the handoff stands', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeExecutable(join(bin, 'herdr'), herdrStub());
  const created = JSON.parse(
    fixture('tab-create.reply.jsonl').toString('utf8'),
  ).result;
  const caller = JSON.parse(
    fixture('agent-get-working-claude.reply.jsonl').toString('utf8'),
  ).result.agent;

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_PANE_ID: 'caller-pane',
        KRN_SUCCESSOR_AGENT: 'claude',
        // Herdr 0.9.1 showed the folder-trust dialog as unknown, then blocked.
        NEW_PANE_FIXTURE: [
          fixturePath('agent-get-unknown-claude.reply.jsonl'),
          fixturePath('agent-get-blocked-claude.reply.jsonl'),
        ].join('\n'),
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `successor: herdr tab ${created.tab.tab_id} pane ${created.root_pane.pane_id} agent claude blocked\n`,
  );
  assert.equal(
    result.stderr,
    `successor waits on a startup dialog: answer it in herdr pane ${created.root_pane.pane_id} (tab ${created.tab.tab_id})\n`,
  );
  assert.deepEqual(readCalls(herdrCalls).slice(-4), [
    ['agent', 'get', created.root_pane.pane_id],
    ['agent', 'get', created.root_pane.pane_id],
    ['agent', 'get', 'caller-pane'],
    ['tab', 'rename', caller.tab_id, 'handed off → Next slice'],
  ]);
  assert.equal(
    existsSync(join(cwd, '.krn', 'successors', 'launches.jsonl')),
    true,
  );
});

// A captured `agent get` reply on the stream Herdr prints it on.
function captured(name: string) {
  return name.endsWith('.stderr.jsonl')
    ? { status: 1, stdout: '', stderr: fixture(name).toString('utf8') }
    : { status: 0, stdout: fixture(name).toString('utf8'), stderr: '' };
}

function clock() {
  let time = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => time,
    pause: (seconds: number) => {
      pauses.push(seconds);
      time += seconds * 1000;
    },
  };
}

// Answers the infos in order, the last one repeating.
function sequence(...infos: AgentInfo[]) {
  let index = 0;
  return () => infos[Math.min(index++, infos.length - 1)] ?? {};
}

test('the start wait polls Herdr until the expected agent shows, then stops at its deadline', () => {
  assert.equal(typeof api?.awaitAgent, 'function');
  assert.ok(api);
  const shell = api.agentInfo(captured('agent-get-shell.stderr.jsonl'));
  const claude = api.agentInfo(
    captured('agent-get-working-claude.reply.jsonl'),
  );

  const late = clock();
  assert.deepEqual(
    api.awaitAgent(
      sequence(shell, shell, claude),
      'claude',
      60,
      late.pause,
      late.now,
    ),
    claude,
  );
  assert.deepEqual(late.pauses, [1, 1]);

  const never = clock();
  assert.equal(
    api.awaitAgent(sequence(shell), 'claude', 3, never.pause, never.now),
    undefined,
  );
  assert.deepEqual(never.pauses, [1, 1, 1]);

  const wrong = clock();
  assert.equal(
    api.awaitAgent(sequence(claude), 'codex', 2, wrong.pause, wrong.now),
    undefined,
  );
  assert.deepEqual(wrong.pauses, [1, 1]);

  const override = clock();
  assert.deepEqual(
    api.awaitAgent(
      sequence(claude),
      undefined,
      0,
      override.pause,
      override.now,
    ),
    claude,
  );
  assert.deepEqual(override.pauses, []);
});

test('the start wait runs on while Herdr cannot classify the agent and answers its first classified status', () => {
  assert.ok(api);
  // Herdr 0.9.1 on a Claude held by its folder-trust dialog: no agent, then
  // unknown for seconds, then blocked.
  const shell = api.agentInfo(captured('agent-get-shell.stderr.jsonl'));
  const unknown = api.agentInfo(
    captured('agent-get-unknown-claude.reply.jsonl'),
  );
  const blocked = api.agentInfo(
    captured('agent-get-blocked-claude.reply.jsonl'),
  );
  assert.equal(unknown.status, 'unknown');
  assert.equal(blocked.status, 'blocked');

  const dialog = clock();
  assert.deepEqual(
    api.awaitAgent(
      sequence(shell, unknown, unknown, blocked),
      'claude',
      60,
      dialog.pause,
      dialog.now,
    ),
    blocked,
  );
  assert.deepEqual(dialog.pauses, [1, 1, 1]);

  // A live agent Herdr never classifies still counts as started.
  const unclassified = clock();
  assert.deepEqual(
    api.awaitAgent(
      sequence(unknown),
      'claude',
      2,
      unclassified.pause,
      unclassified.now,
    ),
    unknown,
  );
  assert.deepEqual(unclassified.pauses, [1, 1]);
});

test('missing Herdr falls back to claude background launch once', (t) => {
  const { root, bin } = temporary(t);
  const agentCalls = join(root, 'agent-calls.jsonl');
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff'],
    {
      cwd: root,
      env: {
        ...hostEnvironment,
        PATH: bin,
        AGENT_CALLS: agentCalls,
        KRN_SUCCESSOR_AGENT: 'successor-agent',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'successor: claude --bg (herdr unavailable: herdr not on PATH)\n',
  );
  assert.deepEqual(readCalls(agentCalls), [
    [
      '--bg',
      '-n',
      'Next slice',
      'First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
    ],
  ]);
});

test('a failed Herdr server probe falls back without creating a tab', (t) => {
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
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_MODE: 'server-fails',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /herdr unavailable: server did not respond/u);
  assert.deepEqual(readCalls(herdrCalls), [['status']]);
  assert.deepEqual(readCalls(agentCalls), [
    [
      '--bg',
      '-n',
      'Next slice',
      'First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
    ],
  ]);
});

test('a failed fallback agent returns its non-zero exit code', (t) => {
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
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_MODE: 'server-fails',
        AGENT_EXIT: '19',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 19);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /command exited with status 19/u);
  assert.deepEqual(readCalls(herdrCalls), [['status']]);
  assert.deepEqual(readCalls(agentCalls), [
    [
      '--bg',
      '-n',
      'Next slice',
      'First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
    ],
  ]);
});

test('a pane run failure does not launch the fallback agent', (t) => {
  const { root, bin } = temporary(t);
  const herdrCalls = join(root, 'herdr-calls.jsonl');
  const agentCalls = join(root, 'agent-calls.jsonl');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeExecutable(join(bin, 'herdr'), herdrStub());
  writeExecutable(join(bin, 'successor-agent'), agentStub());

  const result = spawnSync(
    process.execPath,
    [script, '--name', 'Next slice', '--prompt', 'Read handoff', '--cwd', cwd],
    {
      cwd: root,
      env: {
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_MODE: 'launch-fails',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 23);
  assert.match(result.stderr, /pane launch failed/u);
  assert.deepEqual(
    readCalls(herdrCalls).map((args) => args.slice(0, 2)),
    [['status'], ['tab', 'create'], ['pane', 'run']],
  );
  assert.equal(existsSync(agentCalls), false);
});

test('a tab reply without a pane ID stops without falling back', (t) => {
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
        ...herdrEnvironment(root, herdrCalls, bin),
        HERDR_MODE: 'invalid-create',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /herdr tab create returned no tab or pane id/u);
  assert.equal(readCalls(herdrCalls).length, 2);
  assert.equal(existsSync(agentCalls), false);
});

test('a Claude successor starts with bypassPermissions through Herdr and the fallback', async (t) => {
  await t.test('herdr pane run', () => {
    const { root, bin } = temporary(t);
    const herdrCalls = join(root, 'herdr-calls.jsonl');
    writeExecutable(join(bin, 'herdr'), herdrStub());
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--name',
        'Next slice',
        '--prompt',
        'Read handoff',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'max',
      ],
      {
        cwd: root,
        env: {
          ...herdrEnvironment(root, herdrCalls, bin),
          KRN_SUCCESSOR_AGENT: 'claude',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const run = readCalls(herdrCalls).find(
      (call) => call[0] === 'pane' && call[1] === 'run',
    );
    assert.deepEqual(run?.slice(3), [
      '"$KRN_SUCCESSOR_AGENT"',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'max',
      '-n',
      '"$KRN_SUCCESSOR_NAME"',
      '"$KRN_SUCCESSOR_PROMPT"',
    ]);
  });

  await t.test('claude --bg fallback', () => {
    const { root, bin } = temporary(t);
    const agentCalls = join(root, 'agent-calls.jsonl');
    writeExecutable(join(bin, 'claude'), agentStub());
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--name',
        'Next slice',
        '--prompt',
        'Read handoff',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'max',
      ],
      {
        cwd: root,
        env: {
          ...hostEnvironment,
          CLAUDECODE: '1',
          PATH: bin,
          AGENT_CALLS: agentCalls,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(agentCalls), [
      [
        '--permission-mode',
        'bypassPermissions',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'max',
        '--bg',
        '-n',
        'Next slice',
        'First run `node scripts/claude/successor-launch.ts --retire` from the repository root. Read handoff',
      ],
    ]);
  });
});

test('the successor harness follows the runtime environment, never an assumption', async (t) => {
  const launch = (
    marker: Record<string, string>,
    herdr: boolean,
    extra: string[] = [],
  ) => {
    const { root, bin } = temporary(t);
    const herdrCalls = join(root, 'herdr-calls.jsonl');
    const agentCalls = join(root, 'agent-calls.jsonl');
    if (herdr) writeExecutable(join(bin, 'herdr'), herdrStub());
    writeExecutable(join(bin, 'claude'), agentStub());
    writeExecutable(join(bin, 'codex'), agentStub());
    const { KRN_SUCCESSOR_AGENT: _agent, ...environment } = herdrEnvironment(
      root,
      herdrCalls,
      bin,
    );
    const result = spawnSync(
      process.execPath,
      [script, '--name', 'Next slice', '--prompt', 'Read handoff', ...extra],
      { cwd: root, env: { ...environment, ...marker }, encoding: 'utf8' },
    );
    const exists = (path: string) => (existsSync(path) ? readCalls(path) : []);
    return { result, herdr: exists(herdrCalls), agent: exists(agentCalls) };
  };

  await t.test(
    'Codex session starts Codex in Herdr without Claude flags',
    () => {
      const { result, herdr, agent } = launch(
        {
          CODEX_THREAD_ID: 'thread-1',
          NEW_PANE_FIXTURE: fixturePath('agent-get-idle-codex.reply.jsonl'),
        },
        true,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /agent codex idle\n$/u);
      const create = herdr.find(
        (call) => call[0] === 'tab' && call[1] === 'create',
      );
      assert.ok(create?.includes('KRN_SUCCESSOR_AGENT=codex'));
      const run = herdr.find((call) => call[0] === 'pane' && call[1] === 'run');
      assert.deepEqual(run?.slice(3), [
        '"$KRN_SUCCESSOR_AGENT"',
        '"$KRN_SUCCESSOR_PROMPT"',
      ]);
      assert.deepEqual(agent, []);
    },
  );

  await t.test('Claude Code session starts Claude in Herdr', () => {
    const { result, herdr } = launch({ CLAUDECODE: '1' }, true);
    assert.equal(result.status, 0, result.stderr);
    const create = herdr.find(
      (call) => call[0] === 'tab' && call[1] === 'create',
    );
    assert.ok(create?.includes('KRN_SUCCESSOR_AGENT=claude'));
  });

  await t.test('Codex refuses Claude-only model and effort flags', () => {
    const { result, herdr, agent } = launch(
      { CODEX_THREAD_ID: 'thread-1' },
      true,
      ['--effort', 'max'],
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /apply only to Claude successors/u);
    assert.deepEqual(
      herdr.filter((call) => call[0] === 'tab' && call[1] === 'create'),
      [],
    );
    assert.deepEqual(agent, []);
  });

  await t.test('Codex without Herdr stops instead of launching Claude', () => {
    const { result, agent } = launch({ CODEX_THREAD_ID: 'thread-1' }, false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /codex successor needs Herdr/u);
    assert.deepEqual(agent, []);
  });

  await t.test('unknown and ambiguous environments stop explicitly', () => {
    const unknown = launch({}, true);
    assert.equal(unknown.result.status, 2);
    assert.match(unknown.result.stderr, /unknown harness/u);
    assert.deepEqual([unknown.herdr, unknown.agent], [[], []]);
    const both = launch({ CODEX_THREAD_ID: 't', CLAUDECODE: '1' }, true);
    assert.equal(both.result.status, 2);
    assert.match(both.result.stderr, /ambiguous harness/u);
  });
});
