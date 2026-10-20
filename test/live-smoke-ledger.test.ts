import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const smokeModulePath = new URL('../scripts/live-smoke.mjs', import.meta.url)
  .href;

test('live smoke ledger stub implements the foreman submission contract', async () => {
  const { createLiveSmokeLedger } = (await import(smokeModulePath)) as {
    createLiveSmokeLedger(targetRepo?: string): {
      readContract(issue: string): Promise<{
        issueId: string;
        identifier: string;
        title: string;
        description: string;
        revision: string;
        targetRepo: string;
        checks: readonly string[];
      }>;
      submitForReview(): Promise<string>;
    };
  };
  const ledger = createLiveSmokeLedger('smoke-target');
  assert.equal(typeof ledger.submitForReview, 'function');
  assert.deepEqual(await ledger.readContract('smoke-issue'), {
    issueId: 'smoke-issue',
    identifier: 'smoke-issue',
    title: 'Live smoke contract for smoke-issue',
    description: '',
    revision: 'live-smoke-checkpoint-v1',
    targetRepo: 'smoke-target',
    checks: ['checkpoint-file'],
  });
  assert.equal(await ledger.submitForReview(), 'submitted');
});

test('live smoke requires a selected executable before creating a fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-live-smoke-preflight-'));
  const smokeRoot = join(root, 'repo');
  const pathRoot = join(root, 'path');
  const repositoryScratch = join(import.meta.dirname, '../.krn/tmp');
  const existingFixtures = (await readdir(repositoryScratch)).filter((name) =>
    name.startsWith('krn-codex-live-smoke-'),
  );
  await mkdir(smokeRoot);
  await mkdir(pathRoot);
  await writeFile(join(pathRoot, 'codex'), '#!/bin/sh\nexit 0\n', {
    mode: 0o644,
  });
  try {
    const { resolveLiveCodexExecutable } = (await import(smokeModulePath)) as {
      resolveLiveCodexExecutable(
        explicit?: string,
        pathValue?: string,
      ): Promise<string>;
    };
    const missing = spawnSync(
      process.execPath,
      [new URL('../scripts/live-smoke.mjs', import.meta.url).pathname],
      {
        cwd: smokeRoot,
        encoding: 'utf8',
        env: {
          KRN_LIVE: '1',
          PATH: pathRoot,
          KRN_LIVE_CODEX_EXECUTABLE: join(root, 'absent'),
        },
      },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /KRN_LIVE_CODEX_EXECUTABLE/u);
    assert.deepEqual(await readdir(smokeRoot), []);
    assert.deepEqual(
      (await readdir(repositoryScratch)).filter((name) =>
        name.startsWith('krn-codex-live-smoke-'),
      ),
      existingFixtures,
    );
    const notExecutable = spawnSync(
      process.execPath,
      [new URL('../scripts/live-smoke.mjs', import.meta.url).pathname],
      {
        cwd: smokeRoot,
        encoding: 'utf8',
        env: { KRN_LIVE: '1', PATH: pathRoot },
      },
    );
    assert.equal(notExecutable.status, 1);
    assert.match(
      notExecutable.stderr,
      /executable.*codex|codex.*executable/isu,
    );
    assert.deepEqual(await readdir(smokeRoot), []);
    assert.deepEqual(
      (await readdir(repositoryScratch)).filter((name) =>
        name.startsWith('krn-codex-live-smoke-'),
      ),
      existingFixtures,
    );
    await chmod(join(pathRoot, 'codex'), 0o755);
    assert.equal(
      await resolveLiveCodexExecutable(undefined, pathRoot),
      join(pathRoot, 'codex'),
    );
    await assert.rejects(
      resolveLiveCodexExecutable(join(root, 'absent'), pathRoot),
      /KRN_LIVE_CODEX_EXECUTABLE/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
