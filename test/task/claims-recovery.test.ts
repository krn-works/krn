import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  type ClaimLivenessProbes,
  claimLiveness,
} from '../../src/task/claims.ts';
import { serializeTask } from '../../src/task/record.ts';
import {
  addWorktree,
  baseLivenessProbes,
  codedError,
  fixtureRepo,
  git,
  gitProbe,
  livenessClaim,
  readyIds,
  removeWorktree,
  runCli,
  runCliAsync,
  task,
  tempRepo,
  useScratch,
} from './claims-fixture.ts';

useScratch();

test('corrupt claims fail safe, report all findings, and release clears them', async () => {
  const repo = await fixtureRepo('claim-corrupt-', [task('T-1')]);
  try {
    const directory = join(repo, '.krn', 'task-claims');
    await mkdir(directory, { recursive: true });
    const corrupt = {
      actor: 7,
      id: 'T-1',
      worktree: repo,
      branch: 'main',
      claimed: '2026-10-26T00:00:00.000Z',
      reason: false,
    };
    await writeFile(
      join(directory, 'T-1.json'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`${JSON.stringify(corrupt, null, 2)}\n`),
      ]),
    );
    const show = await runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'corrupt');
    assert.equal(JSON.parse(show.stdout).claim.reason, 'corrupt');
    assert.deepEqual(JSON.parse(show.stdout).claim.findings, [
      'file starts with a byte order mark',
      'wrong top-level key order',
      '"actor" must be a string',
      '"reason" must be a string or null',
    ]);
    const ready = await runCli(repo, ['ready', '--json']);
    assert.deepEqual(JSON.parse(ready.stdout).tasks, []);
    assert.match(ready.stderr, /"actor" must be a string/u);
    const release = await runCli(repo, ['release', 'T-1']);
    assert.equal(release.status, 0, release.stderr);
    assert.equal(existsSync(join(directory, 'T-1.json')), false);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('unreadable claims stay live and can be released or taken over', {
  skip:
    process.getuid?.() === 0
      ? 'chmod 000 does not make files unreadable when running as root'
      : false,
}, async () => {
  const repo = await fixtureRepo('claim-unreadable-', [
    task('T-1'),
    task('T-2'),
  ]);
  try {
    for (const id of ['T-1', 'T-2']) {
      assert.equal(
        (await runCli(repo, ['claim', id, '--actor', `original-${id}`])).status,
        0,
      );
      await chmod(join(repo, '.krn', 'task-claims', `${id}.json`), 0o000);
    }

    const ready = await runCli(repo, ['ready', '--json']);
    assert.equal(ready.status, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout).tasks, []);
    assert.match(ready.stderr, /unable to read claim file/u);

    const blocked = await runCli(repo, ['claim', 'T-1', '--actor', 'blocked']);
    assert.equal(blocked.status, 75);
    assert.match(blocked.stderr, /unable to read claim file/u);

    const released = await runCli(repo, ['release', 'T-1']);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(
      existsSync(join(repo, '.krn', 'task-claims', 'T-1.json')),
      false,
    );

    const takeover = await runCli(repo, [
      'claim',
      'T-2',
      '--actor',
      'replacement',
      '--takeover',
      '--reason',
      'replace unreadable claim',
    ]);
    assert.equal(takeover.status, 0, takeover.stderr);
    const replacement = JSON.parse(
      readFileSync(join(repo, '.krn', 'task-claims', 'T-2.json'), 'utf8'),
    );
    assert.equal(replacement.actor, 'replacement');
    assert.equal(replacement.reason, 'replace unreadable claim');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim rejects unknown, closed, and dependency-blocked tasks', async () => {
  const repo = await fixtureRepo('claim-invalid-task-', [
    task('T-1', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
    task('T-2'),
    task('T-3', { after: ['T-2'] }),
  ]);
  try {
    const unknown = await runCli(repo, ['claim', 'T-9', '--actor', 'worker']);
    assert.equal(unknown.status, 65);
    const closed = await runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(closed.status, 65);
    assert.match(closed.stderr, /task is closed/u);
    const blocked = await runCli(repo, ['claim', 'T-3', '--actor', 'worker']);
    assert.equal(blocked.status, 65);
    assert.match(blocked.stderr, /blocked by open after task/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim refuses detached HEAD and an unregistered worktree path', async () => {
  const repo = await fixtureRepo('claim-worktree-errors-', [task('T-1')]);
  const unregistered = await tempRepo('claim-unregistered-');
  try {
    git(repo, 'switch', '--quiet', '--detach', 'HEAD');
    const detached = await runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(detached.status, 64);
    assert.match(detached.stderr, /detached HEAD/u);

    const attached = await tempRepo('claim-attached-');
    try {
      const invalid = await runCli(attached, [
        'claim',
        'T-1',
        '--actor',
        'worker',
        '--worktree',
        unregistered,
      ]);
      assert.equal(invalid.status, 64);
      assert.match(invalid.stderr, /not registered/u);
    } finally {
      await rm(attached, { recursive: true, force: true });
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(unregistered, { recursive: true, force: true });
  }
});

test('takeover requires a reason, reports the previous holder, and release removes it', async () => {
  const repo = await fixtureRepo('claim-takeover-', [task('T-1'), task('T-2')]);
  try {
    assert.equal(
      (await runCli(repo, ['claim', 'T-1', '--actor', 'first'])).status,
      0,
    );
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const withoutReason = await runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'second',
      '--takeover',
    ]);
    assert.equal(withoutReason.status, 64);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const takeover = await runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'second',
      '--takeover',
      '--reason',
      'reassigning work',
    ]);
    assert.equal(takeover.status, 0, takeover.stderr);
    assert.match(takeover.stdout, /Previous holder: actor first/u);
    const show = JSON.parse(
      (await runCli(repo, ['show', 'T-1', '--json'])).stdout,
    );
    assert.equal(show.claim.holder.actor, 'second');
    assert.equal(show.claim.holder.reason, 'reassigning work');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const next = await runCli(repo, [
      'claim',
      '--next',
      '--actor',
      'next-worker',
    ]);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), 'T-2');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal((await runCli(repo, ['release', 'T-1'])).status, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal((await runCli(repo, ['release', 'T-2'])).status, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('release of a missing claim returns 65', async () => {
  const repo = await fixtureRepo('claim-release-missing-', [task('T-1')]);
  try {
    const show = await runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'none');
    assert.match((await runCli(repo, ['show', 'T-1'])).stdout, /Claim: none/u);
    const release = await runCli(repo, ['release', 'T-1']);
    assert.equal(release.status, 65);
    assert.match(release.stderr, /no claim to release/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim --next returns 75 when no task is ready', async () => {
  const repo = await fixtureRepo('claim-next-empty-', [task('T-1')]);
  try {
    assert.equal(
      (await runCli(repo, ['claim', 'T-1', '--actor', 'worker'])).status,
      0,
    );
    const next = await runCli(repo, [
      'claim',
      '--next',
      '--actor',
      'next-worker',
    ]);
    assert.equal(next.status, 75);
    assert.match(next.stderr, /no ready tasks are available to claim/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('stale task-write files do not affect readiness or claims and claim files stay clean', async () => {
  const repo = await fixtureRepo('claim-stale-stage-', [task('T-1')]);
  try {
    const staging = join(repo, '.krn', 'tmp', 'task-write');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, '.T-9.stale.tmp'), '{ stale\n');
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
    ]);
    const claim = await runCli(repo, ['claim', '--next', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    assert.deepEqual(await readdir(join(repo, '.krn', 'task-claims')), [
      'T-1.json',
    ]);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('removing the claim directory frees only the tasks it held', async () => {
  const repo = await fixtureRepo('claim-directory-removed-', [
    task('T-1'),
    task('T-2'),
    task('T-3'),
  ]);
  try {
    assert.equal(
      (await runCli(repo, ['claim', 'T-2', '--actor', 'worker'])).status,
      0,
    );
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
      'T-3',
    ]);
    await rm(join(repo, '.krn', 'task-claims'), {
      recursive: true,
      force: true,
    });
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
      'T-2',
      'T-3',
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claiming after expiry removes and reports the prior claim', async () => {
  const repo = await fixtureRepo('claim-expiry-reclaim-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-expiry-reclaim-linked');
  try {
    addWorktree(repo, linked, 'claim-expiry-reclaim-branch');
    assert.equal(
      (await runCli(linked, ['claim', 'T-1', '--actor', 'old'])).status,
      0,
    );
    git(linked, 'switch', '--quiet', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'claim-expiry-reclaim-branch');
    const reclaimed = await runCli(repo, ['claim', 'T-1', '--actor', 'new']);
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.match(reclaimed.stderr, /Expired claim for T-1 was removed/u);
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .holder.actor,
      'new',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('expired claim has one winner across two worktrees and twenty claimers', async () => {
  const repo = await fixtureRepo('claim-expired-stress-', [task('T-1')]);
  const stale = join(dirname(repo), 'claim-expired-stress-stale');
  const first = join(dirname(repo), 'claim-expired-stress-first');
  const second = join(dirname(repo), 'claim-expired-stress-second');
  try {
    addWorktree(repo, stale, 'claim-expired-stress-stale-branch');
    assert.equal(
      (await runCli(stale, ['claim', 'T-1', '--actor', 'stale'])).status,
      0,
    );
    git(stale, 'switch', '--quiet', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'claim-expired-stress-stale-branch');
    addWorktree(repo, first, 'claim-expired-stress-first-branch');
    addWorktree(repo, second, 'claim-expired-stress-second-branch');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runCliAsync(index % 2 === 0 ? first : second, [
          'claim',
          'T-1',
          '--actor',
          `worker-${index}`,
        ]),
      ),
    );
    const winners = results.filter((result) => result.status === 0);
    assert.equal(winners.length, 1);
    assert.equal(results.filter((result) => result.status === 75).length, 19);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    removeWorktree(repo, stale);
    removeWorktree(repo, first);
    removeWorktree(repo, second);
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim liveness expires only on positive evidence', () => {
  const closedLocal = serializeTask(
    task('T-1', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
  );
  const probes = baseLivenessProbes();
  const missingWorktree = claimLiveness('/main', livenessClaim(), {
    ...probes,
    resolveWorktree: () => {
      throw codedError('ENOENT');
    },
  });
  assert.equal(missingWorktree.reason, 'expired: worktree path is missing');

  const unregistered = claimLiveness('/main', livenessClaim(), {
    ...probes,
    worktreeList: () => gitProbe(0, Buffer.from('worktree /\0')),
  });
  assert.equal(unregistered.reason, 'expired: worktree is not registered');

  const missingBranch = claimLiveness('/main', livenessClaim(), {
    ...probes,
    branchRef: () => gitProbe(1),
  });
  assert.equal(missingBranch.reason, 'expired: branch worker does not exist');

  const missingLocalTask = claimLiveness('/main', livenessClaim(), {
    ...probes,
    taskFile: () => {
      throw codedError('ENOENT');
    },
  });
  assert.equal(
    missingLocalTask.reason,
    'expired: task file is missing from worktree',
  );

  const closedOriginTask = claimLiveness('/main', livenessClaim(), {
    ...probes,
    originTask: () => gitProbe(0, Buffer.from(closedLocal)),
  });
  assert.equal(
    closedOriginTask.reason,
    'expired: task is closed in origin/main',
  );

  const merged = claimLiveness('/main', livenessClaim(), {
    ...probes,
    taskFile: () => Buffer.from(closedLocal),
    originTask: () => gitProbe(0, Buffer.from(closedLocal)),
  });
  assert.equal(merged.reason, 'expired: task is closed in origin/main');
});

test('a task closed in its worktree keeps the claim live until origin main closes it', () => {
  const closedLocal = serializeTask(
    task('T-1', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
  );
  const probes = baseLivenessProbes();
  const delivering: Array<[string, Partial<ClaimLivenessProbes>]> = [
    ['origin main still has it open', {}],
    ['origin main is missing', { originRef: () => gitProbe(1) }],
    ['origin main lacks the task', { originTask: () => gitProbe(128) }],
  ];
  for (const [name, overrides] of delivering) {
    const result = claimLiveness('/main', livenessClaim(), {
      ...probes,
      taskFile: () => Buffer.from(closedLocal),
      ...overrides,
    });
    assert.deepEqual(
      result,
      { state: 'live', reason: 'live: in delivery, closed in worktree' },
      name,
    );
  }
});

test('claim liveness keeps unknown and failed probes live', () => {
  const probes = baseLivenessProbes();
  const cases: Array<[string, Partial<ClaimLivenessProbes>]> = [
    [
      'worktree resolution error',
      {
        resolveWorktree: () => {
          throw codedError('EACCES');
        },
      },
    ],
    ['failed worktree list', { worktreeList: () => gitProbe(2) }],
    [
      'worktree list spawn error',
      {
        worktreeList: () => gitProbe(null, Buffer.alloc(0), new Error('spawn')),
      },
    ],
    ['branch probe status other than one', { branchRef: () => gitProbe(2) }],
    [
      'branch probe spawn error',
      { branchRef: () => gitProbe(null, Buffer.alloc(0), new Error('spawn')) },
    ],
    [
      'branch status one with a spawn error',
      { branchRef: () => gitProbe(1, Buffer.alloc(0), new Error('spawn')) },
    ],
    [
      'unparseable local task',
      { taskFile: () => Buffer.from('<<<<<<< conflict\n') },
    ],
    ['origin ref not found', { originRef: () => gitProbe(1) }],
    [
      'origin ref spawn error',
      { originRef: () => gitProbe(null, Buffer.alloc(0), new Error('spawn')) },
    ],
    ['origin task absent or unreadable', { originTask: () => gitProbe(1) }],
    ['origin task other failure', { originTask: () => gitProbe(128) }],
    [
      'origin task spawn error',
      { originTask: () => gitProbe(null, Buffer.alloc(0), new Error('spawn')) },
    ],
    [
      'unparseable origin task',
      { originTask: () => gitProbe(0, Buffer.from('<<<<<<< conflict\n')) },
    ],
  ];

  for (const [name, overrides] of cases) {
    const result = claimLiveness('/main', livenessClaim(), {
      ...probes,
      ...overrides,
    });
    assert.equal(result.state, 'live', name);
    assert.equal(result.reason, 'live', name);
  }
});
