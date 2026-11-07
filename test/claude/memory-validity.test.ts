import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { noteValidity } from '../../scripts/claude/memory-refs.ts';

const scripts = (name: string) =>
  fileURLToPath(new URL(`../../scripts/claude/${name}.ts`, import.meta.url));
const note = (front: string, body = 'body') => `---\n${front}\n---\n${body}\n`;

test('noteValidity reports superseded, expired and unknown as-of', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  assert.deepEqual(noteValidity(note('superseded_by: new.md'), now), {
    state: 'SUPERSEDED',
    asOf: 'unknown',
  });
  assert.equal(
    noteValidity(note('valid_to: 2026-01-01'), now).state,
    'EXPIRED',
  );
  assert.equal(
    noteValidity(note('valid_to: 2027-01-01'), now).state,
    'current',
  );
  assert.equal(noteValidity('no frontmatter', now).asOf, 'unknown');
  assert.equal(
    noteValidity(note('modified: 2026-11-06T13:32:36.258Z'), now).asOf,
    Date.parse('2026-11-06T13:32:36.258Z'),
  );
});

test('memory-refs and SessionStart report superseded, expired and changed-source notes', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-validity-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (args: string[]) =>
      assert.equal(
        spawnSync(
          'git',
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            ...args,
          ],
          { cwd: repo },
        ).status,
        0,
      );
    git(['init', '-b', 'fixture']);
    writeFileSync(join(repo, 'src/api.ts'), 'export {};\n');
    git(['add', '.']);
    git(['commit', '-m', 'api']);
    const memory = join(repo, 'mem');
    mkdirSync(memory);
    writeFileSync(
      join(memory, 'MEMORY.md'),
      '- [old](old.md)\n- [new](new.md)\n- [gone](gone.md)\n- [drift](drift.md)\n- [ok](ok.md)\n',
    );
    writeFileSync(join(memory, 'old.md'), note('superseded_by: new.md'));
    writeFileSync(join(memory, 'new.md'), note('modified: 2099-01-01'));
    writeFileSync(join(memory, 'gone.md'), note('valid_to: 2020-01-01'));
    writeFileSync(
      join(memory, 'drift.md'),
      note('modified: 2000-01-01', 'Use `src/api.ts` like so.'),
    );
    writeFileSync(
      join(memory, 'ok.md'),
      note('modified: 2099-01-01', 'Use `src/api.ts` like so.'),
    );
    const refs = spawnSync(
      process.execPath,
      [scripts('memory-refs'), '--root', repo, '--memory', memory],
      { encoding: 'utf8' },
    );
    assert.equal(refs.status, 65, refs.stderr);
    assert.deepEqual(refs.stdout.trim().split('\n'), [
      'CHANGED drift.md:4 src/api.ts',
      'EXPIRED gone.md',
      'SUPERSEDED old.md',
      'memory-refs: 3 findings in 6 files',
    ]);
    // SessionStart skips the per-file git comparison and reads the real auto-memory location under HOME.
    const target = join(
      home,
      '.claude/projects',
      repo.replace(/[^A-Za-z0-9]/gu, '-'),
      'memory',
    );
    mkdirSync(join(home, '.claude/projects'), { recursive: true });
    mkdirSync(join(target, '..'), { recursive: true });
    spawnSync('cp', ['-r', memory, target]);
    const start = spawnSync(process.execPath, [scripts('context-restart')], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: repo,
        GIT_CEILING_DIRECTORIES: root,
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 's',
        transcript_path: join(repo, 't'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    assert.equal(start.status, 0, start.stderr);
    const context: string = JSON.parse(start.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(
      context,
      /Memory: 2 stale note\(s\) gone\.md, old\.md; update or delete/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
