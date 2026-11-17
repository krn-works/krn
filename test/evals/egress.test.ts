import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  egressAllowed,
  hostListed,
  SESSION_HOSTS,
  startEgress,
  vet,
} from '../../evals/units/egress.ts';
import { sandboxArgv } from '../../evals/units/sandbox.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('the egress filter refuses loopback, private, link-local and host addresses in every form (t-qjf9g6c)', () => {
  const host = ['192.168.0.47', 'fd7a:115c:a1e0::1', '203.0.113.9'];
  for (const ip of [
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '0.0.0.0',
    '::',
    '10.0.0.5',
    '172.16.4.4',
    '192.168.1.1',
    '100.66.121.81',
    '169.254.169.254',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd7a:115c:a1e0::1',
    '224.0.0.1',
    '255.255.255.255',
    '64:ff9b::7f00:1',
    '203.0.113.9',
    'not-an-ip',
  ])
    assert.equal(egressAllowed(ip, host), false, ip);
  for (const ip of ['104.16.3.34', '142.250.120.141', '2606:4700::6810:322'])
    assert.equal(egressAllowed(ip, host), true, ip);
});

test('a name that resolves to loopback is refused before any connection', async () => {
  const v = await vet('localhost');
  assert.ok('refused' in v, JSON.stringify(v));
  assert.ok('refused' in (await vet('[::ffff:127.0.0.1]')));
});

test('startEgress under a parent too deep for a unix socket still serves on a short socket (t-txywvhe)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'egress-deep-'));
  const deep = join(root, 'x'.repeat(60), 'y'.repeat(60));
  mkdirSync(deep, { recursive: true });
  const egress = await startEgress(deep);
  try {
    assert.ok(Buffer.byteLength(egress.socket) <= 107, egress.socket);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { socketPath: egress.socket, method: 'GET', path: 'http://127.0.0.1/' },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(status !== undefined && status >= 400, String(status));
  } finally {
    await egress.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session in real bwrap is refused an unlisted host and connects to an allowlisted one', async (t) => {
  requiresIsolation(t, 'session egress allowlist', ['bwrap']);
  const egress = await startEgress(tmpdir(), SESSION_HOSTS);
  t.after(() => egress.close());
  // The sandbox asks the proxy for a CONNECT tunnel and prints the proxy's status line.
  const script = [
    "const { connect } = require('node:net');",
    'const host = process.argv[1];',
    "const s = connect(3128, '127.0.0.1', () => s.write('CONNECT ' + host + ':443 HTTP/1.1\\r\\nHost: ' + host + ':443\\r\\n\\r\\n'));",
    "s.once('data', (d) => { console.log(String(d).split('\\r\\n')[0]); s.destroy(); });",
    "s.on('error', (e) => { console.log('error ' + e.message); process.exit(1); });",
  ].join(' ');

  const status = async (host: string) =>
    await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(
        'bwrap',
        sandboxArgv(
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${host}`,
          {
            cwd: '/',
            writable: [],
            egress: egress.socket,
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
          },
        ),
      );
      let out = '';
      p.stdout.on('data', (d) => {
        out += d;
      });
      p.on('close', (code) => resolve({ code, out }));
    });
  const refused = await status('example.com');
  assert.equal(refused.code, 0, JSON.stringify(refused));
  assert.match(refused.out, / 403 /, refused.out);
  const allowed = await status('api.anthropic.com');
  assert.equal(allowed.code, 0, allowed.out);
  assert.match(allowed.out, / 200 /, allowed.out);
});

test('the session allowlist matches a listed name and its subdomains only', () => {
  assert.equal(hostListed('api.anthropic.com', SESSION_HOSTS), true);
  assert.equal(hostListed('API.GitHub.com.', SESSION_HOSTS), true);
  assert.equal(hostListed('github.com.evil.example', SESSION_HOSTS), false);
  assert.equal(hostListed('evilgithub.com', SESSION_HOSTS), false);
  assert.equal(hostListed('example.com', SESSION_HOSTS), false);
});
