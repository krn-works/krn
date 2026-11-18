import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { finishLane, LANE_NOTES_PATH } from '../../src/cli/lane-finish.ts';

delete process.env.KRN_SESSION_CLASS;
// KRN-12: real git repositories and a real `krn lane start`; only gh is faked, answering
// the calls ship makes with the shapes gh prints.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const merge = 'c'.repeat(40);
const task = 't-abc1234';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(trailer: string, tail = '') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-finish-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(repo, 'tasks', `${task}.json`),
    `${JSON.stringify(
      {
        id: task,
        status: 'open',
        resolution: null,
        created: '2026-11-09',
        priority: 3,
        title: 'Lane task',
        after: [],
        body: ['Outcome: ship the lane', 'Why: a lane stopped early'],
      },
      null,
      2,
    )}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const started = spawnSync(
    process.execPath,
    [cli, 'lane', 'start', 'stopped', '--task', task],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);
  const worktree = join(repo, '.krn', 'worktrees', 'stopped');
  writeFileSync(join(worktree, 'out.txt'), 'x');
  git(worktree, 'add', 'out.txt');
  git(
    worktree,
    'commit',
    '-qm',
    `feat(lane): a stopped lane ships (${task})\n\n${trailer}: ${task}${tail}`,
  );
  git(worktree, 'push', '-q', 'origin', 'stopped');
  return { base, repo, worktree };
}

function fakeGh(worktree: string) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  let views = 0;
  const gh = async (a: string[]): Promise<string> => {
    calls.push(a);
    if (a[0] === 'pr' && a[1] === 'view') {
      views += 1;
      return JSON.stringify(
        views === 1
          ? {
              state: 'OPEN',
              headRefOid: git(worktree, 'rev-parse', 'HEAD'),
              autoMergeRequest: { mergeMethod: 'SQUASH' },
              statusCheckRollup: [],
            }
          : {
              state: 'MERGED',
              headRefOid: git(worktree, 'rev-parse', 'HEAD'),
              mergeCommit: { oid: merge },
              statusCheckRollup: [],
            },
      );
    }
    // The head has no check run yet: the check-runs answer is the empty list the jq filter prints.
    if (a[0] === 'api') return '[]';
    if (a[0] === 'pr' && a[1] === 'create') {
      // The body lives in the worktree, which the merged ship removes: read it while it exists.
      bodies.push(
        readFileSync(a[a.indexOf('--body-file') + 1] as string, 'utf8'),
      );
      return 'https://github.com/o/r/pull/7\n';
    }
    return '';
  };
  return { calls, gh, bodies };
}

function bodyOf(bodies: string[]): string {
  assert.equal(bodies.length, 1, 'gh pr create was called once');
  return bodies[0] as string;
}

const sleep = async () => {};

test('finish ships a pushed lane with its recorded notes and gets verdict merged', async () => {
  const { base, repo, worktree } = fixture('Ticket');
  try {
    mkdirSync(join(worktree, '.krn', 'tmp'), { recursive: true });
    writeFileSync(
      join(worktree, LANE_NOTES_PATH),
      JSON.stringify({
        assumptions: 'notes live in lane-notes.json',
        weakensTests: 'dropped an obsolete case',
        verified: 'npm run fast: pass',
      }),
    );
    const { calls, gh, bodies } = fakeGh(worktree);
    const out = await finishLane(['stopped', '--repo', 'o/r', '--root', repo], {
      gh,
      sleep,
    });
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
    const body = bodyOf(bodies);
    assert.match(body, /Ticket: t-abc1234/u);
    assert.match(body, /Lane: krn lane brief/u);
    assert.match(body, /- notes live in lane-notes\.json/u);
    assert.match(body, /npm run fast: pass/u);
    assert.match(body, /^Weakens-tests: dropped an obsolete case$/mu);
    const created = calls.find((a) => a[1] === 'create') as string[];
    assert.equal(
      created[created.indexOf('--title') + 1],
      `feat(lane): a stopped lane ships (${task})`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('finish reads Refs above a separate Co-Authored-By paragraph', async () => {
  // The harness attribution ends every commit with its own Co-Authored-By paragraph, so git's
  // trailer block (the last paragraph) holds no Refs.
  const { base, repo, worktree } = fixture(
    'Refs',
    '\n\nCo-Authored-By: Agent <noreply@example.com>',
  );
  try {
    const { gh, bodies } = fakeGh(worktree);
    const out = await finishLane(['stopped', '--repo', 'o/r', '--root', repo], {
      gh,
      sleep,
    }).catch((error: unknown) => assert.fail(String(error)));
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
    assert.match(bodyOf(bodies), /Refs: t-abc1234/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('finish without notes derives Refs from the commit trailer and still ships', async () => {
  const { base, repo, worktree } = fixture('Refs');
  try {
    const { gh, bodies } = fakeGh(worktree);
    const out = await finishLane(['stopped', '--repo', 'o/r', '--root', repo], {
      gh,
      sleep,
    });
    assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
    const body = bodyOf(bodies);
    assert.match(body, /Refs: t-abc1234/u);
    assert.doesNotMatch(body, /Ticket:|Weakens-tests|## Assumptions/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
