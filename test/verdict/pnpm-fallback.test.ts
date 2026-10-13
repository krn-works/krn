import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
