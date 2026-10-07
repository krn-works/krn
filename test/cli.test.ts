import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('krn --version reports the package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'krn 0.1.0\n');
});

test('unknown commands forward arguments, streams, and exit code to the legacy binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-'));
  try {
    const legacy = join(directory, 'legacy.mjs');
    await writeFile(
      legacy,
      [
        'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), forwarded: process.env.KRN_FORWARDED }));',
        "process.stderr.write('legacy stderr\\n');",
        'process.exitCode = 23;',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [cli, 'legacy-command', 'one'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 23);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['legacy-command', 'one'],
      forwarded: '1',
    });
    assert.equal(result.stderr, 'legacy stderr\n');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('forwarding guard blocks a recursive legacy invocation', () => {
  const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_LEGACY_ENTRY: cli, KRN_FORWARDED: '' },
  });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /recursion blocked/u);
});

test('legacy entry defaults under the current Codex installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-home-'));
  try {
    const legacy = join(directory, '.codex/krn/current/scripts/krn.mjs');
    await mkdir(join(directory, '.codex/krn/current/scripts'), {
      recursive: true,
    });
    await writeFile(legacy, "process.stdout.write('default legacy');");
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        KRN_LEGACY_ENTRY: '',
        KRN_FORWARDED: '',
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'default legacy');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('realpath recursion guard blocks a symlink to the CLI itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-link-'));
  try {
    const alias = join(directory, 'legacy-link.mjs');
    await symlink(cli, alias);
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: alias, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 70);
    assert.match(result.stderr, /recursion blocked/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
