import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureSetup } from '../../src/worker/setup-marker.ts';

function repo(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'krn-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('install runs once, leaves done and no running marker', (t) => {
  const dir = repo(t);
  let ready = false;
  let installs = 0;
  const run = () =>
    ensureSetup(
      dir,
      () => ready,
      () => {
        installs++;
        ready = true;
        return { ok: true, detail: '' };
      },
    );
  assert.equal(run(), true);
  assert.equal(run(), true);
  assert.equal(installs, 1);
  assert.equal(existsSync(join(dir, '.krn/setup/done')), true);
  assert.equal(existsSync(join(dir, '.krn/setup/running')), false);
});

test('failed install leaves failed marker with detail and no running marker', (t) => {
  const dir = repo(t);
  assert.equal(
    ensureSetup(
      dir,
      () => false,
      () => ({ ok: false, detail: 'boom' }),
    ),
    false,
  );
  assert.match(readFileSync(join(dir, '.krn/setup/failed'), 'utf8'), /boom/);
  assert.equal(existsSync(join(dir, '.krn/setup/running')), false);
});

test('a dead installer pid does not block; a live one is waited for', async (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, '.krn/setup'), { recursive: true });
  writeFileSync(join(dir, '.krn/setup/running'), '2147483646\n');
  let installs = 0;
  assert.equal(
    ensureSetup(
      dir,
      () => installs > 0,
      () => (installs++, { ok: true, detail: '' }),
    ),
    true,
  );
  assert.equal(installs, 1);

  const other = repo(t);
  mkdirSync(join(other, '.krn/setup'), { recursive: true });
  // A grandchild is reparented and reaped, so its pid really disappears while this process blocks.
  const holder = execFileSync(
    'sh',
    ['-c', 'sleep 0.7 >/dev/null 2>&1 & echo $!'],
    { encoding: 'utf8' },
  ).trim();
  writeFileSync(
    join(other, '.krn/setup/running'),
    `${holder}
`,
  );
  const started = Date.now();
  let ran = 0;
  const ok = ensureSetup(
    other,
    () => Date.now() - started > 600,
    () => (ran++, { ok: true, detail: '' }),
  );
  assert.equal(ok, true);
  assert.equal(ran, 0);
  assert.ok(Date.now() - started >= 600);
});
