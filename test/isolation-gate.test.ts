import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  countIsolationSkips,
  decideIsolation,
  type IsolationCapabilities,
  isolationSummary,
  postGateStatusWhenClean,
  testSuiteExitCode,
} from '../scripts/isolation-gate.mjs';

const unavailable: IsolationCapabilities = {
  bwrap: { available: false, reason: 'user namespaces are unavailable' },
  systemdUserScope: {
    available: false,
    reason: 'the user manager is unavailable',
  },
};

test('missing isolation in CI produces named skips and a skip summary', () => {
  const decision = decideIsolation(
    'real verdict check',
    ['bwrap', 'systemdUserScope'],
    unavailable,
    true,
  );
  assert.deepEqual(decision, {
    kind: 'skip',
    line: 'SKIP(isolation): real verdict check — missing bwrap user namespaces, systemd user scopes',
  });
  assert.equal(isolationSummary(2), 'Isolation-dependent tests skipped: 2');
  assert.equal(
    countIsolationSkips(
      '# SKIP(isolation): real verdict check — missing bwrap user namespaces\n',
    ),
    1,
  );
  assert.equal(testSuiteExitCode(0, 2, false), 0);
});

test('missing isolation outside CI is a failure decision', () => {
  assert.deepEqual(
    decideIsolation(
      'real verdict check',
      ['systemdUserScope'],
      unavailable,
      false,
    ),
    {
      kind: 'fail',
      message:
        'Isolation requirements failed for real verdict check: missing systemd user scopes',
    },
  );
  assert.equal(testSuiteExitCode(0, 0, false), 0);
});

test('requiresIsolation logs a named CI skip and fails when CI is absent', async () => {
  const tempRoot = join(process.cwd(), 'test');
  const directory = await mkdtemp(join(tempRoot, 'isolation-helper-'));
  const fixture = join(directory, 'requires-isolation.test.mjs');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  await writeFile(
    fixture,
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('rootless fixture', (t) => { if (!requiresIsolation(t, 'rootless fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );

  const baseEnv = { ...process.env };
  delete baseEnv.CI;
  delete baseEnv.NODE_TEST_CONTEXT;
  const capabilities = JSON.stringify(unavailable);
  try {
    const ciRun = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', fixture],
      {
        encoding: 'utf8',
        env: {
          ...baseEnv,
          CI: 'true',
          KRN_ISOLATION_CAPABILITIES: capabilities,
        },
      },
    );
    assert.equal(
      ciRun.status,
      0,
      JSON.stringify({ error: ciRun.error?.message, stderr: ciRun.stderr }),
    );
    assert.notEqual(
      ciRun.stdout,
      '',
      JSON.stringify({
        status: ciRun.status,
        error: ciRun.error?.message,
        signal: ciRun.signal,
        stderr: ciRun.stderr,
      }),
    );
    assert.match(
      ciRun.stdout,
      /SKIP\(isolation\): rootless fixture — missing systemd user scopes/u,
    );
    assert.match(ciRun.stdout, /^# skipped 1$/mu);
    assert.equal(countIsolationSkips(ciRun.stdout), 1);

    const localRun = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', fixture],
      {
        encoding: 'utf8',
        env: { ...baseEnv, KRN_ISOLATION_CAPABILITIES: capabilities },
      },
    );
    assert.equal(localRun.status, 1, localRun.stdout);
    assert.match(
      localRun.stdout,
      /Isolation requirements failed for rootless fixture: missing systemd user scopes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gate-local refuses to post a status when any isolation test was skipped', async () => {
  let posted = false;
  const accepted = await postGateStatusWhenClean({
    exitCode: 0,
    skipCount: 1,
    post: () => {
      posted = true;
    },
  });
  assert.equal(accepted, false);
  assert.equal(posted, false);
  assert.equal(testSuiteExitCode(0, 1, true), 1);

  const failedGate = await postGateStatusWhenClean({
    exitCode: 1,
    skipCount: 0,
    post: () => {
      posted = true;
    },
  });
  assert.equal(failedGate, false);
  assert.equal(posted, false);
});
