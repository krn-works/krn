import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerEnvironment } from '../../src/hosts/codex.ts';

test('Codex executable honors KRN_CODEX_BIN', async () => {
  const previous = process.env.KRN_CODEX_BIN;
  process.env.KRN_CODEX_BIN = '/tmp/krn-custom-codex';
  try {
    const moduleUrl = new URL('../../src/hosts/codex.ts', import.meta.url);
    moduleUrl.searchParams.set('codex-bin-test', String(Date.now()));
    const { defaultCodexExecutable: executable } = await import(moduleUrl.href);
    assert.equal(executable, '/tmp/krn-custom-codex');
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
    XDG_RUNTIME_DIR: '/runtime/worker',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/runtime/worker/bus',
    HTTPS_PROXY: 'https://proxy.example',
    HTTP_PROXY: 'http://proxy.example',
    NO_PROXY: 'localhost',
    https_proxy: 'https://proxy.example',
    http_proxy: 'http://proxy.example',
    no_proxy: 'localhost',
    CODEX_HOME: '/home/worker/.codex',
    OPENAI_API_KEY: 'worker-auth',
    KRN_SERVICE_TOKEN: 'service-token',
    SERVICE_API_KEY: 'service-key',
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
