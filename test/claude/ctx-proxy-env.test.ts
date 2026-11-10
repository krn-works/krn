import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  HEALTH_TIMEOUT_MS,
  KILL_FILE,
  proxyBaseUrl,
} from '../../scripts/claude/ctx-proxy-env.ts';
import {
  captureReply,
  installAgent,
  installHerdr,
  ok,
  readCalls,
} from '../helpers/herdr-stub.ts';

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL('../../scripts/claude/successor-launch.ts', import.meta.url),
);

async function health(
  t: { after(fn: () => void): void },
  status: number,
  delayMs = 0,
) {
  const server = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(req.url === '/krn-health' ? status : 404).end('ok\n');
    };
    if (delayMs) setTimeout(reply, delayMs);
    else reply();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.closeAllConnections() ?? server.close());
  return (server.address() as AddressInfo).port;
}

// The health deadline follows the cost of one real probe on this host, so a
// loaded machine widens it instead of timing out a healthy local proxy.
async function deadlineMs(
  t: { after(fn: () => void): void },
  floorMs = HEALTH_TIMEOUT_MS,
  factor = 20,
) {
  const port = await health(t, 200);
  const started = performance.now();
  await proxyBaseUrl({ KRN_CTX_PROXY_PORT: String(port) }, tmpdir(), 30_000);
  return Math.max(floorMs, Math.ceil(factor * (performance.now() - started)));
}

function scratch(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-proxy-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a healthy proxy yields its base URL', async (t) => {
  const port = await health(t, 200);
  const base = await proxyBaseUrl(
    { KRN_CTX_PROXY_PORT: String(port) },
    scratch(t),
    await deadlineMs(t),
  );
  assert.equal(base, `http://127.0.0.1:${port}`);
});

test('an unhealthy, slow or absent proxy yields nothing', async (t) => {
  const root = scratch(t);
  const bad = await health(t, 503);
  const deadline = await deadlineMs(t);
  const slow = await health(t, 200, deadline * 3);
  assert.equal(
    await proxyBaseUrl({ KRN_CTX_PROXY_PORT: String(bad) }, root, deadline),
    undefined,
  );
  assert.equal(
    await proxyBaseUrl({ KRN_CTX_PROXY_PORT: String(slow) }, root, deadline),
    undefined,
  );
  assert.equal(
    await proxyBaseUrl({ KRN_CTX_PROXY_PORT: '1' }, root),
    undefined,
  );
});

test('the kill switch and a foreign base URL skip the proxy', async (t) => {
  const port = await health(t, 200);
  const env = {
    KRN_CTX_PROXY_PORT: String(port),
    KRN_CTX_PROXY_TIMEOUT_MS: String(await deadlineMs(t)),
  };
  const root = scratch(t);
  assert.ok(await proxyBaseUrl(env, root));
  assert.equal(
    await proxyBaseUrl({ ...env, KRN_CTX_PROXY: 'off' }, root),
    undefined,
  );
  assert.equal(
    await proxyBaseUrl(
      { ...env, ANTHROPIC_BASE_URL: 'https://example.test' },
      root,
    ),
    undefined,
  );
  mkdirSync(join(root, '.krn/runs/ctx-proxy'), { recursive: true });
  writeFileSync(join(root, KILL_FILE), '');
  assert.equal(await proxyBaseUrl(env, root), undefined);
});

test('the launcher passes the proxy to a Claude successor only when healthy', async (t) => {
  const port = await health(t, 200);
  const timeout = String(await deadlineMs(t, 5000, 200));
  const run = async (extra: Record<string, string>) => {
    const root = scratch(t);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const calls = installHerdr(bin, {
      status: captureReply('server-status.txt'),
      'tab create': captureReply('tab-create.reply.jsonl'),
      'pane run': ok(''),
      'agent get': captureReply('agent-get-working-claude.reply.jsonl'),
    });
    installAgent(bin, 'claude', join(root, 'agent-calls'));
    await exec(
      process.execPath,
      [
        script,
        '--operator-token',
        '--name',
        'n',
        '--prompt',
        'p',
        '--cwd',
        root,
        '--start-seconds',
        '1',
      ],
      {
        cwd: root,
        env: {
          PATH: bin,
          KRN_SUCCESSOR_AGENT: 'claude',
          KRN_CTX_PROXY_PORT: String(port),
          KRN_CTX_PROXY_TIMEOUT_MS: timeout,
          ...extra,
        },
      },
    ).catch(() => undefined);
    return (
      readCalls(calls).find((c) => c[0] === 'tab' && c[1] === 'create') ?? []
    );
  };
  const on = await run({});
  assert.ok(
    on.includes(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`),
    JSON.stringify(on),
  );
  const off = await run({ KRN_CTX_PROXY: 'off' });
  assert.ok(off.length > 0);
  assert.ok(!off.some((a) => a.startsWith('ANTHROPIC_BASE_URL')));
});
