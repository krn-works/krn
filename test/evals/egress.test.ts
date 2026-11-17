import assert from 'node:assert/strict';
import test from 'node:test';
import { egressAllowed, vet } from '../../evals/units/egress.ts';

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
