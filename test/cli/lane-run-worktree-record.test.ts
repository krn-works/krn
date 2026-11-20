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
import { prepareLane } from '../../src/cli/lane-run/prepare.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('prepareLane rerun succeeds when task record lives only in the lane worktree in a GitHub repo', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-d9-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'a@b.c');
  git(main, 'config', 'user.name', 'a');
  git(main, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  writeFileSync(
    join(main, 'package.json'),
    '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
  );
  writeFileSync(
    join(main, 'krn.json'),
    '{"base":"main","test":"node -e \\"process.exit(0)\\""}\n',
  );
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  mkdirSync(join(main, 'tasks'));
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'base');
  git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // State after first lane run of a pending task failed: task file lives only in the lane worktree.
  const lane = join(main, '.krn', 'worktrees', 't-onlywt1');
  mkdirSync(join(main, '.krn', 'worktrees'), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 't-onlywt1', lane, 'origin/main');
  const rec: TaskRecord = {
    id: 't-onlywt1',
    status: 'open',
    resolution: null,
    created: '2026-11-20',
    priority: 2,
    title: 'Worktree-only task',
    after: [],
    body: ['Outcome: exit 0'],
  };
  mkdirSync(join(lane, 'tasks'), { recursive: true });
  writeFileSync(join(lane, 'tasks', 't-onlywt1.json'), serializeTask(rec));

  const prepared = await prepareLane(
    {
      task: 't-onlywt1',
      goal: undefined,
      actor: undefined,
      model: 'sonnet',
      origin: main,
      lane: 't-onlywt1',
      label: 't-onlywt1',
    },
    {
      start: async () => ({ path: lane, slug: 't-onlywt1' }),
      ship: async () => '',
      mint: async () => undefined,
      receiver: async () => [],
    },
  );
  assert.ok(
    'worktree' in prepared,
    'expected prepareLane to reuse the worktree without crashing',
  );
});
