import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/memory-refs.ts', import.meta.url),
);
test('checks memory references, text grammar and restart receiver', () => {
  assert.ok(existsSync(script), 'memory checker exists');
  const root = mkdtempSync(join(tmpdir(), 'memory-refs-'));
  const memory = join(
    root,
    '.claude/projects',
    root.replace(/[^A-Za-z0-9]/gu, '-'),
    'memory',
  );
  const run = () =>
    spawnSync(process.execPath, [script, '--root', root, '--memory', memory], {
      encoding: 'utf8',
    });
  try {
    assert.equal(
      spawnSync('git', ['init', '-b', 'fixture'], { cwd: root }).status,
      0,
    );
    assert.equal(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=t@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ],
        { cwd: root },
      ).status,
      0,
    );
    mkdirSync(memory, { recursive: true });
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/real.md'), 'real');
    writeFileSync(join(root, 'tasks/t-aaaaaaa.json'), '{"status":"closed"}');
    writeFileSync(join(root, 'tasks/t-bbbbbbb.json'), '{"status":"open"}');
    writeFileSync(join(memory, 'MEMORY.md'), '[a](a.md)\n[gone](gone.md)\n');
    writeFileSync(
      join(memory, 'a.md'),
      't-aaaaaaa still open\nt-aaaaaaa history\nt-ccccccc\nt-bbbbbbb pending\n`docs/real.md`\n```\n`docs/missing.ts`\n```\n`~/<placeholder>/x` `https://example.invalid/x`\n`krn/gate` `fix/review-line-limit` `/code-review`\n`docs/real.md:3-5` `docs/real.md:219,371-379`\n`docs/missing.ts:12`\n',
    );
    writeFileSync(join(memory, 'b.md'), 'unindexed');
    const result = run();
    assert.equal(result.status, 65, result.stderr);
    assert.equal(
      result.stdout,
      'MISSING-INDEX MEMORY.md:2 gone\nSTALE-TASK a.md:1 t-aaaaaaa\nMISSING-TASK a.md:3 t-ccccccc\nDANGLING a.md:7 docs/missing.ts\nDANGLING a.md:12 docs/missing.ts:12\nUNINDEXED b.md\nmemory-refs: 6 findings in 3 files\n',
    );
    const restart = fileURLToPath(
      new URL('../../scripts/claude/context-restart.ts', import.meta.url),
    );
    const hook = () =>
      spawnSync(process.execPath, [restart], {
        env: { ...process.env, HOME: root, CLAUDE_PROJECT_DIR: root },
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'fixture',
          transcript_path: 'unused',
          hook_event_name: 'SessionStart',
          source: 'startup',
        }),
      });
    assert.match(
      JSON.parse(hook().stdout).hookSpecificOutput.additionalContext,
      /Memory: 6 findings; run node scripts\/claude\/memory-refs.ts/u,
    );
    rmSync(memory, { recursive: true });
    assert.doesNotMatch(
      JSON.parse(hook().stdout).hookSpecificOutput.additionalContext,
      /Memory:/u,
    );
    assert.equal(run().status, 64);
    mkdirSync(memory);
    writeFileSync(join(memory, 'MEMORY.md'), '\uFEFF[c](c.md)\r\n');
    writeFileSync(join(memory, 'c.md'), 'title\r\n`docs/missing.ts`\r\n');
    assert.equal(
      run().stdout,
      'DANGLING c.md:2 docs/missing.ts\nmemory-refs: 1 findings in 2 files\n',
    );
    rmSync(join(memory, 'c.md'));
    writeFileSync(join(memory, 'MEMORY.md'), 'clean\n');
    assert.equal(run().status, 0);
    assert.equal(run().stdout, 'memory-refs: 0 findings in 1 files\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounds, symlinks, malformed inputs and output limits', () => {
  assert.ok(existsSync(script));
  const root = mkdtempSync(join(tmpdir(), 'memory-bounds-'));
  const memory = join(root, 'memory');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [script, '--root', root, '--memory', memory, ...args],
      { encoding: 'utf8' },
    );
  try {
    mkdirSync(memory);
    mkdirSync(join(root, 'tasks'));
    writeFileSync(join(root, 'tasks/t-aaaaaaa.json'), '{');
    writeFileSync(
      join(memory, 'MEMORY.md'),
      '[a](a.md)\n[a](a.md)\n[missing](gone.md)\n[missing](gone.md)',
    );
    writeFileSync(join(memory, 'a.md'), 't-aaaaaaa\n'.repeat(210));
    writeFileSync(join(memory, 'bad.md'), Buffer.from([0xff]));
    symlinkSync('absent', join(memory, '0link.md'));
    const result = run();
    assert.equal(result.status, 65);
    assert.match(result.stdout, /DANGLING 0link.md:0 symlink/u);
    // The sorted output is capped, while the summary retains the total.
    assert.match(result.stdout, /\.\.\. \d+ more/u);
    assert.equal(result.stdout.split('MISSING-INDEX').length - 1, 1);
    rmSync(join(memory, 'a.md'));
    const small = run();
    assert.match(small.stdout, /UNREADABLE bad.md/u);
    assert.match(small.stdout, /DANGLING 0link.md:0 symlink/u);
    writeFileSync(join(memory, 'huge.md'), 'x'.repeat(256 * 1024 + 1));
    assert.match(run().stdout, /TOO-LARGE huge.md/u);
    writeFileSync(join(memory, 'MEMORY.md'), 'x\n'.repeat(201));
    assert.match(run().stdout, /INDEX-SIZE MEMORY.md 201 lines 402 bytes/u);
    // An index beyond the read bound still reports its real line count.
    writeFileSync(
      join(memory, 'MEMORY.md'),
      `${'y'.repeat(1023)}\n`.repeat(300),
    );
    assert.match(run().stdout, /INDEX-SIZE MEMORY.md 300 lines 307200 bytes/u);
    // CR-only and CRLF separators count like the in-memory scan.
    writeFileSync(
      join(memory, 'MEMORY.md'),
      `${'y'.repeat(1023)}\r`.repeat(300),
    );
    assert.match(run().stdout, /INDEX-SIZE MEMORY.md 300 lines 307200 bytes/u);
    writeFileSync(
      join(memory, 'MEMORY.md'),
      `${'y'.repeat(1022)}\r\n`.repeat(300),
    );
    assert.match(run().stdout, /INDEX-SIZE MEMORY.md 300 lines 307200 bytes/u);
    // An unreadable oversized index is reported and the other files are still scanned.
    chmodSync(join(memory, 'MEMORY.md'), 0o000);
    const unreadable = run();
    chmodSync(join(memory, 'MEMORY.md'), 0o600);
    assert.equal(unreadable.status, 65);
    assert.match(unreadable.stdout, /UNREADABLE MEMORY.md/u);
    assert.match(unreadable.stdout, /TOO-LARGE huge.md/u);
    // Directories named *.md never count toward the 500-file bound.
    for (let index = 0; index < 501; index++)
      mkdirSync(join(memory, `dir-${index}.md`));
    assert.doesNotMatch(run().stdout, /TOO-LARGE MEMORY.md \d+ files/u);
    assert.equal(run('--unknown').status, 64);
    rmSync(memory, { recursive: true });
    symlinkSync(root, memory);
    assert.equal(run().status, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
