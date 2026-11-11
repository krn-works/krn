import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ledgerCommand } from '../../src/cli/ledger.ts';
import { CliUsageError } from '../../src/cli/usage-error.ts';

test('--window takes full ISO timestamps, not only dates, and refuses anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
  const path = process.env.PATH;
  const write = process.stdout.write;
  try {
    await mkdir(join(dir, 'bin'));
    // A stand-in `gh` that lists no PRs, so the window runs without network.
    await writeFile(join(dir, 'bin/gh'), '#!/bin/sh\necho "[]"\n');
    await chmod(join(dir, 'bin/gh'), 0o755);
    process.env.PATH = `${join(dir, 'bin')}:${path}`;
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    await ledgerCommand([
      '--window',
      '2026-11-10T08:15:30.000Z',
      '2026-11-11T17:45:00Z',
      '--json',
      '--root',
      dir,
      '--transcripts',
      dir,
      '--repo',
      'o/r',
    ]);
    process.stdout.write = write;
    const report = JSON.parse(out) as { window: { from: string; to: string } };
    assert.equal(report.window.from, '2026-11-10T08:15:30Z');
    assert.equal(report.window.to, '2026-11-11T17:45:00Z');
    await assert.rejects(
      ledgerCommand(['--window', '2026-11-10T08:15:30Z', 'later']),
      CliUsageError,
    );
  } finally {
    process.stdout.write = write;
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});
