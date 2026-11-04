import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/memory-refs.ts', import.meta.url),
);

test('lead memory index stays within about 600 tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-budget-'));
  const memory = join(root, 'memory');
  const run = () =>
    spawnSync(process.execPath, [script, '--root', root, '--memory', memory], {
      encoding: 'utf8',
    });
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    mkdirSync(memory);
    mkdirSync(join(root, 'tasks'));
    writeFileSync(join(memory, 'a.md'), 'operator preference\n');
    const entry = '- [A](a.md) — operator preference\n';
    // At the budget the index is clean.
    writeFileSync(
      join(memory, 'MEMORY.md'),
      entry + 'x'.repeat(2400 - Buffer.byteLength(entry) - 1) + '\n',
    );
    const within = run();
    assert.equal(within.stdout.includes('INDEX-SIZE'), false, within.stdout);
    assert.equal(within.status, 0, within.stdout + within.stderr);
    // One byte over, in a few lines, the index is reported with its size.
    writeFileSync(
      join(memory, 'MEMORY.md'),
      entry + 'x'.repeat(2400 - Buffer.byteLength(entry)) + '\n',
    );
    const over = run();
    assert.match(over.stdout, /INDEX-SIZE MEMORY.md 2 lines 2401 bytes/u);
    assert.notEqual(over.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
