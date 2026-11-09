import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = process.cwd();
const suitePath = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);

test('K=1,2,4 keep config writes isolated and resolve MISE_DATA_DIR from parent settings', async () => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const parentHome = process.env.HOME || homedir();
  const scenarios = [
    {
      name: 'explicit-mise-data-dir',
      miseDataDir: join(stateRoot, 'parent-mise-data'),
      xdgDataHome: join(stateRoot, 'parent-xdg-data'),
    },
    { name: 'home-default', miseDataDir: undefined, xdgDataHome: undefined },
    {
      name: 'xdg-data-home-default',
      miseDataDir: undefined,
      xdgDataHome: join(stateRoot, 'parent-xdg-data'),
    },
  ];

  for (const scenario of scenarios) {
    for (const shardCount of [1, 2, 4]) {
      const directory = await mkdtemp(
        join(stateRoot, `test-shard-mise-${scenario.name}-${shardCount}-`),
      );
      const files = Array.from({ length: shardCount }, (_, index) =>
        join(directory, `shard-${index}.test.mjs`),
      );
      const markers = files.map((file) => `${file}.env.json`);
      const barrierDirectory = join(directory, 'ready');
      await mkdir(barrierDirectory);
      const expectedMiseDataDir =
        scenario.miseDataDir ??
        resolve(
          scenario.xdgDataHome ?? join(parentHome, '.local', 'share'),
          'mise',
        );

      try {
        for (const [index, file] of files.entries()) {
          const fixture = [
            "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "import { test } from 'node:test';",
            `const shardIndex = ${index};`,
            `const shardCount = ${shardCount};`,
            `const marker = ${JSON.stringify(markers[index])};`,
            `const barrierDirectory = ${JSON.stringify(barrierDirectory)};`,
            'test("worker HOME config writes do not collide", async () => {',
            '  const configDirectory = join(process.env.HOME, ".config");',
            '  const configFile = join(configDirectory, "shared-write");',
            '  mkdirSync(configDirectory, { recursive: true });',
            '  writeFileSync(configFile, String(shardIndex));',
            '  writeFileSync(join(barrierDirectory, String(shardIndex) + ".ready"), "ready");',
            '  const readyFiles = Array.from({ length: shardCount }, (_, index) => join(barrierDirectory, String(index) + ".ready"));',
            '  const deadline = Date.now() + 10000;',
            '  while (Date.now() < deadline && !readyFiles.every(existsSync)) await new Promise((resolve) => setTimeout(resolve, 10));',
            '  if (!readyFiles.every(existsSync)) throw new Error("timed out waiting for all shard writes");',
            '  if (readFileSync(configFile, "utf8") !== String(shardIndex)) throw new Error("concurrent shard HOME/.config writes collided");',
            '  writeFileSync(marker, JSON.stringify({',
            '    home: process.env.HOME,',
            '    path: process.env.PATH,',
            '    xdgCacheHome: process.env.XDG_CACHE_HOME,',
            '    xdgConfigHome: process.env.XDG_CONFIG_HOME,',
            '    xdgDataHome: process.env.XDG_DATA_HOME,',
            '    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ?? null,',
            '    xdgStateHome: process.env.XDG_STATE_HOME,',
            '    miseDataDir: process.env.MISE_DATA_DIR,',
            '    miseConfigDir: process.env.MISE_CONFIG_DIR ?? null,',
            '    miseCacheDir: process.env.MISE_CACHE_DIR ?? null,',
            '    miseStateDir: process.env.MISE_STATE_DIR ?? null,',
            '    parentHomeLeakSentinel: process.env.PARENT_HOME_LEAK_SENTINEL ?? null,',
            '    configFile,',
            '    configValue: readFileSync(configFile, "utf8"),',
            '  }));',
            '});',
            '',
          ].join('\n');
          await writeFile(file, fixture);
        }

        const env = {
          ...process.env,
          KRN_TEST_STRICT: '1',
          PARENT_HOME_LEAK_SENTINEL: join(parentHome, '.parent-only'),
          KRN_TEST_SHARDS: String(shardCount),
        };
        if (scenario.miseDataDir === undefined) delete env.MISE_DATA_DIR;
        else env.MISE_DATA_DIR = scenario.miseDataDir;
        if (scenario.xdgDataHome === undefined) delete env.XDG_DATA_HOME;
        else env.XDG_DATA_HOME = scenario.xdgDataHome;

        const result = spawnSync(process.execPath, [suitePath, ...files], {
          cwd: projectRoot,
          encoding: 'utf8',
          env,
          timeout: 30_000,
        });
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const summaryLine = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith('KRN_TEST_SUMMARY_JSON='));
        assert.ok(summaryLine, `${result.stdout}\n${result.stderr}`);
        const summary = JSON.parse(
          summaryLine.slice('KRN_TEST_SUMMARY_JSON='.length),
        );
        assert.equal(summary.counts.tests, shardCount);
        assert.equal(summary.files.length, shardCount);

        const environments = await Promise.all(
          markers.map(async (marker) =>
            JSON.parse(await readFile(marker, 'utf8')),
          ),
        );
        assert.equal(
          new Set(environments.map(({ home }) => home)).size,
          shardCount,
        );
        for (const [index, environment] of environments.entries()) {
          assert.ok(
            environment.home.startsWith(join(stateRoot, 'test-suite-run-')),
          );
          assert.notEqual(environment.home, parentHome);
          assert.equal(environment.path, process.env.PATH);
          assert.equal(
            environment.xdgCacheHome,
            join(environment.home, '.cache'),
          );
          assert.equal(
            environment.xdgConfigHome,
            join(environment.home, '.config'),
          );
          assert.equal(
            environment.xdgDataHome,
            join(environment.home, '.local', 'share'),
          );
          assert.equal(
            environment.xdgStateHome,
            join(environment.home, '.local', 'state'),
          );
          assert.equal(
            environment.xdgRuntimeDir,
            process.env.XDG_RUNTIME_DIR ?? null,
          );
          assert.equal(environment.miseDataDir, expectedMiseDataDir);
          assert.equal(
            environment.miseConfigDir,
            process.env.MISE_CONFIG_DIR ?? null,
          );
          assert.equal(
            environment.miseCacheDir,
            process.env.MISE_CACHE_DIR ?? null,
          );
          assert.equal(
            environment.miseStateDir,
            process.env.MISE_STATE_DIR ?? null,
          );
          assert.equal(environment.parentHomeLeakSentinel, null);
          assert.equal(
            environment.configFile,
            join(environment.home, '.config', 'shared-write'),
          );
          assert.equal(environment.configValue, String(index));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
