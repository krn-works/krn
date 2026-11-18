import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { herdrHost } from '../../src/successor/host-herdr.ts';
import {
  announcement,
  isFailure,
  parseAnnouncement,
  type TerminalHost,
} from '../../src/successor/terminal-host.ts';
import {
  capture,
  captureReply,
  installHerdr,
  ok,
  type Replies,
  readCalls,
} from '../helpers/herdr-stub.ts';

// The Herdr adapter against a `herdr` that prints the verbatim captures; the
// port's contract is what each method answers for them.
function withHerdr(
  t: { after(fn: () => void): void },
  replies: Replies,
  env: NodeJS.ProcessEnv = {},
): { host: TerminalHost; calls: () => string[][] } {
  const root = mkdtempSync(join(tmpdir(), 'terminal-host-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = installHerdr(bin, replies);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  });
  return { host: herdrHost(env), calls: () => readCalls(log) };
}

const json = (name: string) => JSON.parse(capture(name));

test('the host reads its own session from HERDR_PANE_ID and places it from pane get', (t) => {
  const { host } = withHerdr(
    t,
    { 'pane get': captureReply('pane-get.reply.jsonl') },
    { HERDR_PANE_ID: 'w2E:pH' },
  );
  assert.equal(host.self(), 'w2E:pH');
  assert.equal(herdrHost({}).self(), undefined);
  assert.deepEqual(host.place(host.session('w2E:pH')), {
    scope: 'w2E',
    tab: 'w2E:tH',
  });
});

test('place answers nothing for a pane herdr does not know', (t) => {
  const { host } = withHerdr(t, {
    'pane get': captureReply('pane-get-missing.stderr.jsonl'),
  });
  assert.deepEqual(host.place(host.session('w2E:pX')), {});
});

test('status names why the host is unavailable', (t) => {
  const up = withHerdr(t, { status: captureReply('server-status.txt') });
  assert.equal(up.host.status(), undefined);
  const down = withHerdr(t, { status: ok('server:\n  status: stopped\n') });
  assert.equal(down.host.status(), 'server did not respond');
});

test('open creates an unfocused tab with its environment and answers its ids', (t) => {
  const { host, calls } = withHerdr(t, {
    'tab create': captureReply('tab-create.reply.jsonl'),
  });
  const opened = host.open({
    scope: 'w2E' as never,
    cwd: '/repo',
    label: 'next',
    env: { A: '1', B: 'two words' },
  });
  assert.deepEqual(opened, {
    tab: 'w2E:tH',
    session: 'w2E:pH',
    scope: 'w2E',
  });
  assert.deepEqual(calls()[0], [
    'tab',
    'create',
    '--workspace',
    'w2E',
    '--cwd',
    '/repo',
    '--label',
    'next',
    '--env',
    'A=1',
    '--env',
    'B=two words',
    '--no-focus',
  ]);
});

test('open answers the failure herdr printed', (t) => {
  const { host } = withHerdr(t, {
    'tab create': captureReply('tab-create-missing-workspace.stderr.jsonl'),
  });
  const result = host.open({ cwd: '/repo', label: 'next', env: {} });
  assert.ok(isFailure(result));
  assert.equal(result.exit, 1);
  assert.equal(result.reason, 'workspace_not_found');
  assert.equal(
    result.stderr,
    capture('tab-create-missing-workspace.stderr.jsonl'),
  );
});

test('type passes its words to pane run and reports a refused one', (t) => {
  const done = withHerdr(t, { 'pane run': ok('') });
  assert.equal(
    done.host.type(done.host.session('w2E:pH'), ['echo', 'hi']),
    undefined,
  );
  assert.deepEqual(done.calls()[0], ['pane', 'run', 'w2E:pH', 'echo', 'hi']);
  const refused = withHerdr(t, {
    'pane run': captureReply('pane-run-missing.stderr.jsonl'),
  });
  const failure = refused.host.type(refused.host.session('w2E:pX'), ['x']);
  assert.ok(isFailure(failure));
  assert.equal(failure.reason, 'pane_not_found');
});

test('agent answers the status, session and tab of the captures, and not found for a missing one', (t) => {
  const { host } = withHerdr(t, {
    'agent get w1D:p53': captureReply('agent-get-idle-claude.reply.jsonl'),
    'agent get w1D:pX': captureReply('agent-get-missing.stderr.jsonl'),
  });
  assert.deepEqual(host.agent(host.session('w1D:p53')), {
    agent: 'claude',
    status: 'idle',
    sessionId: json('agent-get-idle-claude.reply.jsonl').result.agent
      .agent_session.value,
    tabId: 'w1D:t4Z',
  });
  assert.deepEqual(host.agent(host.session('w1D:pX')), { notFound: true });
});

test('wait is true once the agent settles and false on its timeout', (t) => {
  const settled = withHerdr(t, {
    'agent wait': captureReply('agent-wait.reply.jsonl'),
  });
  assert.equal(settled.host.wait(settled.host.session('w1D:pAS'), 1000), true);
  assert.deepEqual(settled.calls()[0], [
    'agent',
    'wait',
    'w1D:pAS',
    '--until',
    'idle',
    '--until',
    'done',
    '--timeout',
    '1000',
  ]);
  const late = withHerdr(t, {
    'agent wait': captureReply('agent-wait-timeout.stderr.jsonl'),
  });
  assert.equal(late.host.wait(late.host.session('w1D:pAS'), 1000), false);
});

test('busy is true for a foreground process other than the agent and false for a lone agent', (t) => {
  const working = withHerdr(t, {
    'pane process-info': captureReply('pane-process-info-working.reply.jsonl'),
  });
  const lone = json('pane-process-info-working.reply.jsonl');
  const names = lone.result.process_info.foreground_processes.map(
    (p: { name: string }) => p.name,
  );
  assert.equal(
    working.host.busy(working.host.session('w1D:pJB')),
    names.some((name: string) => name !== 'claude'),
  );
  const missing = withHerdr(t, {
    'pane process-info': captureReply('pane-get-missing.stderr.jsonl'),
  });
  assert.equal(missing.host.busy(missing.host.session('w1D:pX')), false);
});

test('list answers tabs with label, scope and status and their sessions on demand', (t) => {
  const { host, calls } = withHerdr(t, {
    'tab list': captureReply('tab-list.reply.jsonl'),
    'pane list': captureReply('pane-list.reply.jsonl'),
  });
  const tabs = host.list('w1D' as never);
  assert.ok(!isFailure(tabs));
  assert.equal(tabs.length, 1);
  const [tab] = tabs;
  assert.equal(tab?.tab, 'w1D:t6P');
  assert.equal(tab?.label, 'close handed-off tabs');
  assert.equal(tab?.scope, 'w1D');
  assert.equal(tab?.status, 'working');
  assert.equal(calls().length, 1, 'sessions are listed only when asked');
  const panes = json('pane-list.reply.jsonl').result.panes as {
    pane_id: string;
    tab_id: string;
  }[];
  const expected = panes
    .filter((pane) => pane.tab_id === 'w1D:t6P')
    .map((pane) => pane.pane_id);
  assert.deepEqual(tab?.sessions(), expected);
});

test('list answers the failure of a missing workspace', (t) => {
  const { host } = withHerdr(t, {
    'tab list': captureReply('tab-list-missing-workspace.stderr.jsonl'),
  });
  const result = host.list('w9' as never);
  assert.ok(isFailure(result));
  assert.equal(result.reason, 'workspace_not_found');
});

test('close, closeTab and rename answer nothing when done and the reason when refused', (t) => {
  const { host, calls } = withHerdr(t, {
    'pane close': captureReply('pane-close.reply.jsonl'),
    'pane read': ok(capture('pane-read-empty-prompt.txt')),
    'tab close w1D:tB1': captureReply('tab-close-missing.stderr.jsonl'),
    'tab close w1D:tOK': captureReply('tab-close.reply.jsonl'),
    'tab rename': captureReply('tab-rename.reply.jsonl'),
  });
  assert.equal(host.close(host.session('w1D:pJB')), undefined);
  assert.equal(host.closeTab(host.tab('w1D:tOK')), undefined);
  const refused = host.closeTab(host.tab('w1D:tB1'));
  assert.ok(isFailure(refused));
  assert.equal(refused.reason, 'tab_not_found');
  assert.equal(
    host.rename(host.tab('w1D:tOK'), 'handed off → next'),
    undefined,
  );
  assert.deepEqual(calls().at(-1), [
    'tab',
    'rename',
    'w1D:tOK',
    'handed off → next',
  ]);
});

test('the launcher announcement round-trips through the host that wrote it', () => {
  const host = herdrHost({});
  const ids = { tab: host.tab('w2E:tH'), session: host.session('w2E:pH') };
  const line = announcement(host, ids, 'claude', 'blocked');
  assert.equal(
    line,
    'successor: herdr tab w2E:tH pane w2E:pH agent claude blocked',
  );
  assert.deepEqual(parseAnnouncement(host, `noise\n${line}\n`), ids);
  assert.equal(
    parseAnnouncement(host, 'successor: other tab a pane b agent c d'),
    undefined,
  );
});
