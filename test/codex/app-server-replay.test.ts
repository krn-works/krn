import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ReplayTransport } from '../../scripts/codex/app-server-replay.ts';

const tool = resolve('scripts/codex/app-server-replay.ts');

function replay(transcript: string, roots: readonly string[] = []) {
  const sent: string[] = [];
  const logged: string[] = [];
  const transport = new ReplayTransport(
    transcript,
    roots,
    (lines) => sent.push(lines),
    (lines) => logged.push(lines),
  );
  return { transport, sent, logged };
}

test('ReplayTransport answers each expected outbound frame with the inbound frames after it', () => {
  const transcript =
    '< {"method":"ready"}\n> {"id":1}\n< {"id":1,"result":{}}\n< {"method":"done"}\n> {"id":2}\n';
  const { transport, sent, logged } = replay(transcript);
  transport.start();
  assert.deepEqual(sent, ['{"method":"ready"}\n']);
  assert.equal(transport.receive('{"id":1}'), true);
  assert.equal(sent.at(-1), '{"id":1,"result":{}}\n{"method":"done"}\n');
  assert.equal(transport.complete, false);
  assert.equal(transport.receive('{"id":2}'), true);
  assert.equal(transport.complete, true);
  assert.equal(logged.join(''), transcript);
});

test('ReplayTransport refuses a different outbound frame and one past the end, logging what it got', () => {
  const changed = replay('> {"id":1}\n');
  assert.equal(changed.transport.receive('{"id":2}'), false);
  assert.equal(changed.logged.join(''), '> {"id":2}\n');
  const ended = replay('> {"id":1}\n');
  assert.equal(ended.transport.receive('{"id":1}'), true);
  assert.equal(ended.transport.receive('{"id":1}'), false);
});

test('ReplayTransport compares outbound frames with host roots replaced, the longest root first', () => {
  const { transport } = replay(
    '> {"cwd":"/work/repo/a","home":"/work/repo"}\n',
    ['/h', '/h/repo', '/'],
  );
  assert.equal(transport.receive('{"cwd":"/h/repo/a","home":"/h"}'), true);
});

test('ReplayTransport rejects a transcript line without a direction or a final newline', () => {
  assert.throws(() => replay('{"id":1}\n'), /line 1 needs/);
  assert.throws(() => replay('> {"id":1}'), /must end with a newline/);
});

test('record mode passes frames through unchanged and logs them with host roots replaced', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'krn-replay-tool-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'codex.mjs');
  writeFileSync(
    target,
    `#!/usr/bin/env node
let rest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rest += chunk;
  for (let at = rest.indexOf('\\n'); at >= 0; at = rest.indexOf('\\n')) {
    const { id } = JSON.parse(rest.slice(0, at));
    rest = rest.slice(at + 1);
    const leaked = Object.keys(process.env).some((key) => key.startsWith('CODEX_KRN_'));
    process.stdout.write(JSON.stringify({ id, result: { cwd: process.cwd(), leaked } }) + '\\n');
  }
});
`,
  );
  chmodSync(target, 0o755);
  const log = join(root, 'frames.rpc');
  const result = spawnSync(
    process.execPath,
    [tool, 'app-server', '--listen', 'stdio://'],
    {
      cwd: root,
      encoding: 'utf8',
      input: `{"id":1,"params":{"cwd":"${root}"}}\n`,
      env: { ...process.env, CODEX_KRN_LOG: log, CODEX_KRN_TARGET: target },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `{"id":1,"result":{"cwd":"${root}","leaked":false}}\n`,
  );
  assert.equal(
    readFileSync(log, 'utf8'),
    '> {"id":1,"params":{"cwd":"/work/repo"}}\n< {"id":1,"result":{"cwd":"/work/repo","leaked":false}}\n',
  );
});

test('replay mode exits 1 at the first mismatch and 64 without exactly one mode', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'krn-replay-tool-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'session.rpc');
  writeFileSync(transcript, '> {"id":1}\n< {"id":1,"result":{}}\n');
  const run = (input: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [tool, 'app-server', '--listen', 'stdio://'], {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { ...process.env, CODEX_KRN_LOG: join(root, 'played.rpc'), ...env },
    });
  const played = run('{"id":1}\n', { CODEX_KRN_REPLAY: transcript });
  assert.equal(played.status, 0, played.stderr);
  assert.equal(played.stdout, '{"id":1,"result":{}}\n');
  assert.equal(run('{"id":2}\n', { CODEX_KRN_REPLAY: transcript }).status, 1);
  assert.equal(run('', {}).status, 64);
  assert.equal(
    run('', { CODEX_KRN_REPLAY: transcript, CODEX_KRN_TARGET: 'codex' }).status,
    64,
  );
});
