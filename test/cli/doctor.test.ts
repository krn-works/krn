import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostReport } from '../../src/cli/doctor-host.ts';
import { lockHostRefusal } from '../../src/task/lock-host.ts';

const facts = {
  platform: 'linux',
  nodeVersion: '24.22.1',
  tmpPath: '/var/scratch',
  miseToml: '[tools]\nnode = "24.22.1"\n',
};

test('doctor host section lists lock, tmp path and node pin', () => {
  const report = hostReport(facts);
  assert.match(report.text, /^host=linux$/mu);
  assert.match(report.text, /^lock=abstract-unix-socket/mu);
  assert.match(report.text, /^tmp=\/var\/scratch /mu);
  assert.match(report.text, /^node-pin=24\.22\.1$/mu);
  assert.match(report.text, /^node-match=yes$/mu);
  assert.equal(report.exitCode, 0);
});

test('doctor flags a node that differs from the pin', () => {
  const report = hostReport({ ...facts, nodeVersion: '22.0.0' });
  assert.match(report.text, /^node-match=no$/mu);
});

test('a non-Linux host gets a named refusal and exit 64', () => {
  const report = hostReport({ ...facts, platform: 'darwin' });
  assert.match(
    report.text,
    /^lock=unsupported: claim locking requires Linux \(this host is darwin\)$/mu,
  );
  assert.equal(report.exitCode, 64);
  assert.equal(lockHostRefusal('linux'), null);
});

test('the real krn doctor prints the host section', () => {
  const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));
  const run = spawnSync(krn, ['doctor'], { encoding: 'utf8' });
  assert.match(run.stdout, /^lock=/mu);
  assert.match(run.stdout, /^node-pin=\d/mu);
});
