import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const launcherSource = join(repository, 'bin', 'krn');
const pin = '24.22.1';
let fixtureSequence = 0;

async function installStubNode(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      '#!/usr/bin/env bash',
      'printf "executable=%s\\n" "$0"',
      'printf "%s\\0" "$@"',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
}

async function createHarness(root: string, contents: string | Buffer) {
  const fixture = join(root, `fixture-${fixtureSequence++}`);
  const repo = join(fixture, 'repo');
  const launcher = join(repo, 'bin', 'krn');
  const miseData = join(fixture, 'mise-data');
  const links = join(fixture, 'links');
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(links, { recursive: true });
  await writeFile(join(fixture, 'repo', '.node-version'), contents);
  await writeFile(launcher, await readFile(launcherSource));
  await chmod(launcher, 0o755);
  const linkedLauncher = join(links, 'krn');
  await symlink(launcher, linkedLauncher);
  await installStubNode(join(miseData, 'installs', 'node', pin, 'bin', 'node'));
  const miseDirectory = join(fixture, 'bin');
  await mkdir(miseDirectory, { recursive: true });
  const mise = join(miseDirectory, 'mise');
  await writeFile(mise, '#!/bin/sh\nexit 1\n');
  await chmod(mise, 0o755);
  return {
    linkedLauncher,
    cliEntry: join(repo, 'src', 'cli', 'krn.mjs'),
    miseData,
    path: [miseDirectory, process.env.PATH ?? ''].join(delimiter),
  };
}

function runLauncher(harness: Awaited<ReturnType<typeof createHarness>>) {
  return spawnSync(harness.linkedLauncher, ['--probe'], {
    cwd: '/',
    encoding: 'utf8',
    env: {
      ...process.env,
      MISE_DATA_DIR: harness.miseData,
      PATH: harness.path,
    },
  });
}

function expectedOutput(
  node: string,
  cliEntry: string,
  args = ['--probe'],
): string {
  return `executable=${node}\n${[cliEntry, ...args].map((arg) => `${arg}\0`).join('')}`;
}

test('launcher normalizes one pinned Node version from .node-version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'krn-launcher-node-version-'));
  try {
    const validPins: readonly [string, string | Buffer][] = [
      ['LF', `${pin}\n`],
      ['CRLF', `${pin}\r\n`],
      ['trailing spaces', `${pin}   \n`],
      ['trailing tabs', `${pin}\t\t\n`],
      ['leading v', `v${pin}\n`],
      [
        'UTF-8 BOM',
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(`${pin}\n`),
        ]),
      ],
    ];
    for (const [name, contents] of validPins) {
      await t.test(`accepts ${name}`, async () => {
        const harness = await createHarness(root, contents);
        const node = join(
          harness.miseData,
          'installs',
          'node',
          pin,
          'bin',
          'node',
        );
        const result = runLauncher(harness);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, expectedOutput(node, harness.cliEntry));
        assert.equal(result.stderr, '');
      });
    }

    const invalidPins: readonly [string, string | Buffer][] = [
      ['empty file', ''],
      ['two lines', `${pin}\n${pin}\n`],
      ['malformed version', '24.x\n'],
    ];
    for (const [name, contents] of invalidPins) {
      await t.test(
        `rejects ${name} as invalid .node-version data`,
        async () => {
          const harness = await createHarness(root, contents);
          const result = spawnSync(harness.linkedLauncher, [], {
            cwd: '/',
            encoding: 'utf8',
            env: {
              ...process.env,
              MISE_DATA_DIR: harness.miseData,
              PATH: harness.path,
            },
          });
          assert.equal(result.error, undefined);
          assert.equal(result.status, 65, result.stderr);
          assert.match(result.stderr, /\.node-version/);
          assert.doesNotMatch(result.stderr, /is not installed/);
          assert.equal(result.stdout, '');
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
