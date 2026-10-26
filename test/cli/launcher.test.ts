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
const launcher = join(repository, 'bin', 'krn');
const cliEntry = join(repository, 'src', 'cli', 'krn.mjs');

async function nodeVersion(): Promise<string> {
  return (await readFile(join(repository, '.node-version'), 'utf8')).trim();
}

async function createSandbox(miseBody: string) {
  const directory = await mkdtemp(join(tmpdir(), 'krn-launcher-'));
  const miseData = join(directory, 'mise-data');
  const pathDirectory = join(directory, 'path');
  await mkdir(pathDirectory);
  const mise = join(pathDirectory, 'mise');
  await writeFile(mise, `#!/bin/sh\n${miseBody}\n`);
  await chmod(mise, 0o755);
  return {
    directory,
    miseData,
    pathDirectory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function installStubNode(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      '#!/usr/bin/env bash',
      'printf "executable=%s\\n" "$0"',
      'printf "%s\\0" "$@"',
      'exit "$KRN_STUB_EXIT"',
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
}

function environment(
  sandbox: Awaited<ReturnType<typeof createSandbox>>,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MISE_DATA_DIR: sandbox.miseData,
    PATH: [sandbox.pathDirectory, process.env.PATH ?? ''].join(delimiter),
    ...extra,
  };
}

function expectedOutput(executable: string, args: string[]): string {
  return (
    'executable=' +
    executable +
    '\n' +
    [cliEntry, ...args].map((arg) => `${arg}\0`).join('')
  );
}

test('uses the pinned Node install and passes arguments and exit status', async () => {
  const version = await nodeVersion();
  const sandbox = await createSandbox('exit 1');
  try {
    const node = join(
      sandbox.miseData,
      'installs',
      'node',
      version,
      'bin',
      'node',
    );
    await installStubNode(node);
    const args = ['--probe', 'value with spaces', ''];
    const result = spawnSync(launcher, args, {
      cwd: sandbox.directory,
      encoding: 'utf8',
      env: environment(sandbox, { KRN_STUB_EXIT: '37' }),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 37);
    assert.equal(result.stdout, expectedOutput(node, args));
    assert.equal(result.stderr, '');
  } finally {
    await sandbox.cleanup();
  }
});

test('resolves the repository root through a symlink from another directory', async () => {
  const version = await nodeVersion();
  const sandbox = await createSandbox('exit 1');
  try {
    const node = join(
      sandbox.miseData,
      'installs',
      'node',
      version,
      'bin',
      'node',
    );
    await installStubNode(node);
    const otherDirectory = join(sandbox.directory, 'elsewhere');
    await mkdir(otherDirectory);
    const linkedLauncher = join(otherDirectory, 'krn');
    await symlink(launcher, linkedLauncher);
    const args = ['task', 'list'];
    const result = spawnSync(linkedLauncher, args, {
      cwd: otherDirectory,
      encoding: 'utf8',
      env: environment(sandbox, { KRN_STUB_EXIT: '0' }),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expectedOutput(node, args));
    assert.equal(result.stderr, '');
  } finally {
    await sandbox.cleanup();
  }
});

test('uses mise where when the direct install path is absent', async () => {
  const version = await nodeVersion();
  const sandbox = await createSandbox(
    'if [ "$1" = where ] && [ "$2" = "node@"$KRN_EXPECTED_NODE_VERSION ]; then\n' +
      '  printf "%s\\n" "$KRN_MISE_WHERE"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 1',
  );
  try {
    const install = join(sandbox.directory, 'fallback-install');
    const node = join(install, 'bin', 'node');
    await installStubNode(node);
    const args = ['--fallback'];
    const result = spawnSync(launcher, args, {
      cwd: sandbox.directory,
      encoding: 'utf8',
      env: environment(sandbox, {
        KRN_EXPECTED_NODE_VERSION: version,
        KRN_MISE_WHERE: install,
        KRN_STUB_EXIT: '0',
      }),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expectedOutput(node, args));
    assert.equal(result.stderr, '');
  } finally {
    await sandbox.cleanup();
  }
});

test('reports a missing pinned Node install with exit code 127', async () => {
  const version = await nodeVersion();
  const sandbox = await createSandbox('exit 1');
  try {
    const result = spawnSync(launcher, [], {
      cwd: sandbox.directory,
      encoding: 'utf8',
      env: environment(sandbox),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 127);
    assert.equal(
      result.stderr,
      `krn: Node.js ${version} is not installed; install it with mise.\n`,
    );
  } finally {
    await sandbox.cleanup();
  }
});
