import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sandboxArgv } from '../../evals/units/sandbox.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

// The real receiver: bubblewrap runs the argv sandboxArgv builds.
function inSandbox(cmd: string, base: string) {
  return spawnSync(
    'bwrap',
    sandboxArgv(cmd, {
      cwd: base,
      writable: [base],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }),
    { encoding: 'utf8', timeout: 30_000 },
  );
}

test('a session cannot read a host file outside the unit base', (t) => {
  requiresIsolation(t, 'grader isolation sandbox', ['bwrap']);
  // Planted beside the base, not under /tmp or HOME, which are masked anyway.
  const host = mkdtempSync(join(process.cwd(), '.krn-isolation-'));
  t.after(() => rmSync(host, { recursive: true, force: true }));
  const secret = join(host, 'reference-fix.txt');
  writeFileSync(secret, 'reference fix\n');
  const base = join(host, 'base');
  mkdirSync(base);
  writeFileSync(join(base, 'inside.txt'), 'visible\n');

  const own = inSandbox('cat inside.txt', base);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.stdout, 'visible\n');

  const other = inSandbox(`cat '${secret}'`, base);
  assert.notEqual(other.status, 0);
  assert.doesNotMatch(other.stdout, /reference fix/);

  const checkout = inSandbox(
    `cat '${join(process.cwd(), 'package.json')}'`,
    base,
  );
  assert.notEqual(checkout.status, 0);
  assert.doesNotMatch(checkout.stdout, /"name"/);
});

test('the toolchain still runs inside the sandbox', (t) => {
  requiresIsolation(t, 'grader isolation sandbox', ['bwrap']);
  const base = mkdtempSync(join(tmpdir(), 'isolation-base-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const r = inSandbox(`'${process.execPath}' -e "console.log(1+1)"`, base);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2\n');
});
