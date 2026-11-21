import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dropLane } from '../../src/cli/lane.ts';
import { createManifest, transition } from '../../src/lane/manifest.ts';
import { serializeTask } from '../../src/task/record.ts';
import * as storage from '../../src/task/storage.ts';

// A namespace import keeps the file loadable on a source without the function, so the check fails by assertion.
function laneOnlyRecords(main: string, branch: string): string[] {
  const owner = (
    storage as { laneOnlyRecords?: (m: string, b: string) => string[] }
  ).laneOnlyRecords;
  assert.equal(
    typeof owner,
    'function',
    'the storage owner names lane-only records',
  );
  return (owner as (m: string, b: string) => string[])(main, branch);
}

// KRN-12: real git, a bare origin and a real worktree; no stand-in for the receiver.
function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

const mk = (id: string, title: string) =>
  serializeTask({
    id,
    status: 'open',
    resolution: null,
    created: '2026-11-10',
    priority: 2,
    title,
    after: [],
    body: ['Outcome: exit 0', 'Proof: node --test a', 'Files: src/a.ts'],
  });

function withLane(
  run: (repo: string, worktree: string, base: string) => void | Promise<void>,
) {
  return async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-only-')));
    try {
      const origin = join(base, 'origin.git');
      const repo = join(base, 'repo');
      git(base, 'init', '-q', '--bare', '-b', 'main', origin);
      git(base, 'clone', '-q', origin, repo);
      git(repo, 'config', 'user.name', 't');
      git(repo, 'config', 'user.email', 't@e.invalid');
      git(repo, 'checkout', '-q', '-b', 'main');
      mkdirSync(join(repo, 'tasks'));
      writeFileSync(
        join(repo, 'tasks', 't-seed001.json'),
        mk('t-seed001', 'Seed'),
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'seed');
      git(repo, 'push', '-q', 'origin', 'main');
      const worktree = join(repo, '.krn', 'worktrees', 'wl');
      git(repo, 'worktree', 'add', '-q', '-b', 'wl', worktree, 'origin/main');
      git(worktree, 'config', 'user.name', 't');
      git(worktree, 'config', 'user.email', 't@e.invalid');
      await run(repo, worktree, base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
}

test(
  'a staged deletion of a published record holds no version, so drop is allowed',
  withLane(async (repo, worktree) => {
    git(worktree, 'rm', '-q', 'tasks/t-seed001.json');
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), []);
    await dropLane(['wl', '--root', repo]);
    assert.equal(existsSync(worktree), false);
  }),
);

test(
  'an edited record version that main lacks refuses drop until main holds it',
  withLane(async (repo, worktree) => {
    writeFileSync(
      join(worktree, 'tasks', 't-seed001.json'),
      mk('t-seed001', 'Edited'),
    );
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), ['t-seed001']);
    await assert.rejects(
      dropLane(['wl', '--root', repo]),
      /only copy of t-seed001/u,
    );
    assert.ok(existsSync(worktree));
    git(worktree, 'add', 'tasks');
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), ['t-seed001']);
    git(worktree, 'commit', '-qm', 'edit');
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), ['t-seed001']);
  }),
);

test(
  'a record that arrived by merge and that main holds is not lane-only',
  withLane(async (repo, worktree) => {
    writeFileSync(
      join(repo, 'tasks', 't-merged01.json'),
      mk('t-merged01', 'M'),
    );
    git(repo, 'add', 'tasks');
    git(repo, 'commit', '-qm', 'second');
    git(repo, 'push', '-q', 'origin', 'main');
    git(worktree, 'merge', '-q', 'origin/main');
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), []);
    await dropLane(['wl', '--root', repo]);
    assert.equal(existsSync(worktree), false);
  }),
);

test(
  'a new record committed on the branch is read from its tip once the worktree is gone',
  withLane((repo, worktree) => {
    writeFileSync(
      join(worktree, 'tasks', 't-new00001.json'),
      mk('t-new00001', 'N'),
    );
    git(worktree, 'add', 'tasks');
    git(worktree, 'commit', '-qm', 'new');
    git(repo, 'worktree', 'remove', '--force', worktree);
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), ['t-new00001']);
  }),
);

function mergeManifest(repo: string, worktree: string, sha: string) {
  const lane = createManifest(
    repo,
    {
      laneId: 'wl-abcdef',
      slug: 'wl',
      branch: 'wl',
      worktree,
      base: 'main',
      targets: [],
      actor: 't',
      createdAt: '2026-11-20T00:00:00.000Z',
      agents: [],
    },
    { kind: 'started' },
  );
  transition(repo, lane.laneId, {
    kind: 'shipping',
    pid: process.pid,
    head: sha,
  });
  transition(repo, lane.laneId, { kind: 'merged', sha, head: sha });
}

test(
  'a merged lane with a later edit that no copy of main holds still refuses drop',
  withLane(async (repo, worktree) => {
    mergeManifest(repo, worktree, git(worktree, 'rev-parse', 'HEAD'));
    rmSync(join(repo, 'tasks', 't-seed001.json'));
    writeFileSync(
      join(worktree, 'tasks', 't-seed001.json'),
      mk('t-seed001', 'Local edit after merge'),
    );
    await assert.rejects(
      dropLane(['wl', '--root', repo]),
      /only copy of t-seed001/u,
    );
    assert.ok(existsSync(worktree));
  }),
);

test(
  'a merged lane whose records equal the base is dropped',
  withLane(async (repo, worktree) => {
    mergeManifest(repo, worktree, git(worktree, 'rev-parse', 'HEAD'));
    await dropLane(['wl', '--root', repo]);
    assert.equal(existsSync(worktree), false);
  }),
);

test(
  'a clean lane holding an older published task is dropped after main updated it',
  withLane(async (repo, worktree) => {
    writeFileSync(
      join(repo, 'tasks', 't-seed001.json'),
      mk('t-seed001', 'Updated on main'),
    );
    git(repo, 'commit', '-qam', 'update task');
    git(repo, 'push', '-q', 'origin', 'main');
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    await dropLane(['wl', '--root', repo]);
    assert.equal(existsSync(worktree), false);
  }),
);

test(
  'a detached worktree is read from its files, not from the branch tip',
  withLane((repo, worktree) => {
    git(worktree, 'checkout', '-q', '--detach');
    writeFileSync(
      join(worktree, 'tasks', 't-det00001.json'),
      mk('t-det00001', 'D'),
    );
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), ['t-det00001']);
  }),
);

test(
  'a directory in place of a tracked record does not crash the check',
  withLane((repo, worktree) => {
    rmSync(join(worktree, 'tasks', 't-seed001.json'));
    mkdirSync(join(worktree, 'tasks', 't-seed001.json'));
    writeFileSync(join(worktree, 'tasks', 't-seed001.json', 'x'), 'x');
    assert.deepEqual(laneOnlyRecords(repo, 'wl'), []);
  }),
);

test(
  'a staged deletion does not hide the copy committed on the branch tip',
  withLane(async (repo, worktree) => {
    writeFileSync(
      join(worktree, 'tasks', 't-new00001.json'),
      mk('t-new00001', 'New'),
    );
    git(worktree, 'add', 'tasks/t-new00001.json');
    git(worktree, 'commit', '-qm', 'add task');
    git(worktree, 'rm', 'tasks/t-new00001.json');
    await assert.rejects(
      dropLane(['wl', '--root', repo]),
      /only copy of t-new00001/u,
    );
    assert.ok(existsSync(worktree));
  }),
);
