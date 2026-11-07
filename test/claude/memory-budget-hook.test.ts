import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/memory-budget.ts', import.meta.url),
);

test('write-time memory index budget refuses growth past the budget', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'memory-hook-')));
  const root = join(home, 'repo');
  const memory = join(
    home,
    '.claude/projects',
    root.replace(/[^A-Za-z0-9]/gu, '-'),
    'memory',
  );
  const index = join(memory, 'MEMORY.md');
  const run = (tool_name: string, tool_input: object) =>
    spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      input: JSON.stringify({
        session_id: 's',
        hook_event_name: 'PreToolUse',
        cwd: root,
        tool_name,
        tool_input,
      }),
    });
  try {
    mkdirSync(root);
    mkdirSync(memory, { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    const ok = run('Write', { file_path: index, content: 'x\n'.repeat(10) });
    assert.equal(ok.status, 0);
    const big = run('Write', { file_path: index, content: 'x'.repeat(2401) });
    assert.equal(big.status, 2);
    assert.match(big.stderr, /index budget is 2400 bytes and 200 lines/u);
    const lines = run('Write', {
      file_path: index,
      content: 'x\n'.repeat(201),
    });
    assert.equal(lines.status, 2);
    // Edit is evaluated against the current file.
    writeFileSync(index, 'x'.repeat(2300));
    const edit = (n: number) =>
      run('Edit', {
        file_path: index,
        old_string: 'x',
        new_string: 'x'.repeat(n),
      });
    assert.equal(edit(150).status, 2);
    assert.equal(edit(1).status, 0);
    // An oversized index may still shrink.
    writeFileSync(index, 'x'.repeat(3000));
    assert.equal(
      run('Write', { file_path: index, content: 'x'.repeat(2900) }).status,
      0,
    );
    assert.equal(
      run('Write', { file_path: index, content: 'x'.repeat(3100) }).status,
      2,
    );
    // Other files and other tools are not touched.
    assert.equal(
      run('Write', {
        file_path: join(memory, 'a.md'),
        content: 'x'.repeat(5000),
      }).status,
      0,
    );
    assert.equal(
      run('Write', {
        file_path: join(root, 'MEMORY.md'),
        content: 'x'.repeat(5000),
      }).status,
      0,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
