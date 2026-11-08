import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  capture,
  captureReply,
  failure,
  installAgent,
  installHerdr,
  ok,
  readCalls,
} from './herdr-stub.ts';

function temporary(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-stub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, bin };
}

// PATH holds only the stubs, so a stub that runs anything but a shell builtin
// fails here; the timeout turns a stub that loops into a failure, not a hang.
function call(bin: string, command: string, ...args: string[]) {
  const result = spawnSync(command, args, {
    env: { PATH: bin },
    encoding: 'utf8',
    timeout: 5000,
  });
  return [result.status, result.stdout, result.stderr];
}

const missing = capture('agent-get-missing.stderr.jsonl');

test('a reply list answers the calls on its key in turn, its last entry repeating', (t) => {
  const { bin } = temporary(t);
  const calls = installHerdr(bin, {
    'agent get': captureReply('agent-get-missing.stderr.jsonl'),
    'agent get p:1': [ok('first\n'), ok('second\n'), failure('gone\n', 3)],
  });

  assert.deepEqual(call(bin, 'herdr', 'agent', 'get', 'p:1'), [
    0,
    'first\n',
    '',
  ]);
  // A pane whose id extends the key's falls back to the two-word key and
  // leaves the count of p:1 alone.
  assert.deepEqual(call(bin, 'herdr', 'agent', 'get', 'p:10'), [
    1,
    '',
    missing,
  ]);
  assert.deepEqual(call(bin, 'herdr', 'agent', 'get', 'p:1'), [
    0,
    'second\n',
    '',
  ]);
  assert.deepEqual(call(bin, 'herdr', 'agent', 'get', 'p:1'), [
    3,
    '',
    'gone\n',
  ]);
  assert.deepEqual(call(bin, 'herdr', 'agent', 'get', 'p:1'), [
    3,
    '',
    'gone\n',
  ]);
  assert.deepEqual(readCalls(calls), [
    ['agent', 'get', 'p:1'],
    ['agent', 'get', 'p:10'],
    ['agent', 'get', 'p:1'],
    ['agent', 'get', 'p:1'],
    ['agent', 'get', 'p:1'],
  ]);
});

test('a reply keeps its bytes and its stream', (t) => {
  const { bin } = temporary(t);
  const shell = `it's "quoted" $HOME \`date\` \\n → done`;
  installHerdr(bin, {
    status: captureReply('server-status.txt'),
    'pane get': ok(shell),
    'pane close': { stdout: 'out\n', stderr: 'err\n', status: 2 },
  });

  assert.deepEqual(call(bin, 'herdr', 'status'), [
    0,
    capture('server-status.txt'),
    '',
  ]);
  assert.deepEqual(call(bin, 'herdr', 'pane', 'get', 'x'), [0, shell, '']);
  assert.deepEqual(call(bin, 'herdr', 'pane', 'close', 'x'), [
    2,
    'out\n',
    'err\n',
  ]);
});

test('a call no key answers exits 64 and is still logged', (t) => {
  const { bin } = temporary(t);
  const calls = installHerdr(bin, { 'pane run': ok('') });

  for (const args of [['tab', 'close', 'x'], [], [''], ['.'], ['..', 'x']])
    assert.deepEqual(call(bin, 'herdr', ...args), [64, '', ''], `${args}`);
  assert.deepEqual(call(bin, 'herdr', 'pane', 'run', 'p', '"$A"', '', 'a b'), [
    0,
    '',
    '',
  ]);
  assert.deepEqual(readCalls(calls), [
    ['tab', 'close', 'x'],
    [],
    [''],
    ['.'],
    ['..', 'x'],
    ['pane', 'run', 'p', '"$A"', '', 'a b'],
  ]);
});

test('a table key must name a directory and hold a reply', (t) => {
  const { bin } = temporary(t);
  assert.throws(() => installHerdr(bin, { 'tab/list': ok('') }), /directory/u);
  assert.throws(() => installHerdr(bin, { '..': ok('') }), /directory/u);
  assert.throws(() => installHerdr(bin, { 'tab list': [] }), /no reply/u);
});

test('an agent stub logs its words and exits with its status', (t) => {
  const { root, bin } = temporary(t);
  const calls = join(root, 'agent-calls');
  installAgent(bin, 'claude', calls, 19);

  assert.deepEqual(readCalls(calls), []);
  assert.deepEqual(call(bin, 'claude', '--bg', '-n', 'Next slice', "it's"), [
    19,
    '',
    '',
  ]);
  assert.deepEqual(readCalls(calls), [['--bg', '-n', 'Next slice', "it's"]]);
});
