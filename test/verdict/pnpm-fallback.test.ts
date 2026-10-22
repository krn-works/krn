import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

const miseLocationEnvironmentKeys = [
  'MISE_DATA_DIR',
  'MISE_CONFIG_DIR',
  'MISE_CACHE_DIR',
  'MISE_STATE_DIR',
] as const;

function pnpmFixture(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'krn-pnpm-fallback-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'pnpm');
  writeFileSync(executable, `#!/bin/sh\necho ${version}\n`);
  chmodSync(executable, 0o755);
  return { root, bin, executable };
}

test('pnpm PATH fallback requires the exact manager version', async () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const matching = pnpmFixture('12.5.1');
  const mismatching = pnpmFixture('0.0.1');

  try {
    const sandbox = (await import(
      '../../src/verdict/sandbox.ts'
    )) as unknown as Record<string, unknown>;
    const candidate = sandbox.pnpmBinary;
    assert.equal(typeof candidate, 'function');
    if (typeof candidate !== 'function') return;

    process.env.PATH = matching.bin;
    process.env.HOME = matching.root;
    assert.equal(await candidate('pnpm@12.5.1'), matching.executable);

    process.env.PATH = mismatching.bin;
    process.env.HOME = mismatching.root;
    await assert.rejects(() => candidate('pnpm@12.5.1'), /PATH pnpm must be/u);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(matching.root, { recursive: true, force: true });
    rmSync(mismatching.root, { recursive: true, force: true });
  }
});

test('pnpmBinary forwards only set mise location variables to mise where', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-pnpm-mise-environment-'));
  const bin = join(root, 'bin');
  const managerDirectory = join(root, 'managed-pnpm');
  const capture = join(root, 'mise-environment.json');
  const mise = join(bin, 'mise');
  const pnpm = join(managerDirectory, 'pnpm');
  const originalEnvironment = new Map(
    [
      'PATH',
      'HOME',
      ...miseLocationEnvironmentKeys,
      'KRN_MISE_ENV_SENTINEL',
    ].map((key) => [key, process.env[key]]),
  );

  try {
    mkdirSync(bin);
    mkdirSync(managerDirectory);
    writeFileSync(pnpm, '');
    writeFileSync(
      mise,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const environmentKeys = ${JSON.stringify([
        ...miseLocationEnvironmentKeys,
        'KRN_MISE_ENV_SENTINEL',
      ])};
const values = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key] ?? null]));
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(values));
process.stdout.write(${JSON.stringify(`${managerDirectory}\n`)});
`,
    );
    chmodSync(mise, 0o755);

    const sandbox = (await import(
      '../../src/verdict/sandbox.ts'
    )) as unknown as Record<string, unknown>;
    const candidate = sandbox.pnpmBinary;
    assert.equal(typeof candidate, 'function');
    if (typeof candidate !== 'function') return;

    process.env.PATH = [
      bin,
      dirname(process.execPath),
      originalEnvironment.get('PATH'),
    ]
      .filter((value): value is string => Boolean(value))
      .join(delimiter);
    process.env.HOME = root;
    process.env.KRN_MISE_ENV_SENTINEL = 'must-not-reach-mise';

    for (const key of miseLocationEnvironmentKeys) {
      process.env[key] = join(root, key.toLowerCase());
    }
    assert.equal(await candidate('pnpm@12.10.1'), pnpm);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      MISE_DATA_DIR: join(root, 'mise_data_dir'),
      MISE_CONFIG_DIR: join(root, 'mise_config_dir'),
      MISE_CACHE_DIR: join(root, 'mise_cache_dir'),
      MISE_STATE_DIR: join(root, 'mise_state_dir'),
      KRN_MISE_ENV_SENTINEL: null,
    });

    for (const key of miseLocationEnvironmentKeys) delete process.env[key];
    assert.equal(await candidate('pnpm@12.10.1'), pnpm);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      MISE_DATA_DIR: null,
      MISE_CONFIG_DIR: null,
      MISE_CACHE_DIR: null,
      MISE_STATE_DIR: null,
      KRN_MISE_ENV_SENTINEL: null,
    });
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('pnpmStore forwards pnpm_config_store_dir only when it is set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-pnpm-store-environment-'));
  const bin = join(root, 'bin');
  const storeDirectory = join(root, 'parent-pnpm-store');
  const capture = join(root, 'pnpm-environment.json');
  const pnpm = join(bin, 'pnpm');
  const originalEnvironment = new Map(
    ['PATH', 'HOME', 'pnpm_config_store_dir', 'KRN_PNPM_STORE_SENTINEL'].map(
      (key) => [key, process.env[key]],
    ),
  );

  try {
    mkdirSync(bin);
    writeFileSync(
      pnpm,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const values = {
  pnpm_config_store_dir: process.env.pnpm_config_store_dir ?? null,
  KRN_PNPM_STORE_SENTINEL: process.env.KRN_PNPM_STORE_SENTINEL ?? null,
};
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(values));
if (process.argv.slice(2).join(' ') !== 'store path') process.exit(2);
process.stdout.write(${JSON.stringify(`${storeDirectory}\n`)});
`,
    );
    chmodSync(pnpm, 0o755);

    const sandbox = (await import(
      '../../src/verdict/sandbox.ts'
    )) as unknown as Record<string, unknown>;
    const candidate = sandbox.pnpmStore;
    assert.equal(typeof candidate, 'function');
    if (typeof candidate !== 'function') return;

    process.env.PATH = [
      bin,
      dirname(process.execPath),
      originalEnvironment.get('PATH'),
    ]
      .filter((value): value is string => Boolean(value))
      .join(delimiter);
    process.env.HOME = root;
    process.env.KRN_PNPM_STORE_SENTINEL = 'must-not-reach-pnpm';
    process.env.pnpm_config_store_dir = storeDirectory;
    assert.equal(await candidate(pnpm, root), storeDirectory);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      pnpm_config_store_dir: storeDirectory,
      KRN_PNPM_STORE_SENTINEL: null,
    });

    delete process.env.pnpm_config_store_dir;
    assert.equal(await candidate(pnpm, root), storeDirectory);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      pnpm_config_store_dir: null,
      KRN_PNPM_STORE_SENTINEL: null,
    });
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
