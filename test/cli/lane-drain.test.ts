import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DrainSeams,
  drainReady,
  parseDrainRequest,
} from '../../src/cli/lane-run/drain.ts';

function seams(
  queue: string[],
  exits: Record<string, number>,
  doctorExit = 0,
): { seams: DrainSeams; ran: Array<{ id: string; args: string[] }> } {
  const ran: Array<{ id: string; args: string[] }> = [];
  let clock = 0;
  return {
    ran,
    seams: {
      doctor: () => ({ text: 'doctor says', exitCode: doctorExit }),
      nextReady: async (_root, skip) => queue.find((id) => !skip.has(id)),
      runTask: async (id, args) => {
        ran.push({ id, args });
        clock += 5000;
        return { line: id, exitCode: exits[id] ?? 0 };
      },
      now: () => clock,
    },
  };
}
const request = (max: number) => ({
  max,
  passthrough: ['--actor', 'a'],
  root: process.cwd(),
});

test('drain runs ready tasks serially in queue order and prints a summary line and the verdict line of each', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c'], {});
  const result = await drainReady(request(3), s);
  assert.deepEqual(
    ran.map((r) => r.id),
    ['t-a', 't-b', 't-c'],
  );
  assert.deepEqual(ran[0]?.args, ['--actor', 'a']);
  assert.deepEqual(result.lines, [
    't-a t-a exit=0 5s',
    't-a',
    't-b t-b exit=0 5s',
    't-b',
    't-c t-c exit=0 5s',
    't-c',
  ]);
  assert.equal(result.exitCode, 0);
});

test('drain stops at max', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c'], {});
  await drainReady(request(2), s);
  assert.equal(ran.length, 2);
});

test('drain goes on when two different tasks fail with the same exit class', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c', 't-d'], {
    't-a': 74,
    't-b': 74,
  });
  const result = await drainReady(request(4), s);
  assert.equal(ran.length, 4);
  assert.equal(result.exitCode, 74);
  assert.doesNotMatch(result.lines.join('\n'), /stopped,/u);
});

test('drain stops after two infrastructure failures of different tasks', async () => {
  for (const code of [67, 69, 70, 75]) {
    const { seams: s, ran } = seams(['t-a', 't-b', 't-c'], {
      't-a': code,
      't-b': code,
    });
    const result = await drainReady(request(5), s);
    assert.deepEqual(
      ran.map((r) => r.id),
      ['t-a', 't-b'],
    );
    assert.equal(result.exitCode, code);
    assert.equal(
      result.lines.at(-1),
      `drain: stopped, infrastructure ${code} twice`,
    );
  }
});

test('drain goes on when infrastructure failures differ or a task failure intervenes', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c', 't-d'], {
    't-a': 70,
    't-b': 69,
    't-c': 70,
  });
  await drainReady(request(4), s);
  assert.equal(ran.length, 4);
  const { seams: s2, ran: ran2 } = seams(['t-a', 't-b', 't-c'], {
    't-a': 70,
    't-b': 74,
    't-c': 70,
  });
  await drainReady(request(3), s2);
  assert.equal(ran2.length, 3);
});

test('drain goes on when failures differ or a success intervenes', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c', 't-d'], {
    't-a': 74,
    't-b': 73,
    't-c': 74,
  });
  await drainReady(request(4), s);
  assert.equal(ran.length, 4);
  const { seams: s2, ran: ran2 } = seams(['t-a', 't-b', 't-c'], {
    't-a': 74,
    't-c': 74,
  });
  await drainReady(request(3), s2);
  assert.equal(ran2.length, 3);
});

test('a failing doctor stops the drain before any claim', async () => {
  const { seams: s, ran } = seams(['t-a'], {}, 69);
  const result = await drainReady(request(3), s);
  assert.equal(ran.length, 0);
  assert.equal(result.exitCode, 69);
  assert.match(
    result.lines[0] ?? '',
    /doctor --unattended failed \(exit 69\)/u,
  );
});

test('an empty queue ends the drain with exit 0', async () => {
  const { seams: s } = seams([], {});
  const result = await drainReady(request(3), s);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.lines, ['drain: no ready task left']);
});

test('parseDrainRequest needs --max and passes actor, model and root through', () => {
  assert.throws(() => parseDrainRequest(['--ready']), /--max/u);
  assert.throws(
    () => parseDrainRequest(['--ready', '--max', '0']),
    /positive/u,
  );
  assert.throws(() =>
    parseDrainRequest(['--ready', '--max', '2', '--task', 't-x']),
  );
  const parsed = parseDrainRequest([
    '--ready',
    '--max',
    '2',
    '--actor',
    'w',
    '--model',
    'm',
    '--root',
    '/r',
  ]);
  assert.equal(parsed.max, 2);
  assert.deepEqual(parsed.passthrough, [
    '--actor',
    'w',
    '--model',
    'm',
    '--root',
    '/r',
  ]);
});

test('parseDrainRequest takes --window-hours for the doctor and keeps it out of the lane flags', () => {
  const parsed = parseDrainRequest([
    '--ready',
    '--max',
    '1',
    '--window-hours',
    '2.5',
  ]);
  assert.equal(parsed.windowHours, '2.5');
  assert.deepEqual(parsed.passthrough, []);
  assert.equal(
    parseDrainRequest(['--ready', '--max', '1']).windowHours,
    undefined,
  );
  assert.throws(
    () => parseDrainRequest(['--ready', '--max', '1', '--window-hours', '0']),
    /positive/u,
  );
});

test("after a killed run the drain offers its own still-claimed task again, never another actor's", async () => {
  const { rmSync } = await import('node:fs');
  const { startLane } = await import('../../src/cli/lane.ts');
  const { defaultDrainSeams } = await import('../../src/cli/lane-run/drain.ts');
  const { recoveryTasks, scratchRepository } = await import(
    '../../evals/adoption/recovery.ts'
  );
  // A lane session exports these; the lane started here must not inherit its class.
  for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
    delete process.env[name];
  const scratch = scratchRepository();
  try {
    const [first, second] = recoveryTasks;
    // The killed run: its lane start claimed the task, then the process died before any release.
    await startLane([
      first,
      '--task',
      first,
      '--actor',
      `lane-${first}`,
      '--root',
      scratch.repo,
    ]);
    assert.equal(
      await defaultDrainSeams.nextReady(scratch.repo, new Set()),
      first,
    );
    assert.equal(
      await defaultDrainSeams.nextReady(
        scratch.repo,
        new Set(),
        'someone-else',
      ),
      second,
    );
  } finally {
    rmSync(scratch.base, { recursive: true, force: true });
  }
});

/** A scratch repository with `count` open tasks on origin/main, a lane environment pinned to the default budget. */
async function budgetScratch(count: number) {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { scratchRepository } = await import(
    '../../evals/adoption/recovery.ts'
  );
  const saved = Object.fromEntries(
    [
      'KRN_SESSION_CLASS',
      'KRN_LANE',
      'KRN_TASK',
      'KRN_LANE_MAX_LIVE',
      'KRN_LANE_MIN_FREE_GB',
    ].map((name) => [name, process.env[name]]),
  );
  for (const name of Object.keys(saved)) delete process.env[name];
  process.env.KRN_LANE_MAX_LIVE = '6';
  process.env.KRN_LANE_MIN_FREE_GB = '0';
  const scratch = scratchRepository();
  const ids = Array.from(
    { length: count },
    (_, index) => `t-drn${String(index).padStart(4, '0')}`,
  );
  for (const id of ids)
    writeFileSync(
      join(scratch.repo, 'tasks', `${id}.json`),
      `${JSON.stringify({ id, status: 'open', resolution: null, created: '2026-11-18', priority: 1, title: `Leftover ${id}`, after: [], body: [`Outcome: ${id}.`] }, null, 2)}\n`,
    );
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-C', scratch.repo, ...args]).status,
      0,
      args.join(' '),
    );
  git('add', 'tasks');
  git('commit', '-qm', 'more tasks');
  git('push', '-q', 'origin', 'main');
  const restore = () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  return { scratch, ids, restore };
}

/** What a failed `krn lane run` attempt leaves: its worktree with uncommitted work, the claim released. */
async function failedAttempt(repo: string, id: string): Promise<void> {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { startLane } = await import('../../src/cli/lane.ts');
  const { releaseClaim } = await import('../../src/task/claims.ts');
  const lane = await startLane([
    id,
    '--task',
    id,
    '--actor',
    `lane-${id}`,
    '--root',
    repo,
  ]);
  writeFileSync(join(lane.path, 'draft.txt'), 'unfinished\n');
  await releaseClaim(repo, id);
}

test('a drain of 7 failing tasks runs all 7 and never stops on the lane budget for its own leftovers', async () => {
  const { rmSync } = await import('node:fs');
  const { defaultDrainSeams } = await import('../../src/cli/lane-run/drain.ts');
  const { scratch, ids, restore } = await budgetScratch(7);
  try {
    const ran: string[] = [];
    const result = await drainReady(
      { max: 10, passthrough: [], root: scratch.repo },
      {
        doctor: () => ({ text: '', exitCode: 0 }),
        nextReady: defaultDrainSeams.nextReady,
        // A refused start is the exit 64 the CLI gives a CliUsageError: the drain records it like any verdict.
        runTask: async (id) => {
          ran.push(id);
          try {
            await failedAttempt(scratch.repo, id);
          } catch (error) {
            return { line: (error as Error).message, exitCode: 64 };
          }
          return {
            line: `lane ${id}: no delivery (claim released)`,
            exitCode: 73,
          };
        },
        now: () => 0,
      },
    );
    const seeded = ran.filter((id) => ids.includes(id));
    assert.deepEqual(seeded.sort(), ids);
    assert.equal(result.exitCode, 73);
    assert.ok(!result.lines.some((line) => /lane budget|exit=64/u.test(line)));
  } finally {
    restore();
    rmSync(scratch.base, { recursive: true, force: true });
  }
});

test('the lane budget skips failed attempts but still counts a task lane that holds its claim', async () => {
  const { rmSync } = await import('node:fs');
  const { checkLaneBudget, startLane } = await import('../../src/cli/lane.ts');
  const { scratch, ids, restore } = await budgetScratch(7);
  try {
    for (const id of ids.slice(0, 6)) await failedAttempt(scratch.repo, id);
    assert.doesNotThrow(() => checkLaneBudget(scratch.repo, 'main'));
    process.env.KRN_LANE_MAX_LIVE = '1';
    await startLane([
      ids[6] as string,
      '--task',
      ids[6] as string,
      '--actor',
      'worker',
      '--root',
      scratch.repo,
    ]);
    assert.throws(
      () => checkLaneBudget(scratch.repo, 'main'),
      /lane budget: 1 live lane worktrees/u,
    );
  } finally {
    restore();
    rmSync(scratch.base, { recursive: true, force: true });
  }
});
