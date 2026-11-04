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

test('lead memory refuses a lesson that still waits for enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-pending-'));
  const memory = join(root, 'memory');
  const run = () =>
    spawnSync(process.execPath, [script, '--root', root, '--memory', memory], {
      encoding: 'utf8',
    });
  try {
    const git = (...args: string[]) =>
      assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
    git('init', '-b', 'fixture');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    mkdirSync(memory);
    mkdirSync(join(root, 'tasks'));
    writeFileSync(join(root, 'tasks/t-aaaaaaa.json'), '{"status":"open"}');
    writeFileSync(join(memory, 'MEMORY.md'), '[a](a.md)\n[b](b.md)\n');
    writeFileSync(
      join(memory, 'a.md'),
      'title\n\nLesson pending enforcement: t-aaaaaaa\n',
    );
    // Mentioning the marker inside prose is not a pending lesson.
    writeFileSync(
      join(memory, 'b.md'),
      'operator preference\nnotes say "Lesson pending enforcement" elsewhere\n',
    );
    const result = run();
    assert.equal(result.status, 65, result.stderr);
    assert.equal(
      result.stdout,
      'PENDING-LESSON a.md:3 t-aaaaaaa\nmemory-refs: 1 findings in 3 files\n',
    );
    writeFileSync(join(memory, 'a.md'), 'title\n');
    assert.equal(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
