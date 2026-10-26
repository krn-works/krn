import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const smokeModulePath = new URL('../scripts/live-smoke.mjs', import.meta.url)
  .href;

test('live smoke ledger stub implements the foreman local contract', async () => {
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
    };
  };
  const ledger = createLiveSmokeLedger('smoke-target');
  assert.deepEqual(await ledger.readContract('smoke-issue'), {
    issueId: 'smoke-issue',
    identifier: 'smoke-issue',
    title: 'Live smoke contract for smoke-issue',
    description: '',
    revision: 'live-smoke-checkpoint-v1',
    targetRepo: 'smoke-target',
    checks: ['checkpoint-file'],
  });
});

test('live smoke requires a selected executable before creating a fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-live-smoke-preflight-'));
  const pathRoot = join(root, 'path');
  const sourceTree = resolve(import.meta.dirname, '../src');
  const sourceSmokeScript = new URL(
    '../scripts/live-smoke.mjs',
    import.meta.url,
  );
  const gitMarker = join(root, 'git-invoked');
  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(gitPath.status, 0, 'the focused test requires the host git');
  await mkdir(pathRoot);
  await writeFile(join(pathRoot, 'codex'), '#!/bin/sh\nexit 0\n', {
    mode: 0o644,
  });
  await writeFile(join(pathRoot, 'not-executable'), '#!/bin/sh\nexit 0\n', {
    mode: 0o644,
  });
  await writeFile(
    join(pathRoot, 'git'),
    `#!/bin/sh\n: > ${JSON.stringify(gitMarker)}\nexec ${JSON.stringify(gitPath.stdout.trim())} "$@"\n`,
    { mode: 0o755 },
  );
  const testPath = `${pathRoot}${delimiter}${process.env.PATH ?? ''}`;

  async function installSmokeRepo(name: string): Promise<string> {
    const repository = join(root, name);
    const scripts = join(repository, 'scripts');
    await mkdir(scripts, { recursive: true });
    await symlink(sourceTree, join(repository, 'src'), 'dir');
    await copyFile(sourceSmokeScript, join(scripts, 'live-smoke.mjs'));
    return repository;
  }

  function runSmoke(repository: string, executable: string) {
    return spawnSync(
      process.execPath,
      [join(repository, 'scripts', 'live-smoke.mjs')],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          KRN_LIVE: '1',
          PATH: testPath,
          KRN_LIVE_CODEX_EXECUTABLE: executable,
        },
      },
    );
  }

  try {
    const { resolveLiveCodexExecutable } = (await import(smokeModulePath)) as {
      resolveLiveCodexExecutable(
        explicit?: string,
        pathValue?: string,
      ): Promise<string>;
    };
    const foreignSmokeRoot = await installSmokeRepo('foreign-repo');
    const foreignScratch = join(foreignSmokeRoot, '.krn', 'tmp');
    const foreignFixture = 'krn-codex-live-smoke-foreign';
    await mkdir(join(foreignScratch, foreignFixture), { recursive: true });

    const missing = runSmoke(foreignSmokeRoot, join(root, 'absent'));
    assert.equal(missing.status, 1);
    assert.equal(
      (await readdir(root)).includes('git-invoked'),
      false,
      'executable validation must happen before fixture Git commands',
    );
    assert.match(missing.stderr, /KRN_LIVE_CODEX_EXECUTABLE/u);
    assert.deepEqual(
      (await readdir(foreignScratch)).filter((name) =>
        name.startsWith('krn-codex-live-smoke-'),
      ),
      [foreignFixture],
      'preflight must not depend on a foreign smoke fixture in its own scratch root',
    );

    const notExecutable = runSmoke(
      foreignSmokeRoot,
      join(pathRoot, 'not-executable'),
    );
    assert.equal(notExecutable.status, 1);
    assert.equal(
      (await readdir(root)).includes('git-invoked'),
      false,
      'non-executable override must be rejected before fixture Git commands',
    );
    assert.match(
      notExecutable.stderr,
      /executable.*codex|codex.*executable/isu,
    );
    assert.deepEqual(
      (await readdir(foreignScratch)).filter((name) =>
        name.startsWith('krn-codex-live-smoke-'),
      ),
      [foreignFixture],
      'non-executable preflight must leave the owned scratch root untouched',
    );

    const blockedSmokeRoot = await installSmokeRepo('blocked-repo');
    const blockedScratch = join(blockedSmokeRoot, '.krn', 'tmp');
    await mkdir(join(blockedSmokeRoot, '.krn'), { recursive: true });
    await writeFile(blockedScratch, 'scratch root intentionally unavailable');
    const blocked = runSmoke(blockedSmokeRoot, join(root, 'absent'));
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /KRN_LIVE_CODEX_EXECUTABLE/u);
    assert.equal(
      await readFile(blockedScratch, 'utf8'),
      'scratch root intentionally unavailable',
      'executable preflight must not depend on creating or listing scratch entries',
    );

    await assert.rejects(
      resolveLiveCodexExecutable(undefined, pathRoot),
      /executable.*codex|codex.*executable/isu,
    );
    await chmod(join(pathRoot, 'codex'), 0o755);
    assert.equal(
      await resolveLiveCodexExecutable('codex', pathRoot),
      join(pathRoot, 'codex'),
    );
    assert.equal(
      await resolveLiveCodexExecutable(
        relative(process.cwd(), join(pathRoot, 'codex')),
        pathRoot,
      ),
      join(pathRoot, 'codex'),
    );
    await assert.rejects(
      resolveLiveCodexExecutable('missing-codex', pathRoot),
      /KRN_LIVE_CODEX_EXECUTABLE=missing-codex/u,
    );
    await assert.rejects(
      resolveLiveCodexExecutable(join(root, 'absent'), pathRoot),
      /KRN_LIVE_CODEX_EXECUTABLE/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
