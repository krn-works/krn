import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCodexExecutable } from '../../src/hosts/codex.ts';

test('resolves the highest installed Codex release', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'krn-codex-executable-'));
  const releases = join(fakeHome, '.codex/packages/app-server-daemon/releases');
  const oldExecutable = join(
    releases,
    '0.160.0-x86_64-unknown-linux-musl/bin/codex',
  );
  const newestExecutable = join(
    releases,
    '0.162.1-x86_64-unknown-linux-musl/bin/codex',
  );
  const junkExecutable = join(releases, 'nightly/bin/codex');

  try {
    await Promise.all([
      mkdir(join(oldExecutable, '..'), { recursive: true }),
      mkdir(join(newestExecutable, '..'), { recursive: true }),
      mkdir(join(junkExecutable, '..'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(oldExecutable, ''),
      writeFile(newestExecutable, ''),
      writeFile(junkExecutable, ''),
    ]);

    assert.equal(resolveCodexExecutable(fakeHome), newestExecutable);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('falls back to PATH when no Codex release is installed', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'krn-codex-executable-empty-'));
  try {
    assert.equal(resolveCodexExecutable(fakeHome), 'codex');
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('uses the operator executable override', () => {
  const previous = process.env.KRN_CODEX_BIN;
  process.env.KRN_CODEX_BIN = '/operator/bin/codex';
  try {
    assert.equal(resolveCodexExecutable('/unused/home'), '/operator/bin/codex');
  } finally {
    if (previous === undefined) {
      delete process.env.KRN_CODEX_BIN;
    } else {
      process.env.KRN_CODEX_BIN = previous;
    }
  }
});
