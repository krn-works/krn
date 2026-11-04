import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);
const day = 24 * 60 * 60 * 1000;

test('restart block shows only live claims and capsules and counts the hidden ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'restart-live-'));
  const git = (args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const commit = (cwd: string, date: string) =>
    git(
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'c',
      ],
      cwd,
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    );
  const old = new Date(Date.now() - 3 * day);
  try {
    git(['init', '-q', '-b', 'fixture']);
    commit(root, old.toISOString());
    // A worktree with a fresh commit keeps an old claim alive.
    const busy = join(root, 'busy');
    git(['worktree', 'add', '-q', '-b', 'busy', busy]);
    commit(busy, new Date().toISOString());
    // A worktree whose last commit is old does not.
    const quiet = join(root, 'quiet');
    git(['worktree', 'add', '-q', '-b', 'quiet', quiet]);

    const claims = join(root, '.krn/task-claims');
    mkdirSync(claims, { recursive: true });
    mkdirSync(join(root, 'tasks'));
    const claim = (
      id: string,
      fields: Record<string, unknown>,
      aged: boolean,
    ) => {
      writeFileSync(
        join(root, 'tasks', `${id}.json`),
        JSON.stringify({ id, status: 'open' }),
      );
      const path = join(claims, `${id}.json`);
      writeFileSync(path, JSON.stringify({ id, actor: 'lead', ...fields }));
      if (aged) utimesSync(path, old, old);
    };
    claim(
      'live-fresh',
      { claimed: new Date().toISOString(), worktree: quiet },
      false,
    );
    claim('live-busy', { claimed: old.toISOString(), worktree: busy }, true);
    claim('dead-idle', { claimed: old.toISOString(), worktree: quiet }, true);
    claim(
      'dead-gone',
      { claimed: old.toISOString(), worktree: join(root, 'missing') },
      true,
    );
    claim('dead-undated', {}, true);

    const capsule = (name: string, state: string, aged: boolean) => {
      const directory = join(root, '.krn/runs/delivery-loop', name);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'state.md');
      writeFileSync(
        path,
        `Outcome state: ${state}\nRestart state: ${name}/handoff.md\n`,
      );
      if (aged) utimesSync(path, old, old);
    };
    capsule('live-capsule', 'ACTIVE', false);
    capsule('dead-complete', 'COMPLETE', false);
    capsule('dead-stale', 'ACTIVE', true);

    const run = () => {
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
      return JSON.parse(result.stdout).hookSpecificOutput
        .additionalContext as string;
    };
    const hidden =
      'Hidden: 3 idle claims, 2 inactive capsules (idle over 24h or COMPLETE)';
    const text = run();
    for (const live of ['live-fresh', 'live-busy', 'live-capsule'])
      assert.ok(text.includes(live), `${live} is shown`);
    const dead = text
      .split('\n')
      .filter((line) => line.includes('dead-'))
      .join('\n');
    // Dead share of the claim and capsule lines: the task target is below 0.10.
    assert.equal(
      dead,
      '',
      'idle, gone, undated and complete entries are hidden',
    );
    assert.ok(
      text.includes(hidden),
      'hidden entries are counted, not silently dropped',
    );
    // Live entries beyond the 8000-byte budget are truncated; the count survives.
    for (let index = 0; index < 200; index += 1)
      writeFileSync(
        join(claims, `live-many-${String(index).padStart(3, '0')}.json`),
        JSON.stringify({
          id: `live-many-${index}`,
          actor: 'lead',
          branch: 'b'.repeat(60),
        }),
      );
    const truncated = run();
    assert.ok(
      Buffer.byteLength(truncated) < 8000 &&
        truncated.includes('live-many-000'),
    );
    assert.ok(!truncated.includes('live-many-199'), 'the block is truncated');
    assert.ok(truncated.includes(hidden), 'the count survives truncation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
