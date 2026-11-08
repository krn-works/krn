import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './state-trust-fixture.ts';

test('thread and turn roots contain only the real repository and its private tmp', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const requests = s.rows();
  assert.deepEqual(
    requests.find((r) => r.method === 'thread/start').params.config
      .sandbox_workspace_write.writable_roots,
    [s.repo, join(s.run, 'tmp')],
  );
  assert.deepEqual(
    requests.find((r) => r.method === 'turn/start').params.sandboxPolicy
      .writableRoots,
    [s.repo, join(s.run, 'tmp')],
  );
});
test('a host shell TMPDIR cannot move worker scratch files out of the run tmp', async (t) => {
  const s = setup(t);
  const host = join(s.root, 'host-tmp');
  mkdirSync(host);
  s.env.CODEX_TEST_HOST_TMPDIR = host;
  const result = await s.turn('tmpwrite scratch', true);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(s.run, 'tmp/scratch')), 'scratch not in run tmp');
  assert.ok(!existsSync(join(host, 'scratch')), 'scratch in host tmp');
  const config = s.rows().find((r) => r.method === 'thread/start')
    .params.config;
  for (const key of ['TMPDIR', 'TMP', 'TEMP'])
    assert.equal(
      config[`shell_environment_policy.set.${key}`],
      join(s.run, 'tmp'),
    );
});
