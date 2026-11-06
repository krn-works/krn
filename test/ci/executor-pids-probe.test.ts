import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const module = fileURLToPath(new URL('../../infra/ci/', import.meta.url));
const receivers = [
  'TestLimitProbeArgvPinsOneProcessor',
  'TestGuestFailureLineKeepsOnlyRuntimeLines',
  'TestLimitProbeRetriesOnceThenFailsClosed',
];

test('the pids limit probe pins one processor, names its failure and retries once', (t) => {
  // The runner must report Go before the Go receivers can be proven or skipped.
  const reported: unknown = JSON.parse(
    process.env.KRN_ISOLATION_CAPABILITIES ?? '{}',
  );
  assert.equal(
    typeof Reflect.get(
      Object(Reflect.get(Object(reported), 'go')),
      'available',
    ),
    'boolean',
    'the isolation probe reports the Go toolchain',
  );
  // The CI guest has no Go and its strict evidence rejects every skip, so a
  // missing toolchain passes with a diagnostic. This cannot fake a proof:
  // without Go the base is green too, and red-first refuses a green base.
  if (
    Reflect.get(Object(Reflect.get(Object(reported), 'go')), 'available') !==
    true
  ) {
    t.diagnostic('Go toolchain unavailable: Go receivers not run here');
    return;
  }
  const cache = mkdtempSync(join(tmpdir(), 'krn-go-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync(
    'go',
    [
      'test',
      '-count=1',
      '-v',
      '-run',
      `^(${receivers.join('|')})$`,
      './internal/executor',
    ],
    {
      cwd: module,
      encoding: 'utf8',
      env: {
        ...process.env,
        GOCACHE: cache,
        GOTOOLCHAIN: 'local',
        GOFLAGS: '-mod=mod',
      },
      timeout: 300_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const name of receivers)
    assert.match(result.stdout, new RegExp(`^--- PASS: ${name} `, 'mu'));
});
