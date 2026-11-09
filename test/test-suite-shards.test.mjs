import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../scripts/lib/shard-weights.mjs';
import * as testShards from '../scripts/lib/test-shards.mjs';
import {
  configuredTestShardCount,
  defaultTestShardCount,
  mergeTestShardResults,
  planTestShards,
  RUNNER_LOCAL_LANES,
  SERIAL_TEST_FILES,
  SERIAL_TEST_REASONS,
  testFileFamily,
} from '../scripts/lib/test-shards.mjs';
import { TEST_FILE_GLOB } from '../scripts/test-suite.mjs';
import { summarizeTestEvents } from '../scripts/test-summary-policy.mjs';

const newShardExports = {
  configuredTestShardSelection: testShards.configuredTestShardSelection,
  selectTestShardFiles: testShards.selectTestShardFiles,
};
function shardExport(name) {
  const value = newShardExports[name];
  assert.equal(typeof value, 'function', `${name} is exported`);
  return value;
}

const projectRoot = process.cwd();
const suitePath = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);
function fileEvents(file, count = 1) {
  const counts = {
    tests: count,
    passed: count,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  };
  return [
    ...Array.from({ length: count }, (_, index) => ({
      type: 'test:pass',
      data: {
        entryFile: file,
        testNumber: index + 1,
        details: { type: 'test' },
      },
    })),
    { type: 'test:summary', data: { entryFile: file, success: true, counts } },
  ];
}

function globalSummary(count) {
  return {
    type: 'test:summary',
    data: {
      success: true,
      counts: {
        tests: count,
        passed: count,
        failed: 0,
        skipped: 0,
        todo: 0,
        cancelled: 0,
      },
    },
  };
}

test('the shard plan covers every selected test file exactly once', () => {
  const files = globSync(TEST_FILE_GLOB, { cwd: projectRoot }).sort();
  const plan = planTestShards(files, 3);
  const planned = [...plan.shards.flat(), ...plan.serialFiles];

  assert.deepEqual([...planned].sort(), files);
  assert.equal(new Set(planned).size, files.length);
  assert.deepEqual(plan.serialFiles, SERIAL_TEST_FILES);
  assert.ok(SERIAL_TEST_FILES.every((file) => SERIAL_TEST_REASONS[file]));
});

test('shard selection puts every test file in exactly one of the runner shards', () => {
  const selectTestShardFiles = shardExport('selectTestShardFiles');
  const configuredTestShardSelection = shardExport(
    'configuredTestShardSelection',
  );
  const files = globSync(TEST_FILE_GLOB, { cwd: projectRoot }).sort();
  for (const total of [1, 2, 6, 7]) {
    const selections = Array.from({ length: total }, (_, index) =>
      selectTestShardFiles(files, index + 1, total),
    );
    const flat = selections.flat();
    assert.deepEqual([...flat].sort(), files, `total ${total}`);
    assert.equal(new Set(flat).size, files.length);
    assert.deepEqual(
      selections,
      Array.from({ length: total }, (_, index) =>
        selectTestShardFiles(files, index + 1, total),
      ),
    );
  }
  // A serial file runs alone after the runner's local lanes, so its runner
  // takes RUNNER_LOCAL_LANES times its weight off the parallel balance.
  const weightOf = (list) =>
    list.reduce((sum, file) => sum + (TEST_FILE_WEIGHTS[file] ?? 1), 0);
  for (const total of [2, 6, 8]) {
    const selections = Array.from({ length: total }, (_, index) =>
      selectTestShardFiles(files, index + 1, total),
    );
    const walls = selections.map((selection) => {
      const serial = selection.filter((file) =>
        SERIAL_TEST_FILES.includes(file),
      );
      const parallel = selection.filter(
        (file) => !SERIAL_TEST_FILES.includes(file),
      );
      return weightOf(parallel) / RUNNER_LOCAL_LANES + weightOf(serial);
    });
    const heaviestFile = Math.max(
      ...files.map((file) => TEST_FILE_WEIGHTS[file] ?? 1),
    );
    assert.ok(
      Math.max(...walls) - Math.min(...walls) <= heaviestFile,
      `total ${total}: runner walls ${walls.map((w) => w.toFixed(1)).join(' ')} must stay within one file`,
    );
    const carrier = selections.findIndex((selection) =>
      selection.some((file) => SERIAL_TEST_FILES.includes(file)),
    );
    const parallelLoads = selections.map((selection) =>
      weightOf(selection.filter((file) => !SERIAL_TEST_FILES.includes(file))),
    );
    assert.equal(
      parallelLoads[carrier],
      Math.min(...parallelLoads),
      `total ${total}: the serial runner must carry the least parallel work`,
    );
  }
  assert.throws(() => selectTestShardFiles(files, 0, 3), /between 1/u);
  assert.throws(() => selectTestShardFiles(files, 4, 3), /between 1/u);
  assert.deepEqual(
    configuredTestShardSelection(undefined, undefined),
    undefined,
  );
  assert.deepEqual(configuredTestShardSelection('2', '6'), {
    index: 2,
    total: 6,
  });
  assert.throws(() => configuredTestShardSelection('2', undefined), /both/u);
  assert.throws(() => configuredTestShardSelection('7', '6'), /exceed/u);
  assert.throws(() => configuredTestShardSelection('0', '6'), /both/u);
});

// In main runs since e79cb01 one runner held input-bounds-baseline and
// input-bounds-persisted and ran them at 17.4 and 12.2 s, against 8.7 and
// 9.3 s on separate runners, and was the slowest Test step in every run.
test('shard selection spreads each test family evenly across the runners', () => {
  const selectTestShardFiles = shardExport('selectTestShardFiles');
  assert.equal(
    testFileFamily('test/worker/input-bounds-baseline.test.ts'),
    testFileFamily('test/worker/input-bounds-persisted.test.ts'),
  );
  assert.equal(
    testFileFamily('test/evals/workspace.test.ts'),
    testFileFamily('test/evals/workspace-mask.test.ts'),
  );
  assert.notEqual(
    testFileFamily('test/evals/session.test.ts'),
    testFileFamily('test/worker/session.test.ts'),
  );
  const files = globSync(TEST_FILE_GLOB, { cwd: projectRoot }).sort();
  const parallel = files.filter((file) => !SERIAL_TEST_FILES.includes(file));
  const familySize = new Map();
  for (const file of parallel) {
    const family = testFileFamily(file);
    familySize.set(family, (familySize.get(family) ?? 0) + 1);
  }
  assert.ok(
    [...familySize.values()].some((size) => size > 1),
    'the suite has split families to spread',
  );
  for (const total of [2, 6, 8, 10]) {
    for (let index = 1; index <= total; index += 1) {
      const kin = new Map();
      for (const file of selectTestShardFiles(files, index, total)) {
        if (SERIAL_TEST_FILES.includes(file)) continue;
        const family = testFileFamily(file);
        kin.set(family, (kin.get(family) ?? 0) + 1);
      }
      for (const [family, count] of kin)
        assert.ok(
          count <= Math.ceil((familySize.get(family) ?? 0) / total),
          `total ${total}: runner ${index} holds ${count} of the ${familySize.get(family)} ${family} files`,
        );
    }
  }
});

test('the default shard count uses one shard per core up to four and supports an override', () => {
  assert.equal(defaultTestShardCount(16), 4);
  assert.equal(defaultTestShardCount(4), 4);
  assert.equal(defaultTestShardCount(3), 3);
  assert.equal(defaultTestShardCount(1), 1);
  assert.equal(configuredTestShardCount('2', 16), 2);
  assert.throws(() => configuredTestShardCount('0', 16), /positive integer/u);
});

test('merged shard evidence matches the serial file set and test count', () => {
  const files = ['/repo/test/a.test.mjs', '/repo/test/b.test.mjs'];
  const events = [
    ...fileEvents(files[0], 2),
    ...fileEvents(files[1], 1),
    globalSummary(3),
  ];
  const serial = summarizeTestEvents(events, files, 0);
  const merged = mergeTestShardResults(
    [
      {
        events: [...fileEvents(files[0], 2), globalSummary(2)],
        runnerExitCode: 0,
      },
      {
        events: [...fileEvents(files[1]), globalSummary(1)],
        runnerExitCode: 0,
      },
    ],
    files,
    { expectedTestCount: 3 },
  );

  assert.equal(serial.ok, true, serial.errors.join('; '));
  assert.equal(merged.ok, true, merged.errors.join('; '));
  assert.deepEqual(merged.summary, serial.summary);
});

test('serial and sharded commands isolate worker paths and inherit only host runtime bus endpoints', async () => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-shard-equivalence-'));
  const files = ['a.test.mjs', 'b.test.mjs'].map((name) =>
    join(directory, name),
  );
  const markers = files.map((file) => `${file}.env.json`);
  const expectedPnpmStoreDirectory = join(directory, 'parent-pnpm-store');
  const expectedRuntimeBusEnvironment = {
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ??
      `unix:path=${join(directory, 'parent-bus')}`,
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR ?? join(directory, 'parent-runtime'),
  };

  try {
    for (const [index, file] of files.entries()) {
      await writeFile(
        file,
        [
          "import assert from 'node:assert/strict';",
          "import { spawnSync } from 'node:child_process';",
          "import { mkdtempSync, writeFileSync } from 'node:fs';",
          "import { tmpdir } from 'node:os';",
          "import { join } from 'node:path';",
          "import { test } from 'node:test';",
          'const tmpdirAtImport = tmpdir();',
          `test("declared ${index + 1}", () => {`,
          '  const tmpdirAtRuntime = tmpdir();',
          "  const fixtureDirectory = mkdtempSync(join(tmpdirAtRuntime, 'resolved-fixture-'));",
          '  const fakeCli = join(fixtureDirectory, "fake-cli");',
          '  writeFileSync(fakeCli, \'process.stdout.write(require("node:os").tmpdir())\');',
          '  const fakeCliResult = spawnSync(process.execPath, [fakeCli], { encoding: "utf8" });',
          '  assert.equal(fakeCliResult.status, 0, fakeCliResult.stderr);',
          '  assert.equal(fakeCliResult.stdout, tmpdirAtRuntime);',
          '  writeFileSync(' +
            JSON.stringify(markers[index]) +
            ', JSON.stringify({',
          '    home: process.env.HOME,',
          '    path: process.env.PATH,',
          '    xdgCacheHome: process.env.XDG_CACHE_HOME,',
          '    xdgConfigHome: process.env.XDG_CONFIG_HOME,',
          '    xdgDataHome: process.env.XDG_DATA_HOME,',
          '    xdgStateHome: process.env.XDG_STATE_HOME,',
          '    miseDataDir: process.env.MISE_DATA_DIR,',
          '    miseConfigDir: process.env.MISE_CONFIG_DIR ?? null,',
          '    miseCacheDir: process.env.MISE_CACHE_DIR ?? null,',
          '    miseStateDir: process.env.MISE_STATE_DIR ?? null,',
          '    pnpmConfigStoreDir: process.env.pnpm_config_store_dir ?? null,',
          '    runtimeBusEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:XDG_RUNTIME_DIR|DBUS_|SYSTEMD_)/u.test(key))),',
          '    tmpdir: process.env.TMPDIR,',
          '    tmpdirAtImport,',
          '    tmpdirAtRuntime,',
          '    eventFile: process.env.KRN_TEST_EVENT_FILE,',
          '    fixtureDirectory,',
          '  }));',
          '});',
          ...(index === 0 ? ["test('another declared test', () => {});"] : []),
          '',
        ].join('\n'),
      );
    }
    const run = (shards) =>
      spawnSync(process.execPath, [suitePath, ...files], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_TEST_STRICT: '1',
          KRN_TEST_SHARDS: String(shards),
          pnpm_config_store_dir: expectedPnpmStoreDirectory,
          ...expectedRuntimeBusEnvironment,
          DBUS_STARTER_ADDRESS: 'must-not-reach-shards',
          DBUS_STARTER_BUS_TYPE: 'must-not-reach-shards',
          SYSTEMD_EXEC_PID: 'must-not-reach-shards',
        },
        timeout: 30_000,
      });
    const summaryFrom = (result) => {
      const line = result.stdout
        .split(/\r?\n/u)
        .find((entry) => entry.startsWith('KRN_TEST_SUMMARY_JSON='));
      assert.ok(line, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(line.slice('KRN_TEST_SUMMARY_JSON='.length));
    };

    const serialResult = run(1);
    assert.equal(serialResult.error, undefined, serialResult.stderr);
    assert.equal(
      serialResult.status,
      0,
      `${serialResult.stdout}\n${serialResult.stderr}`,
    );
    const serialSummary = summaryFrom(serialResult);

    const shardedResult = run(2);
    assert.equal(shardedResult.error, undefined, shardedResult.stderr);
    assert.equal(
      shardedResult.status,
      0,
      `${shardedResult.stdout}\n${shardedResult.stderr}`,
    );
    const shardedSummary = summaryFrom(shardedResult);

    // Wall time differs run to run; every file must still report one.
    const counted = (files) =>
      files.map(({ durationMs, ...counts }) => {
        assert.ok(Number.isSafeInteger(durationMs), counts.file);
        return counts;
      });
    assert.deepEqual(
      counted(shardedSummary.files),
      counted(serialSummary.files),
    );
    assert.equal(shardedSummary.counts.tests, serialSummary.counts.tests);
    assert.equal(shardedSummary.counts.tests, 3);
    const environments = await Promise.all(
      markers.map(async (marker) => JSON.parse(await readFile(marker, 'utf8'))),
    );
    assert.equal(new Set(environments.map(({ home }) => home)).size, 2);
    assert.equal(new Set(environments.map(({ tmpdir }) => tmpdir)).size, 2);
    assert.equal(
      new Set(environments.map(({ eventFile }) => eventFile)).size,
      2,
    );
    assert.equal(
      new Set(environments.map(({ fixtureDirectory }) => fixtureDirectory))
        .size,
      2,
    );
    const parentHome = process.env.HOME || homedir();
    const parentDataHome =
      process.env.XDG_DATA_HOME || join(parentHome, '.local', 'share');
    const expectedMiseDataDir =
      process.env.MISE_DATA_DIR || resolve(parentDataHome, 'mise');
    for (const {
      home,
      path,
      xdgCacheHome,
      xdgConfigHome,
      xdgDataHome,
      xdgStateHome,
      miseDataDir,
      miseConfigDir,
      miseCacheDir,
      miseStateDir,
      pnpmConfigStoreDir,
      runtimeBusEnvironment,
      tmpdir,
      tmpdirAtImport,
      tmpdirAtRuntime,
      eventFile,
      fixtureDirectory,
    } of environments) {
      assert.ok(home.startsWith(join(stateRoot, 'test-suite-run-')));
      assert.notEqual(home, parentHome);
      assert.equal(path, process.env.PATH);
      assert.equal(xdgCacheHome, join(home, '.cache'));
      assert.equal(xdgConfigHome, join(home, '.config'));
      assert.equal(xdgDataHome, join(home, '.local', 'share'));
      assert.equal(xdgStateHome, join(home, '.local', 'state'));
      assert.equal(miseDataDir, expectedMiseDataDir);
      assert.equal(miseConfigDir, process.env.MISE_CONFIG_DIR ?? null);
      assert.equal(miseCacheDir, process.env.MISE_CACHE_DIR ?? null);
      assert.equal(miseStateDir, process.env.MISE_STATE_DIR ?? null);
      assert.equal(pnpmConfigStoreDir, expectedPnpmStoreDirectory);
      assert.deepEqual(runtimeBusEnvironment, expectedRuntimeBusEnvironment);
      assert.ok(tmpdir.startsWith(join(stateRoot, 'test-suite-run-')));
      assert.equal(tmpdirAtImport, tmpdir);
      assert.equal(tmpdirAtRuntime, tmpdir);
      assert.ok(fixtureDirectory.startsWith(join(tmpdir, 'resolved-fixture-')));
      assert.ok(eventFile.startsWith(join(stateRoot, 'strict-test-events-')));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the parent resolves the pnpm store once and supplies it to every shard', async () => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-shard-pnpm-store-'));
  const bin = join(directory, 'bin');
  const files = ['a.test.mjs', 'b.test.mjs'].map((name) =>
    join(directory, name),
  );
  const markers = files.map((file) => `${file}.env.json`);
  const mise = join(bin, 'mise');
  const pnpm = join(bin, 'pnpm');
  const miseInvocationFile = join(directory, 'mise-invocations.txt');
  const invocationFile = join(directory, 'pnpm-invocations.txt');
  const expectedStoreDirectory = join(directory, 'parent-store', 'v12');
  const expectedManager = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
  ).packageManager;
  const parentHome = process.env.HOME || homedir();

  try {
    await mkdir(bin);
    await writeFile(
      mise,
      [
        '#!/bin/sh',
        'if [ "$1" != "where" ] || [ "$2" != "$R5_EXPECTED_MANAGER" ]; then exit 2; fi',
        'printf \'%s %s\\n\' "$1" "$2" >> "$R5_MISE_CALLS"',
        'printf \'%s\\n\' "$R5_PNPM_DIRECTORY"',
        '',
      ].join('\n'),
    );
    await chmod(mise, 0o755);
    await writeFile(
      pnpm,
      [
        '#!/bin/sh',
        'if [ "$1" != "store" ] || [ "$2" != "path" ]; then exit 2; fi',
        'printf \'%s|%s\\n\' "$*" "$PWD" >> "$R5_PNPM_CALLS"',
        'printf \'%s\\n\' "$R5_PNPM_STORE"',
        '',
      ].join('\n'),
    );
    await chmod(pnpm, 0o755);
    for (const [index, file] of files.entries()) {
      await writeFile(
        file,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { test } from 'node:test';",
          `const marker = ${JSON.stringify(markers[index])};`,
          'test("captures the parent store path", () => {',
          '  writeFileSync(marker, JSON.stringify({',
          '    home: process.env.HOME,',
          '    storeDirectory: process.env.pnpm_config_store_dir ?? null,',
          '  }));',
          '});',
          '',
        ].join('\n'),
      );
    }

    const env = {
      ...process.env,
      KRN_TEST_STRICT: '1',
      KRN_TEST_SHARDS: '2',
      PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(
        delimiter,
      ),
      R5_EXPECTED_MANAGER: expectedManager,
      R5_MISE_CALLS: miseInvocationFile,
      R5_PNPM_CALLS: invocationFile,
      R5_PNPM_DIRECTORY: bin,
      R5_PNPM_STORE: expectedStoreDirectory,
    };
    delete env.pnpm_config_store_dir;
    const result = spawnSync(process.execPath, [suitePath, ...files], {
      cwd: projectRoot,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });

    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(
      (await readFile(miseInvocationFile, 'utf8')).trim().split(/\r?\n/u),
      [`where ${expectedManager}`],
    );
    assert.deepEqual(
      (await readFile(invocationFile, 'utf8')).trim().split(/\r?\n/u),
      [`store path|${projectRoot}`],
    );
    const environments = await Promise.all(
      markers.map(async (marker) => JSON.parse(await readFile(marker, 'utf8'))),
    );
    assert.equal(new Set(environments.map(({ home }) => home)).size, 2);
    assert.ok(environments.every(({ home }) => home !== parentHome));
    assert.ok(
      environments.every(
        ({ storeDirectory }) => storeDirectory === expectedStoreDirectory,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed parent store lookup warns once and leaves the shard store unset', async () => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-shard-pnpm-missing-'));
  const bin = join(directory, 'bin');
  const mise = join(bin, 'mise');
  const files = ['a.test.mjs', 'b.test.mjs'].map((name) =>
    join(directory, name),
  );
  const markers = files.map((file) => `${file}.env.json`);
  const parentHome = join(directory, 'parent-home');
  const parentDataHome = join(directory, 'parent-data');
  const guessedStoreDirectory = join(parentDataHome, 'pnpm', 'store', 'v11');

  try {
    await mkdir(bin);
    await mkdir(guessedStoreDirectory, { recursive: true });
    await writeFile(
      mise,
      '#!/bin/sh\nprintf "mise unavailable\\n" >&2\nexit 1\n',
    );
    await chmod(mise, 0o755);
    for (const [index, file] of files.entries()) {
      await writeFile(
        file,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { test } from 'node:test';",
          `const marker = ${JSON.stringify(markers[index])};`,
          'test("captures the missing parent store path", () => {',
          '  writeFileSync(marker, JSON.stringify({',
          '    home: process.env.HOME,',
          '    storeDirectory: process.env.pnpm_config_store_dir ?? null,',
          '  }));',
          '});',
          '',
        ].join('\n'),
      );
    }

    const env = {
      ...process.env,
      HOME: parentHome,
      XDG_DATA_HOME: parentDataHome,
      KRN_TEST_STRICT: '1',
      KRN_TEST_SHARDS: '2',
      PATH: [bin, dirname(process.execPath)].join(delimiter),
    };
    delete env.pnpm_config_store_dir;
    const result = spawnSync(process.execPath, [suitePath, ...files], {
      cwd: projectRoot,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });

    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      (
        result.stderr.match(
          /Warning: unable to resolve the parent pnpm store/gu,
        ) ?? []
      ).length,
      1,
      result.stderr,
    );
    const environments = await Promise.all(
      markers.map(async (marker) => JSON.parse(await readFile(marker, 'utf8'))),
    );
    assert.equal(new Set(environments.map(({ home }) => home)).size, 2);
    assert.ok(environments.every(({ home }) => home !== parentHome));
    assert.ok(
      environments.every(({ storeDirectory }) => storeDirectory === null),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failure in each planned shard fails the strict suite command', async (t) => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-shard-observer-'));
  const files = Array.from({ length: 3 }, (_, index) =>
    join(directory, `shard-${index}.test.mjs`),
  );
  const plan = planTestShards(files, 3, []);

  try {
    for (let shardIndex = 0; shardIndex < plan.shards.length; shardIndex += 1) {
      await t.test(`shard ${shardIndex + 1}`, async () => {
        const failingFile = plan.shards[shardIndex][0];
        for (const file of files) {
          await writeFile(
            file,
            file === failingFile
              ? "import { test } from 'node:test';\ntest('planted failure', () => { throw new Error('planted shard failure'); });\n"
              : "import { test } from 'node:test';\ntest('passing shard', () => {});\n",
          );
        }
        const result = spawnSync(process.execPath, [suitePath, ...files], {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            KRN_TEST_STRICT: '1',
            KRN_TEST_SHARDS: '3',
          },
          timeout: 30_000,
        });
        const summaryLine = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith('KRN_TEST_SUMMARY_JSON='));

        assert.equal(result.error, undefined, result.stderr);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.ok(summaryLine, `${result.stdout}\n${result.stderr}`);
        const summary = JSON.parse(
          summaryLine.slice('KRN_TEST_SUMMARY_JSON='.length),
        );
        assert.equal(summary.success, false);
        assert.equal(
          summary.counts.failed,
          1,
          `${result.stdout}\n${result.stderr}`,
        );
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing file or mismatched native test count rejects the merged summary', () => {
  const files = ['/repo/test/a.test.mjs', '/repo/test/b.test.mjs'];
  const missingFile = mergeTestShardResults(
    [
      {
        events: [...fileEvents(files[0]), globalSummary(1)],
        runnerExitCode: 0,
      },
    ],
    files,
    { expectedTestCount: 1 },
  );
  const wrongCount = mergeTestShardResults(
    [
      {
        events: [
          ...fileEvents(files[0]),
          ...fileEvents(files[1]),
          globalSummary(2),
        ],
        runnerExitCode: 0,
      },
    ],
    files,
    { expectedTestCount: 3 },
  );

  assert.equal(missingFile.ok, false);
  assert.equal(wrongCount.ok, false);
  assert.ok(
    wrongCount.errors.some((error) => /native TAP reports 3/u.test(error)),
  );
});

test('compact output retains failing TAP and summarizes passing groups', async () => {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-compact-output-'));
  const files = Array.from({ length: 3 }, (_, index) =>
    join(directory, `compact-${index}.test.mjs`),
  );
  try {
    for (const [index, file] of files.entries())
      await writeFile(
        file,
        `import { test } from 'node:test';\ntest('case ${index}', () => { ${index === 1 ? "throw new Error('planted');" : ''} });\n`,
      );
    const result = spawnSync(process.execPath, [suitePath, ...files], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_TEST_STRICT: '1',
        KRN_TEST_SHARDS: '3',
        KRN_TEST_OUTPUT: 'failures',
      },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /# group \d+: ok, 1 tests, 1 files/u);
    assert.match(result.stdout, /# group \d+: FAILED exit 1/u);
    assert.match(result.stdout, /not ok 1 - case 1/u);
    assert.doesNotMatch(result.stdout, /ok 1 - case (?:0|2)/u);
    assert.match(result.stdout, /KRN_TEST_SUMMARY_JSON=.*"success":false/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid compact output mode exits before spawning tests', () => {
  const result = spawnSync(process.execPath, [suitePath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, KRN_TEST_OUTPUT: 'bogus' },
    timeout: 30_000,
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /KRN_TEST_OUTPUT must be full or failures/u);
  assert.equal(result.stdout, '');
});
