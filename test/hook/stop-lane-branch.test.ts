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
import { judgeStop } from '../../src/hook/stop.ts';
import { laneTreeOf } from '../../src/lane/session.ts';
import { recordShip } from '../../src/repo/ship-record.ts';

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

/** A main checkout on `main` with a package.json of its own (node reads the nearest one). */
function mainCheckout(): string {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'lane-branch-')));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'a@b.c');
  git(main, 'config', 'user.name', 'a');
  mkdirSync(join(main, 'src'));
  writeFileSync(join(main, 'package.json'), '{}\n');
  writeFileSync(join(main, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  return main;
}

/** A lane worktree on its own branch holding one commit past main. */
function laneTree(main: string, name: string): string {
  const tree = join(main, '.krn', 'worktrees', name);
  git(main, 'worktree', 'add', '-q', '-b', name, tree, 'main');
  writeFileSync(join(tree, 'src/a.ts'), `export const a = '${name}';\n`);
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', `work ${name}`);
  return tree;
}

const laneEnv = (dir: string, more: Record<string, string> = {}) => ({
  CLAUDE_PROJECT_DIR: dir,
  KRN_SESSION_CLASS: 'lane',
  KRN_SCOPE: '',
  KRN_TEST_FIRST: '0',
  KRN_ACCEPTANCE_CLAUSES: '0',
  ...more,
});

const headsOf =
  (heads: Record<number, string>) =>
  (_root: string, pr: number): string | undefined =>
    heads[pr];

function stop(
  payload: unknown,
  env: NodeJS.ProcessEnv,
  heads: Record<number, string>,
) {
  return judgeStop(
    payload,
    env,
    () => [],
    '',
    undefined,
    undefined,
    undefined,
    headsOf(heads),
  );
}

test('a lane subagent with two worktrees may report the PR of either and never the lead worktree', () => {
  const main = mainCheckout();
  try {
    const first = laneTree(main, 'pending-edit-archived');
    const second = laneTree(main, 'pending-edit-published');
    const lead = join(main, '.krn', 'worktrees', 'outdated-instructions');
    git(
      main,
      'worktree',
      'add',
      '-q',
      '-b',
      'outdated-instructions',
      lead,
      'main',
    );
    const transcript = join(main, 'agent.jsonl');
    writeFileSync(
      transcript,
      [first, second]
        .map((tree) =>
          JSON.stringify({ input: { file_path: join(tree, 'src/a.ts') } }),
        )
        .join('\n'),
    );
    const sub = (message: string) => ({
      cwd: lead,
      last_assistant_message: message,
      agent_id: 'a1',
      agent_type: 'krn-lane',
      agent_transcript_path: transcript,
    });
    const heads = {
      1218: 'pending-edit-archived',
      1222: 'pending-edit-published',
      9: 'outdated-instructions',
    };
    const env = { CLAUDE_PROJECT_DIR: '/somewhere/else' };
    assert.equal(stop(sub('#1218 merged abc1234'), env, heads), undefined);
    assert.equal(stop(sub('#1222 merged abc1234'), env, heads), undefined);
    const refused = stop(sub('#9 merged abc1234'), env, heads) ?? '';
    assert.match(refused, /whose head branch is outdated-instructions/u);
    assert.doesNotMatch(refused, /not your lane branch outdated-instructions/u);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a session at the main checkout whose claim was released accepts the lane branch of its ship record', () => {
  const main = mainCheckout();
  try {
    const sha = git(main, 'rev-parse', 'HEAD');
    recordShip(main, { branch: 'lane-x', sha, task: 't-abcdefg' });
    const env = laneEnv(main, { KRN_TASK: 't-abcdefg' });
    const heads = { 7: 'lane-x', 8: 'lane-y' };
    const own = { cwd: main, last_assistant_message: '#7 merged abc1234' };
    assert.equal(stop(own, env, heads), undefined);
    const other = { cwd: main, last_assistant_message: '#8 merged abc1234' };
    assert.match(
      stop(other, env, heads) ?? '',
      /whose head branch is lane-y, not your lane branch lane-x/u,
    );
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('the worker Stop gate judges the claimed lane worktree when the shell returned to the main checkout', () => {
  const main = mainCheckout();
  try {
    const tree = laneTree(main, 'slop-prune-dead');
    mkdirSync(join(main, '.krn', 'task-claims'), { recursive: true });
    writeFileSync(
      join(main, '.krn', 'task-claims', 't-abcdefg.json'),
      JSON.stringify({
        id: 't-abcdefg',
        branch: 'slop-prune-dead',
        worktree: tree,
      }),
    );
    const env = laneEnv(main, { KRN_TASK: 't-abcdefg' });
    const message = '#6 merged abc1234';
    assert.equal(
      stop({ cwd: main, last_assistant_message: message }, env, {
        6: 'slop-prune-dead',
      }),
      undefined,
    );
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a lane subagent Stop check judges the claimed lane worktree when the session cwd sits in a foreign repository', () => {
  const main = mainCheckout();
  const foreign = mainCheckout();
  try {
    const tree = laneTree(main, 'lane-in-krn');
    writeFileSync(
      join(foreign, 'package.json'),
      JSON.stringify({ scripts: { test: 'exit 1' } }),
    );
    git(foreign, 'commit', '-q', '-am', 'foreign test fails');
    mkdirSync(join(main, '.krn', 'task-claims'), { recursive: true });
    writeFileSync(
      join(main, '.krn', 'task-claims', 't-abcdefg.json'),
      JSON.stringify({
        id: 't-abcdefg',
        branch: 'lane-in-krn',
        worktree: tree,
      }),
    );
    const transcript = join(main, 'agent.jsonl');
    writeFileSync(transcript, 'lane t-abcdefg started\n');
    const reason = judgeStop(
      {
        cwd: foreign,
        agent_id: 'a1',
        agent_type: 'krn-lane',
        agent_transcript_path: transcript,
      },
      laneEnv(main, { KRN_TASK: 't-abcdefg' }),
      () => [],
      '',
      () => [],
      () => [],
    );
    assert.equal(reason, undefined);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('a repository created inside another lane worktree is its own main, a path that is gone is a lane tree only at its own depth', () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'lane-outer-')));
  try {
    const tree = join(outer, '.krn', 'worktrees', 'outer-lane');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), 'gitdir: ../../../.git/worktrees/x\n');
    const nested = join(tree, '.krn', 'tmp', 'inner');
    mkdirSync(join(nested, '.git'), { recursive: true });
    assert.deepEqual(laneTreeOf(tree), { owner: outer, name: 'outer-lane' });
    assert.deepEqual(laneTreeOf(join(tree, 'src-dir-gone')), undefined);
    assert.equal(laneTreeOf(nested), undefined);
    assert.deepEqual(laneTreeOf(join(nested, '.krn', 'worktrees', 'merged')), {
      owner: nested,
      name: 'merged',
    });
    assert.equal(laneTreeOf(join(nested, 'vanished-root')), undefined);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
