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
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);
const fixtures = new URL('../fixtures/herdr/', import.meta.url);
// A session running inside Herdr must not leak its pane into the launcher.
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')),
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

function herdrEnvironment(root: string, calls: string, bin: string) {
  return {
    ...hostEnvironment,
    PATH: bin,
    HERDR_CALLS: calls,
    STATUS_FIXTURE: fileURLToPath(new URL('server-status.txt', fixtures)),
    CREATE_FIXTURE: fileURLToPath(new URL('tab-create.reply.jsonl', fixtures)),
    PANE_FIXTURE: fileURLToPath(new URL('pane-get.reply.jsonl', fixtures)),
    AGENT_CALLS: join(root, 'agent-calls.jsonl'),
    KRN_SUCCESSOR_AGENT: 'successor-agent',
  };
}

function readCalls(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
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
  assert.equal(result.stdout, `successor: herdr tab ${tabId} pane ${paneId}\n`);
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
      'KRN_SUCCESSOR_PROMPT=Read handoff',
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

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readCalls(herdrCalls), [
    ['status'],
    ['pane', 'get', 'caller-pane'],
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
      'KRN_SUCCESSOR_PROMPT=Read handoff',
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
  ]);
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
    ['--bg', '-n', 'Next slice', 'Read handoff'],
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
    ['--bg', '-n', 'Next slice', 'Read handoff'],
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
    ['--bg', '-n', 'Next slice', 'Read handoff'],
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
