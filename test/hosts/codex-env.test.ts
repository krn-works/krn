import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost, workerEnvironment } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('Codex executable honors KRN_CODEX_BIN', async () => {
  const previous = process.env.KRN_CODEX_BIN;
  process.env.KRN_CODEX_BIN = '/tmp/krn-custom-codex';
  try {
    const moduleUrl = new URL('../../src/hosts/codex.ts', import.meta.url);
    moduleUrl.searchParams.set('codex-bin-test', String(Date.now()));
    const { defaultCodexExecutable } = await import(moduleUrl.href);
    assert.equal(defaultCodexExecutable, '/tmp/krn-custom-codex');
  } finally {
    if (previous === undefined) delete process.env.KRN_CODEX_BIN;
    else process.env.KRN_CODEX_BIN = previous;
  }
});

test('workerEnvironment keeps only the Codex runtime allowlist', () => {
  const source = {
    HOME: '/home/worker',
    PATH: '/usr/bin',
    USER: 'worker',
    LOGNAME: 'worker',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TZ: 'UTC',
    TMPDIR: '/tmp',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    HTTPS_PROXY: 'https://proxy.example',
    HTTP_PROXY: 'http://proxy.example',
    NO_PROXY: 'localhost',
    https_proxy: 'https://proxy.example',
    http_proxy: 'http://proxy.example',
    no_proxy: 'localhost',
    CODEX_HOME: '/home/worker/.codex',
    OPENAI_API_KEY: 'worker-auth',
    KRN_PAPERCLIP_TOKEN: 'board-token',
    PAPERCLIP_API_KEY: 'board-key',
    OTHER_SECRET: 'drop-me',
  };
  assert.deepEqual(workerEnvironment(source), {
    HOME: source.HOME,
    PATH: source.PATH,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    TERM: source.TERM,
    TZ: source.TZ,
    TMPDIR: source.TMPDIR,
    XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS,
    HTTPS_PROXY: source.HTTPS_PROXY,
    HTTP_PROXY: source.HTTP_PROXY,
    NO_PROXY: source.NO_PROXY,
    https_proxy: source.https_proxy,
    http_proxy: source.http_proxy,
    no_proxy: source.no_proxy,
    CODEX_HOME: source.CODEX_HOME,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
  });
});

test('Codex worker does not receive board credentials', async (t) => {
  if (process.env.KRN_ISOLATION_CAPABILITIES) {
    if (
      !requiresIsolation(t, 'Codex worker does not receive board credentials', [
        'systemdUserScope',
      ])
    )
      return;
  } else {
    t.skip('systemd user scope capability probe is not available');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-env-'));
  const envFile = join(directory, 'worker-env.json');
  const executable = join(directory, 'fake-codex');
  const previous = {
    KRN_PAPERCLIP_TOKEN: process.env.KRN_PAPERCLIP_TOKEN,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
  };
  process.env.KRN_PAPERCLIP_TOKEN = 'sentinel-token';
  process.env.PAPERCLIP_API_KEY = 'sentinel-key';
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');\n`,
    );
    await chmod(executable, 0o755);
    const host = new CodexHost({ executable });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'Run pwd',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    const workerEnv = JSON.parse(await readFile(envFile, 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(workerEnv.KRN_PAPERCLIP_TOKEN, undefined);
    assert.equal(workerEnv.PAPERCLIP_API_KEY, undefined);
    assert.ok(workerEnv.HOME);
    assert.ok(workerEnv.PATH);
    assert.equal(result.finalMessage, 'ready');
  } finally {
    if (previous.KRN_PAPERCLIP_TOKEN === undefined)
      delete process.env.KRN_PAPERCLIP_TOKEN;
    else process.env.KRN_PAPERCLIP_TOKEN = previous.KRN_PAPERCLIP_TOKEN;
    if (previous.PAPERCLIP_API_KEY === undefined)
      delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = previous.PAPERCLIP_API_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});
