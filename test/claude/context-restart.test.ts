import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);

test('restart hook emits bounded JSON with capsule fields, open claims, handoff and five rules', () => {
  assert.ok(existsSync(script), 'restart script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-restart-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-b', 'fixture']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
    writeFileSync(
      join(root, '.krn/task-claims/claim.json'),
      '{"id":"fixture-claim","actor":"lead"}',
    );
    writeFileSync(
      join(root, '.krn/task-claims/stale.json'),
      '{"id":"stale-claim","actor":"lead"}',
    );
    writeFileSync(join(root, '.krn/task-claims/broken.json'), '{');
    mkdirSync(join(root, 'tasks'));
    writeFileSync(
      join(root, 'tasks/stale-claim.json'),
      '{"id":"stale-claim","status":"closed"}',
    );
    writeFileSync(
      join(root, 'tasks/fixture-claim.json'),
      '{"id":"fixture-claim","status":"open"}',
    );
    mkdirSync(join(root, '.krn/runs/delivery-loop/outcome'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.krn/runs/delivery-loop/outcome/state.md'),
      `Outcome state: ACTIVE\nRestart state: ${'resume '.repeat(1000)}\nAuthority: must not include\n`,
    );
    writeFileSync(
      join(root, '.krn/runs/delivery-loop/outcome/handoff.md'),
      'pointer only',
    );
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: join(root, 'transcript'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length <= 8000);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'SessionStart');
    for (const text of [
      'fixture',
      git(['rev-parse', '--short', 'HEAD']),
      'fixture-claim',
      'Outcome state: ACTIVE',
      'Restart state:',
      'handoff.md',
      'delegate reading',
      'verdict and path',
      'pointers, not file contents',
      'commands that print a verdict',
      'one slice per session',
      'gauge advisory',
      'krn-handoff',
    ])
      assert.ok(output.additionalContext.includes(text), text);
    assert.ok(!output.additionalContext.includes('Authority:'));
    assert.ok(
      !output.additionalContext.includes('stale-claim'),
      'claims on closed tasks are stale',
    );
    const linked = join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD']);
    const resumed = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: linked },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: 'unused',
        hook_event_name: 'SessionStart',
        source: 'compact',
      }),
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.ok(resumed.stdout.length <= 8000);
    assert.match(
      JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext,
      /fixture-claim/u,
    );
    assert.match(
      JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext,
      /Outcome state: ACTIVE/u,
    );

    assert.ok(
      output.additionalContext
        .split('\n')
        .filter((line: string) => line.startsWith('Restart state:'))
        .every((line: string) => line.length <= 400),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart hook exits silently outside git', () => {
  assert.ok(existsSync(script), 'restart script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-restart-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: 'missing',
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
