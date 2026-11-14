import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);
const cli = fileURLToPath(new URL('../../bin/krn', import.meta.url));

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'state-loss-'));
  const git = spawnSync('git', ['init', '-b', 'fixture'], { cwd: root });
  assert.equal(git.status, 0);
  const commit = spawnSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    ],
    { cwd: root },
  );
  assert.equal(commit.status, 0);
  mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
  mkdirSync(join(root, 'tasks'));
  const claim = (id: string, status: string) => {
    writeFileSync(
      join(root, `.krn/task-claims/${id}.json`),
      JSON.stringify({ id, actor: 'lane' }),
    );
    writeFileSync(
      join(root, `tasks/${id}.json`),
      JSON.stringify({ id, status }),
    );
  };
  claim('t-lost001', 'open');
  claim('t-kept002', 'open');
  claim('t-done003', 'closed');
  mkdirSync(join(root, '.krn/runs/lead'), { recursive: true });
  writeFileSync(join(root, '.krn/runs/lead/handoff.md'), '- Task: t-kept002\n');
  return root;
}

test('session start names each open claim without a capsule or handoff', () => {
  const root = fixture();
  try {
    const result = spawnSync(process.execPath, [hook], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 's',
        transcript_path: join(root, 't'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const text: string = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(text, /STATE LOSS: \.krn\/task-claims\/t-lost001\.json/u);
    assert.doesNotMatch(text, /STATE LOSS:[^\n]*(t-kept002|t-done003)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('krn state check fails on an open claim without a capsule or handoff', () => {
  const root = fixture();
  try {
    const run = () =>
      spawnSync(cli, ['state', 'check', '--root', root], {
        encoding: 'utf8',
      });
    const failed = run();
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout + failed.stderr, /t-lost001/u);
    writeFileSync(
      join(root, '.krn/runs/lead/handoff.md'),
      't-lost001 t-kept002',
    );
    assert.doesNotMatch(run().stdout + run().stderr, /state-loss/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
