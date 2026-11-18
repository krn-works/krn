import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hcHost } from '../../src/successor/host-hc.ts';
import { herdrHost } from '../../src/successor/host-herdr.ts';
import { retireMode } from '../../src/successor/retire.ts';
import {
  announcement,
  isFailure,
  parseAnnouncement,
  selectHost,
  type TerminalHost,
} from '../../src/successor/terminal-host.ts';
import {
  installAgent,
  installHerdr,
  ok,
  type Replies,
  type Reply,
  readCalls,
} from '../helpers/herdr-stub.ts';

// The hc adapter against an `hc` that prints replies captured verbatim from
// hc 0.1.20 (test/fixtures/hc): a `*.reply.jsonl` is what hc printed on stdout,
// a `*.stderr.jsonl` the JSON error it printed on stderr with exit 3 or 1.
const fixtures = new URL('../fixtures/hc/', import.meta.url);
const capture = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');
const json = (name: string) => JSON.parse(capture(name));
function captured(name: string, status = 0): Reply {
  return name.endsWith('.stderr.jsonl')
    ? { stderr: capture(name), status: status || 3 }
    : ok(capture(name));
}

// The Herdr desktop window's replies, captured verbatim from herdr-app 0.1.20.
const appFixtures = new URL('../fixtures/herdr-app/', import.meta.url);
const appReply = (name: string) =>
  ok(readFileSync(new URL(name, appFixtures), 'utf8'));

// A stubbed herdr-app always shadows the real one, so no test opens a space
// in the operator's window; a call without a reply exits 64.
function withHc(
  t: { after(fn: () => void): void },
  replies: Replies,
  env: NodeJS.ProcessEnv = {},
  appReplies: Replies = {},
): {
  host: TerminalHost;
  calls: () => string[][];
  appCalls: () => string[][];
} {
  const root = mkdtempSync(join(tmpdir(), 'terminal-host-hc-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = installHerdr(bin, replies, 'hc');
  const appLog = installHerdr(bin, appReplies, 'herdr-app');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    host: hcHost(env),
    calls: () => readCalls(log),
    appCalls: () => readCalls(appLog),
  };
}

test('captured hc replies sit on the stream hc prints them on', () => {
  const names = readdirSync(fixtures);
  assert.ok(names.some((name) => name.endsWith('.stderr.jsonl')));
  for (const name of names) {
    const text = capture(name);
    assert.ok(text.endsWith('\n'), `${name} ends with a newline`);
    const reply = JSON.parse(text);
    if (name.endsWith('.stderr.jsonl'))
      assert.equal(typeof reply.error?.kind, 'string', name);
    else assert.equal(reply.error, undefined, name);
  }
});

test('the host is chosen by HC_TERMINAL_ID over HERDR_PANE_ID, herdr by default', () => {
  assert.equal(selectHost({ HC_TERMINAL_ID: 't6' }).name, 'hc');
  assert.equal(selectHost({ HERDR_PANE_ID: 'w1:p1' }).name, 'herdr');
  // An hc terminal inherits the core's HERDR_* variables.
  assert.equal(
    selectHost({ HC_TERMINAL_ID: 't6', HERDR_PANE_ID: 'w1:p1' }).name,
    'hc',
  );
  assert.equal(selectHost({}).name, 'herdr');
});

test('the host reads its own session from HC_TERMINAL_ID and places it from get', (t) => {
  const { host } = withHc(
    t,
    { 'get t6': captured('get-claude-idle.reply.jsonl') },
    { HC_TERMINAL_ID: 't6' },
  );
  assert.equal(host.self(), 't6');
  assert.equal(hcHost({}).self(), undefined);
  assert.deepEqual(host.place(host.session('t6')), { scope: 'hc', tab: 't6' });
});

test('place answers nothing for a terminal hc does not know or that finished', (t) => {
  const { host } = withHc(t, {
    'get t9': captured('get-missing.stderr.jsonl'),
    'get t6': captured('get-finished.reply.jsonl'),
  });
  assert.deepEqual(host.place(host.session('t9')), {});
  assert.deepEqual(host.place(host.session('t6')), {});
});

test('status names why the host is unavailable', (t) => {
  const up = withHc(t, {
    'server status': captured('server-status.reply.jsonl'),
  });
  assert.equal(up.host.status(), undefined);
  const down = withHc(t, { 'server status': ok('{}\n') });
  assert.equal(down.host.status(), 'server did not respond');
  const none = withHc(t, {});
  assert.equal(none.host.status(), 'server did not respond');
  const root = mkdtempSync(join(tmpdir(), 'terminal-host-hc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = process.env.PATH;
  process.env.PATH = root;
  t.after(() => {
    process.env.PATH = path;
  });
  assert.equal(hcHost({}).status(), 'hc not on PATH');
});

test('open starts a parentless terminal with its environment and label and answers its address', (t) => {
  const { host, calls } = withHc(t, {
    'run --bg': captured('run-shell.reply.jsonl'),
  });
  const opened = host.open({
    cwd: '/repo',
    label: 'next',
    env: { A: '1', B: 'two words' },
  });
  assert.deepEqual(opened, { tab: 't7', session: 't7', scope: 'hc' });
  assert.deepEqual(calls()[0], [
    'run',
    '--bg',
    '--no-parent',
    '--cwd',
    '/repo',
    '--label',
    'krn-tab=next',
    '--',
    'env',
    '-u',
    'CLAUDE_CODE_CHILD_SESSION',
    'A=1',
    'B=two words',
    'bash',
  ]);
});

// The caller's space as hc reports it for a lead in the window (t12).
const callerSpace = 'sp9633122681c8ae8591e81c0d949234cc';
const spaceLabel = (call: string[] | undefined) =>
  call?.find((word) => word.startsWith('herdr.space='));

test('open puts the successor in the caller window space so it shows as a tab', (t) => {
  const { host, calls, appCalls } = withHc(
    t,
    {
      'get t12': captured('get-claude-in-space.reply.jsonl'),
      'run --bg': captured('run-shell.reply.jsonl'),
    },
    { HC_TERMINAL_ID: 't12' },
  );
  host.open({ cwd: '/repo', label: 'next', env: {} });
  const run = calls().find((call) => call[0] === 'run');
  assert.equal(spaceLabel(run), `herdr.space=${callerSpace}`);
  assert.deepEqual(run?.slice(-5), [
    '--',
    'env',
    '-u',
    'CLAUDE_CODE_CHILD_SESSION',
    'bash',
  ]);
  assert.deepEqual(appCalls(), []);
});

test('open outside the window uses the space of the successor folder, else a new one', (t) => {
  const listed = withHc(
    t,
    { 'run --bg': captured('run-shell.reply.jsonl') },
    {},
    { ls: appReply('ls.reply.json') },
  );
  listed.host.open({
    cwd: '/work/repo/krn',
    label: 'next',
    env: {},
  });
  assert.equal(
    spaceLabel(listed.calls().find((call) => call[0] === 'run')),
    `herdr.space=${callerSpace}`,
  );
  assert.deepEqual(listed.appCalls(), [['ls']]);

  const created = withHc(
    t,
    { 'run --bg': captured('run-shell.reply.jsonl') },
    {},
    {
      ls: appReply('ls.reply.json'),
      'do space.new': appReply('space-new.reply.json'),
    },
  );
  created.host.open({ cwd: '/work/other', label: 'next', env: {} });
  assert.equal(
    spaceLabel(created.calls().find((call) => call[0] === 'run')),
    'herdr.space=sp824baf0493c4c1933c8aa76c44296092',
  );
  assert.deepEqual(created.appCalls().at(-1), [
    'do',
    'space.new',
    '--name',
    'other',
    '--folder',
    '/work/other',
  ]);
});

test('open answers the failure hc printed', (t) => {
  const { host } = withHc(t, {
    'run --bg': { ...captured('run-dup-name.stderr.jsonl'), status: 1 },
  });
  const result = host.open({ cwd: '/repo', label: 'next', env: {} });
  assert.ok(isFailure(result));
  assert.equal(result.exit, 1);
  assert.equal(result.reason, 'name_taken');
  assert.equal(result.stderr, capture('run-dup-name.stderr.jsonl'));
});

test('type pastes its words into the terminal and reports a refused one', (t) => {
  const done = withHc(t, { 'send t7': captured('send-shell.reply.jsonl') });
  assert.equal(
    done.host.type(done.host.session('t7'), ['"$AGENT"', '-n', 'x']),
    undefined,
  );
  assert.deepEqual(done.calls()[0], ['send', 't7', '"$AGENT" -n x']);
  const refused = withHc(t, {
    'send t9': captured('send-missing.stderr.jsonl'),
  });
  const failure = refused.host.type(refused.host.session('t9'), ['x']);
  assert.ok(isFailure(failure));
  assert.equal(failure.reason, 'not_found');
  assert.equal(failure.exit, 3);
});

test('agent answers the program, status, incarnation and tab of the captures', (t) => {
  const { host } = withHc(t, {
    'get t6': captured('get-claude-idle.reply.jsonl'),
    'get t7': captured('get-shell.reply.jsonl'),
    'get t9': captured('get-missing.stderr.jsonl'),
    'get t5': captured('get-finished.reply.jsonl'),
  });
  const idle = json('get-claude-idle.reply.jsonl');
  assert.deepEqual(host.agent(host.session('t6')), {
    agent: 'claude',
    status: 'idle',
    sessionId: `t6@${idle.created_ms}`,
    tabId: 't6',
  });
  const shell = host.agent(host.session('t7'));
  assert.equal(shell.agent, 'bash');
  assert.equal(shell.status, undefined);
  assert.deepEqual(host.agent(host.session('t9')), { notFound: true });
  assert.deepEqual(host.agent(host.session('t5')), { notFound: true });
});

test('agent reads the working and done words of a Claude', (t) => {
  const { host } = withHc(t, {
    'get t6': [
      captured('get-claude-working.reply.jsonl'),
      captured('get-claude-done.reply.jsonl'),
    ],
  });
  assert.equal(host.agent(host.session('t6')).status, 'working');
  assert.equal(host.agent(host.session('t6')).status, 'done');
});

test('wait is true once the agent settles and false on a timeout or a block', (t) => {
  const settled = withHc(t, { 'wait t6': captured('wait-ended.reply.jsonl') });
  assert.equal(settled.host.wait(settled.host.session('t6'), 1500), true);
  assert.deepEqual(settled.calls()[0], ['wait', 't6', '--timeout', '2']);
  const late = withHc(t, { 'wait t8': captured('wait-timeout.reply.jsonl') });
  assert.equal(late.host.wait(late.host.session('t8'), 1000), false);
  const blocked = {
    stdout: `${JSON.stringify({ ...json('wait-ended.reply.jsonl'), status: 'blocked' })}\n`,
  };
  const held = withHc(t, { 'wait t6': blocked });
  assert.equal(held.host.wait(held.host.session('t6'), 1000), false);
  const gone = withHc(t, { 'wait t9': captured('get-missing.stderr.jsonl') });
  assert.equal(gone.host.wait(gone.host.session('t9'), 1000), false);
});

function commandsOf(pid: number): string[] {
  return spawnSync('ps', ['-o', 'comm=', '--ppid', String(pid)], {
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function childrenOf(pid: number | undefined): string[] {
  return spawnSync('ps', ['-o', 'pid=', '--ppid', String(pid)], {
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('busy is false for a shell, a lone agent or a waiting job and true for another program or an agent running a job', (t) => {
  const shell = withHc(t, { 'get t7': captured('get-shell.reply.jsonl') });
  assert.equal(shell.host.busy(shell.host.session('t7')), false);

  // The working capture's agent pid is gone from this host, so it has no child.
  const lone = withHc(t, {
    'get t6': captured('get-claude-working.reply.jsonl'),
  });
  assert.equal(lone.host.busy(lone.host.session('t6')), false);

  // A real process table: a parent with a child shell stands for the agent
  // that runs a background job. A job that runs a program is work; a poll
  // loop caught in `sleep` is a waiter and holds nothing (t-r53fan0: a done
  // predecessor kept such a loop for eight hours).
  // The setup waits for the job's own program by name: right after fork,
  // before exec, the child is still `bash`, which reads as work (t-j9sbgjm).
  const agentWith = (job: string, program: string) => {
    const parent = spawn('sh', ['-c', `bash -c '${job}' & wait`], {
      stdio: 'ignore',
    });
    t.after(() => {
      for (const shell of childrenOf(parent.pid))
        spawnSync('pkill', ['-P', shell]);
      spawnSync('pkill', ['-P', String(parent.pid)]);
      parent.kill();
    });
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !childrenOf(parent.pid).some((shell) =>
        commandsOf(Number(shell)).includes(program),
      )
    );
    const reply = json('get-claude-working.reply.jsonl');
    reply.foreground.pid = parent.pid;
    return withHc(t, { 'get t6': ok(`${JSON.stringify(reply)}\n`) }).host;
  };
  const working = agentWith(
    `${process.execPath} -e "setTimeout(() => {}, 30000)"; true`,
    'node',
  );
  assert.equal(working.busy(working.session('t6')), true);
  const waiter = agentWith('while :; do sleep 30; done', 'sleep');
  assert.equal(waiter.busy(waiter.session('t6')), false);

  const other = json('get-shell.reply.jsonl');
  other.foreground.name = 'vim';
  const editor = withHc(t, { 'get t7': ok(`${JSON.stringify(other)}\n`) });
  assert.equal(editor.host.busy(editor.host.session('t7')), true);

  const missing = withHc(t, {
    'get t9': captured('get-missing.stderr.jsonl'),
  });
  assert.equal(missing.host.busy(missing.host.session('t9')), false);
});

test('list answers live terminals with label, scope and status and their session on demand', (t) => {
  const { host, calls } = withHc(t, {
    ls: captured('ls-claude.reply.jsonl'),
    'get t6': captured('get-claude-labelled.reply.jsonl'),
  });
  const tabs = host.list('hc' as never);
  assert.ok(!isFailure(tabs));
  assert.equal(tabs.length, 1);
  const [tab] = tabs;
  assert.equal(tab?.tab, 't6');
  assert.equal(tab?.label, 'handed off → next');
  assert.equal(tab?.scope, 'hc');
  assert.equal(tab?.status, 'done');
  assert.deepEqual(tab?.sessions(), ['t6']);
  assert.deepEqual(calls()[0], ['ls']);
});

test('list leaves an unlabelled terminal without a label and skips finished ones', (t) => {
  const { host } = withHc(t, {
    ls: ok(
      `${JSON.stringify({
        hidden_finished: 0,
        terminals: [
          ...json('ls-shell.reply.jsonl').terminals,
          ...json('ls-all-finished.reply.jsonl').terminals,
        ],
      })}\n`,
    ),
    'get t7': captured('get-shell.reply.jsonl'),
  });
  const tabs = host.list('hc' as never);
  assert.ok(!isFailure(tabs));
  assert.deepEqual(
    tabs.map((tab) => [tab.tab, tab.label]),
    [['t7', 'next']],
  );
  const empty = withHc(t, { ls: captured('ls-empty.reply.jsonl') });
  assert.deepEqual(empty.host.list('hc' as never), []);
});

test('removeFinished removes only the finished terminals started under the project folder (t-r53fan0)', (t) => {
  // A verbatim `hc ls --all` with one finished terminal in the project (t25)
  // beside live ones, plus a finished terminal of another folder.
  const project = json('ls-all-project-finished.reply.jsonl');
  const root = project.terminals.find(
    (terminal: { state: string }) => terminal.state === 'finished',
  ).cwd as string;
  const { host, calls } = withHc(t, {
    'ls --all': ok(
      `${JSON.stringify({
        ...project,
        terminals: [
          ...project.terminals,
          ...json('ls-all-finished.reply.jsonl').terminals,
        ],
      })}\n`,
    ),
    'rm t25': captured('rm-project.reply.jsonl'),
  });
  assert.deepEqual(host.removeFinished(root), ['t25']);
  assert.deepEqual(
    calls().filter((call) => call[0] === 'rm'),
    [['rm', 't25']],
  );
  assert.deepEqual(host.removeFinished(`${root}-other`), []);
  const unreadable = withHc(t, { 'ls --all': ok('not json\n') });
  assert.deepEqual(unreadable.host.removeFinished(root), []);
});

test('retire closes the settled handed-off terminal and removes the finished terminals of the project (t-r53fan0)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'retire-hc-'));
  // A relay started this process with its own predecessor pair; this retire
  // runs without one.
  const pair = ['KRN_PREDECESSOR_PANE', 'KRN_PREDECESSOR_SESSION'] as const;
  const saved = pair.map((name) => process.env[name]);
  for (const name of pair) delete process.env[name];
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    pair.forEach((name, index) => {
      if (saved[index] !== undefined) process.env[name] = saved[index];
    });
  });
  // The `hc ls --all` capture, its project folder moved to this test's root.
  const project = json('ls-all-project-finished.reply.jsonl');
  const listed = JSON.stringify(project).replaceAll(
    project.terminals[0].cwd,
    root,
  );
  const { host, calls } = withHc(
    t,
    {
      'get t7': captured('get-shell.reply.jsonl'),
      ls: captured('ls-claude.reply.jsonl'),
      'get t6': captured('get-claude-labelled.reply.jsonl'),
      'read t6': ok(
        readFileSync(
          new URL(
            '../fixtures/herdr/pane-read-empty-prompt.txt',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
      'kill t6': captured('kill.reply.jsonl'),
      'ls --all': ok(`${listed}\n`),
      'rm t25': captured('rm-project.reply.jsonl'),
    },
    { HC_TERMINAL_ID: 't7' },
  );
  assert.equal(
    retireMode(['--cwd', root], () => {}, Date.now, host),
    0,
  );
  assert.deepEqual(
    calls().filter((call) => call[0] === 'kill' || call[0] === 'rm'),
    [
      ['kill', 't6'],
      ['rm', 't25'],
    ],
  );
});

test('list answers the failure of an unreadable list', (t) => {
  const { host } = withHc(t, { ls: ok('not json\n') });
  const result = host.list('hc' as never);
  assert.ok(isFailure(result));
  assert.equal(result.reason, 'malformed terminal list');
});

test('close, closeTab and rename answer nothing when done and the reason when refused', (t) => {
  const { host, calls } = withHc(t, {
    'kill t6': captured('kill.reply.jsonl'),
    'kill t9': captured('kill-missing.stderr.jsonl'),
    'label t6': captured('label.reply.jsonl'),
  });
  assert.equal(host.close(host.session('t6')), undefined);
  assert.equal(host.closeTab(host.tab('t6')), undefined);
  const refused = host.closeTab(host.tab('t9'));
  assert.ok(isFailure(refused));
  assert.equal(refused.reason, 'not_found');
  assert.equal(host.rename(host.tab('t6'), 'handed off → next'), undefined);
  assert.deepEqual(calls().at(-1), [
    'label',
    't6',
    'krn-tab=handed off → next',
  ]);
});

test('the launcher announcement round-trips through the hc host', () => {
  const host = hcHost({});
  const ids = { tab: host.tab('t7'), session: host.session('t7') };
  const line = announcement(host, ids, 'claude', 'idle');
  assert.equal(line, 'successor: hc tab t7 pane t7 agent claude idle');
  assert.deepEqual(parseAnnouncement(host, `noise\n${line}\n`), ids);
  assert.equal(
    parseAnnouncement(herdrHost({}), line),
    undefined,
    'a herdr launcher does not read an hc line',
  );
});

// The launcher end to end inside an hc terminal: the successor opens as a
// parentless terminal, shows its Claude, and the caller is retired by label.
test('the launcher opens a successor in hc, waits for its agent and relabels the caller', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'successor-hc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const hcCalls = installHerdr(
    bin,
    {
      'server status': captured('server-status.reply.jsonl'),
      'get t6': captured('get-claude-working.reply.jsonl'),
      'run --bg': captured('run-shell.reply.jsonl'),
      'get t7': captured('get-claude-idle.reply.jsonl'),
      'send t7': captured('send-shell.reply.jsonl'),
      'label t6': captured('label.reply.jsonl'),
    },
    'hc',
  );
  installAgent(bin, 'successor-agent', join(root, 'agent-calls'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const script = fileURLToPath(
    new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('HERDR_') &&
        !name.startsWith('HC_') &&
        !name.startsWith('CODEX_') &&
        !name.startsWith('CLAUDE') &&
        name !== 'KRN_SUCCESSOR_AGENT',
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--operator-token',
      '--name',
      'Next slice',
      '--prompt',
      'Deliver t-x',
      '--cwd',
      cwd,
    ],
    {
      cwd: root,
      env: {
        ...env,
        PATH: bin,
        KRN_SUCCESSOR_AGENT: 'successor-agent',
        HC_TERMINAL_ID: 't6',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'successor: hc tab t7 pane t7 agent claude idle\n',
  );
  const calls = readCalls(hcCalls);
  const verbs = calls.map((call) => call[0]);
  assert.deepEqual(verbs.slice(0, 2), ['server', 'get']);
  const run = calls.find((call) => call[0] === 'run');
  assert.ok(run?.includes('--no-parent'));
  assert.ok(run?.includes('krn-tab=Next slice'));
  const send = calls.find((call) => call[0] === 'send');
  assert.equal(send?.[1], 't7');
  assert.match(
    send?.[2] ?? '',
    /^"\$KRN_SUCCESSOR_AGENT" .*"\$KRN_SUCCESSOR_PROMPT"$/u,
  );
  assert.deepEqual(calls.at(-1), [
    'label',
    't6',
    'krn-tab=handed off → Next slice',
  ]);
  const ledger = join(cwd, '.krn', 'successors', 'launches.jsonl');
  assert.ok(existsSync(ledger));
  const launch = JSON.parse(readFileSync(ledger, 'utf8').trim());
  // One row per launch names the launched successor (#1108).
  assert.equal(launch.pane_id, 't7');
  assert.equal(launch.tab_id, 't7');
});

test('the Herdr app is the baseline host: hc on PATH wins over the multiplexer (t-af0fgyh)', async () => {
  // Evidence: a relay started from a Herdr multiplexer pane opened its successor there, not in the app.
  const { selectHost } = await import('../../src/successor/terminal-host.ts');
  const bin = mkdtempSync(join(tmpdir(), 'hc-path-'));
  try {
    writeFileSync(join(bin, 'hc'), '#!/bin/sh\n', { mode: 0o755 });
    const multiplexer = { HERDR_PANE_ID: 'w1:p1', PATH: bin };
    assert.equal(selectHost(multiplexer).name, 'hc');
    assert.equal(
      selectHost({ ...multiplexer, KRN_TERMINAL_HOST: 'herdr' }).name,
      'herdr',
    );
    assert.equal(
      selectHost({ HERDR_PANE_ID: 'w1:p1', PATH: '/nonexistent' }).name,
      'herdr',
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
