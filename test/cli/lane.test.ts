import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { fetchBase } from '../../src/cli/lane.ts';

// A lane session exports its class; these tests start lanes of their own.
delete process.env.KRN_SESSION_CLASS;

// KRN-12: runs `krn lane start` against real temporary git repositories.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

// An ambient lane session sets KRN_SESSION_CLASS=lane, which `krn lane start` rejects; the tests own their environment.
Reflect.deleteProperty(process.env, 'KRN_SESSION_CLASS');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(
    join(repo, 'tasks', 't-abc1234.json'),
    `${JSON.stringify(
      {
        id: 't-abc1234',
        status: 'open',
        resolution: null,
        created: '2026-11-09',
        priority: 3,
        title: 'Lane task',
        after: [],
        body: ['Outcome: o'],
      },
      null,
      2,
    )}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  // origin moves ahead of the local checkout: the lane must start from it.
  const other = join(base, 'other');
  git(base, 'clone', '-q', origin, other);
  git(other, 'config', 'user.name', 'lane test');
  git(other, 'config', 'user.email', 'lane@example.invalid');
  writeFileSync(join(other, 'newer.txt'), 'x');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'newer');
  git(other, 'push', '-q', 'origin', 'main');
  return { base, repo };
}

function lane(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'lane', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}

test('lane start fetches origin main, creates the worktree and claims the task', () => {
  const { base, repo } = fixture();
  try {
    const result = lane(repo, 'start', 'my-lane', '--task', 't-abc1234');
    assert.equal(result.status, 0, result.stderr);
    const path = join(repo, '.krn', 'worktrees', 'my-lane');
    assert.equal(result.stdout, `${path}\nmy-lane\n`);
    assert.ok(existsSync(join(path, 'newer.txt')));
    assert.equal(git(path, 'branch', '--show-current'), 'my-lane');
    const claim = readFileSync(
      join(repo, '.krn', 'task-claims', 't-abc1234.json'),
      'utf8',
    );
    assert.match(claim, /my-lane/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start works while a running lane sandbox holds .git/config.lock', () => {
  const { base, repo } = fixture();
  // The harness sandbox mounts an empty read-only placeholder over the shared config lock.
  const lock = join(repo, '.git', 'config.lock');
  writeFileSync(lock, '', { mode: 0o444 });
  try {
    const result = lane(repo, 'start', 'locked', '--task', 't-abc1234');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(
        join(repo, '.krn', 'worktrees', 'locked'),
        'branch',
        '--show-current',
      ),
      'locked',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a failed worktree add leaves no branch behind, so a retry starts the lane', () => {
  const { base, repo } = fixture();
  const worktrees = join(repo, '.krn', 'worktrees');
  mkdirSync(worktrees, { recursive: true });
  chmodSync(worktrees, 0o555);
  try {
    const failed = lane(repo, 'start', 'retry', '--task', 't-abc1234');
    assert.notEqual(failed.status, 0);
    assert.equal(
      spawnSync('git', ['show-ref', '--quiet', 'refs/heads/retry'], {
        cwd: repo,
      }).status,
      1,
    );
    chmodSync(worktrees, 0o755);
    const retried = lane(repo, 'start', 'retry', '--task', 't-abc1234');
    assert.equal(retried.status, 0, retried.stderr);
  } finally {
    chmodSync(worktrees, 0o755);
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start and pr body name a missing origin remote plainly', () => {
  const { base, repo } = fixture();
  try {
    git(repo, 'remote', 'remove', 'origin');
    const started = lane(repo, 'start', 'no-remote', '--task', 't-abc1234');
    assert.equal(started.status, 64);
    assert.match(
      started.stderr,
      /has no git remote origin: lanes branch from origin\/main/u,
    );
    const body = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-abc1234'],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(body.status, 64);
    assert.match(
      body.stderr,
      /has no git remote origin, so origin\/main does not exist/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start refuses an adoption that is not on origin yet', () => {
  const { base, repo } = fixture();
  try {
    writeFileSync(join(repo, 'krn.json'), '{}\n');
    const started = lane(repo, 'start', 'unpublished', '--task', 't-abc1234');
    assert.equal(started.status, 64);
    assert.match(
      started.stderr,
      /krn.json is not on origin\/main: commit the files krn adopt wrote/u,
    );
    assert.equal(
      existsSync(join(repo, '.krn', 'worktrees', 'unpublished')),
      false,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start carries a locally edited task record and restores the committed one', () => {
  const { base, repo } = fixture();
  try {
    const file = join(repo, 'tasks', 't-abc1234.json');
    const edited = readFileSync(file, 'utf8').replace(
      '"Outcome: o"',
      '"Outcome: o",\n    "Lead note: n"',
    );
    writeFileSync(file, edited);
    const result = lane(repo, 'start', 'noted', '--task', 't-abc1234');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(
        join(repo, '.krn', 'worktrees', 'noted', 'tasks', 't-abc1234.json'),
        'utf8',
      ),
      edited,
    );
    assert.equal(git(repo, 'status', '--porcelain', '--', 'tasks'), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start rejects a duplicate slug and a bad slug with exit 64', () => {
  const { base, repo } = fixture();
  try {
    assert.equal(lane(repo, 'start', 'dup').status, 0);
    const again = lane(repo, 'start', 'dup');
    assert.equal(again.status, 64);
    assert.match(again.stderr, /dup already exists/u);
    assert.equal(again.stdout, '');
    assert.equal(lane(repo, 'start', 'Bad Slug').status, 64);
    assert.equal(lane(repo, 'stop').status, 64);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start rolls back the worktree when the claim fails', () => {
  const { base, repo } = fixture();
  try {
    const result = lane(repo, 'start', 'ghost', '--task', 't-nope999');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'ghost')), false);
    assert.equal(git(repo, 'branch', '--list', 'ghost'), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const record = (id: string) =>
  `${JSON.stringify({ id, status: 'open', resolution: null, created: '2026-11-09', priority: 3, title: 'New', after: [], body: ['Outcome: o'] }, null, 2)}\n`;

test('lane start moves a task record that is not yet committed into the worktree', () => {
  const { base, repo } = fixture();
  try {
    const file = join(repo, 'tasks', 't-new1234.json');
    writeFileSync(file, record('t-new1234'));
    const result = lane(repo, 'start', 'carry', '--task', 't-new1234');
    assert.equal(result.status, 0, result.stderr);
    const moved = join(
      repo,
      '.krn',
      'worktrees',
      'carry',
      'tasks',
      't-new1234.json',
    );
    assert.equal(readFileSync(moved, 'utf8'), record('t-new1234'));
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(join(repo, '.krn', 'task-claims', 't-new1234.json')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start refuses a task record tracked locally but absent from origin main', () => {
  const { base, repo } = fixture();
  try {
    writeFileSync(join(repo, 'tasks', 't-loc1234.json'), record('t-loc1234'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'local task');
    const result = lane(repo, 'start', 'refused', '--task', 't-loc1234');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /tracked .* not on origin\/main/u);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'refused')), false);
    assert.ok(existsSync(join(repo, 'tasks', 't-loc1234.json')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function budgetLane(repo: string, env: Record<string, string>, slug: string) {
  return spawnSync(process.execPath, [cli, 'lane', 'start', slug], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('lane start refuses with exit 64 when free disk is below the minimum', () => {
  const { base, repo } = fixture();
  try {
    const result = budgetLane(repo, { KRN_LANE_MIN_FREE_GB: '1e9' }, 'lowdisk');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /lane budget: only .* GB free/u);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'lowdisk')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start refuses when the live lane worktree count reaches the maximum', () => {
  const { base, repo } = fixture();
  try {
    const env = { KRN_LANE_MAX_LIVE: '1' };
    assert.equal(budgetLane(repo, env, 'first').status, 0);
    const second = budgetLane(repo, env, 'second');
    assert.equal(second.status, 64);
    assert.match(second.stderr, /1 live lane worktrees/u);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'second')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start refuses a non-delivery lane above the ceiling and lets delivery through', async () => {
  const { checkLaneCeiling, startLane } = await import('../../src/cli/lane.ts');
  const over = async () => ({ share: 0.75, ceiling: 0.3, over: true });
  const under = async () => ({ share: 0.2, ceiling: 0.3, over: false });
  await assert.rejects(
    checkLaneCeiling('/unused', 'non-delivery', over),
    /non-delivery spend 75% is above 30%/,
  );
  await checkLaneCeiling('/unused', 'non-delivery', under);
  await checkLaneCeiling('/unused', 'non-delivery', async () => null);
  await checkLaneCeiling('/unused', 'delivery', over);

  const { repo } = fixture();
  await assert.rejects(
    startLane(['probe', '--class', 'non-delivery', '--root', repo], {
      ceiling: over,
    }),
    /lane ceiling/,
  );
  assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'probe')), false);
  await assert.rejects(
    startLane(['probe', '--class', 'other', '--root', repo]),
    /--class must be/,
  );
});

test('lane drop removes the worktree and branch and releases the claim', () => {
  const { base, repo } = fixture();
  try {
    assert.equal(lane(repo, 'start', 'dead', '--task', 't-abc1234').status, 0);
    const claim = join(repo, '.krn', 'task-claims', 't-abc1234.json');
    assert.ok(existsSync(claim));
    const dropped = lane(repo, 'drop', 'dead');
    assert.equal(dropped.status, 0, dropped.stderr);
    assert.match(dropped.stdout, /dropped lane dead \(released t-abc1234\)/u);
    assert.equal(existsSync(claim), false);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'dead')), false);
    assert.equal(git(repo, 'branch', '--list', 'dead'), '');
    // The task can be claimed by a new lane again.
    assert.equal(lane(repo, 'start', 'again', '--task', 't-abc1234').status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane drop refuses an unknown lane with exit 64', () => {
  const { base, repo } = fixture();
  try {
    const result = lane(repo, 'drop', 'nothing');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /lane nothing does not exist/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function laneWithOnlyCopy(repo: string, id: string, slug: string) {
  const file = join(repo, 'tasks', `${id}.json`);
  writeFileSync(file, record(id));
  const result = lane(repo, 'start', slug, '--task', id);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(file), false);
  return join(repo, '.krn', 'worktrees', slug);
}

test('krn pr body from the main checkout finds a record only the lane worktree holds', () => {
  const { base, repo } = fixture();
  try {
    laneWithOnlyCopy(repo, 't-only123', 'only');
    const result = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-only123', '--base', 'origin/main'],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Ticket: t-only123/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the lane brief reads a record only the lane worktree holds, claimed or released', async () => {
  const { taskBrief } = await import('../../src/cli/lane-run.ts');
  const { base, repo } = fixture();
  try {
    const path = laneWithOnlyCopy(repo, 't-only123', 'only');
    assert.match(taskBrief(repo, 't-only123'), /Task t-only123: New/u);
    const { releaseClaim } = await import('../../src/task/claims.ts');
    await releaseClaim(repo, 't-only123');
    assert.throws(() => taskBrief(repo, 't-only123'), /does not exist/u);
    assert.match(
      taskBrief(repo, 't-only123', '2026-11-13', [path]),
      /Task t-only123: New/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the lane brief lists the acceptance lines of the task record and requires them to pass', async () => {
  const { taskBrief } = await import('../../src/cli/lane-run.ts');
  const { base, repo } = fixture();
  try {
    const path = laneWithOnlyCopy(repo, 't-only123', 'only');
    const file = join(path, 'tasks', 't-only123.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.acceptance = [
      { verify: 'node --test test/a.test.ts', passes: false, exit: null },
    ];
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const brief = taskBrief(repo, 't-only123', '2026-11-13', [path]);
    assert.match(brief, /Acceptance lines[^\n]*must exit 0/u);
    assert.match(brief, /^- `node --test test\/a\.test\.ts`$/mu);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane drop refuses while the worktree holds the only copy of a task record', () => {
  const { base, repo } = fixture();
  try {
    const path = laneWithOnlyCopy(repo, 't-only123', 'only');
    const refused = lane(repo, 'drop', 'only');
    assert.equal(refused.status, 64);
    assert.match(refused.stderr, /only copy of t-only123/u);
    assert.ok(existsSync(join(path, 'tasks', 't-only123.json')));
    copyFileSync(
      join(path, 'tasks', 't-only123.json'),
      join(repo, 'tasks', 't-only123.json'),
    );
    assert.equal(lane(repo, 'drop', 'only').status, 0);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function laneAsync(
  repo: string,
  ...args: string[]
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'lane', ...args], {
      cwd: repo,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('concurrent lane starts in one repository all succeed', async () => {
  // Seen on the pilot: two parallel starts raced on `git fetch origin main` ("cannot lock ref", exit 64).
  const { base, repo } = fixture();
  try {
    const slugs = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const results = await Promise.all(
      slugs.map((slug) => laneAsync(repo, 'start', slug)),
    );
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    for (const slug of slugs)
      assert.ok(existsSync(join(repo, '.krn', 'worktrees', slug, 'newer.txt')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fetchBase waits out a ref lock another fetch holds and fails at once on any other error', async () => {
  const { base, repo } = fixture();
  try {
    const lock = join(repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    writeFileSync(lock, '');
    const releaser = spawn('sh', ['-c', `sleep 0.6; rm -f '${lock}'`]);
    const released = new Promise((resolve) => releaser.on('close', resolve));
    fetchBase(repo, 'main', 40, 100);
    await released;
    assert.equal(
      git(repo, 'rev-parse', 'origin/main'),
      git(join(base, 'other'), 'rev-parse', 'HEAD'),
    );
    assert.throws(() => fetchBase(repo, 'no-such-branch', 40, 1000), /failed/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
