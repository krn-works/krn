import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  claimTask,
  inspectClaim,
  releaseClaim,
  serializeClaim,
} from '../../src/task/claims.ts';
import {
  addWorktree,
  fixtureRepo,
  removeWorktree,
  runCliAsync,
  task,
  useScratch,
} from './claims-fixture.ts';

useScratch();

// The claim file is created with an exclusive hard link and nothing else: no
// socket lock. These races show the link alone refuses a double claim.

async function writeExpired(repo: string, id: string, label: string) {
  const claimPath = join(repo, '.krn', 'task-claims', `${id}.json`);
  await mkdir(dirname(claimPath), { recursive: true });
  await writeFile(
    claimPath,
    serializeClaim({
      id,
      actor: `stale-${label}`,
      worktree: join(dirname(repo), `missing-worktree-${label}`),
      branch: `missing-branch-${label}`,
      claimed: '2026-10-26T00:00:00.000Z',
      reason: null,
    }),
  );
  return claimPath;
}

test('a free task has exactly one winner among concurrent claimers', async () => {
  const repo = await fixtureRepo('claim-race-free-', [task('T-1')]);
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  try {
    addWorktree(repo, linked, 'claim-race-free-linked');
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const worktree = index % 2 === 0 ? repo : linked;
        return {
          actor: `worker-${index}`,
          ...(await runCliAsync(worktree, [
            'claim',
            'T-1',
            '--actor',
            `worker-${index}`,
          ])),
        };
      }),
    );
    const winners = results.filter((result) => result.status === 0);
    assert.equal(winners.length, 1, results.map((r) => r.status).join(','));
    assert.equal(results.filter((result) => result.status === 75).length, 11);
    const saved = JSON.parse(
      readFileSync(join(repo, '.krn', 'task-claims', 'T-1.json'), 'utf8'),
    ) as { actor: string };
    assert.equal(saved.actor, winners[0]?.actor);
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('an expired claim has one winner among concurrent claim --next across two worktrees', async () => {
  const repo = await fixtureRepo('claim-race-expired-', [task('T-1')]);
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  try {
    addWorktree(repo, linked, 'claim-race-expired-linked');
    for (let trial = 0; trial < 3; trial += 1) {
      const claimPath = await writeExpired(repo, 'T-1', String(trial));
      const results = await Promise.all(
        Array.from({ length: 12 }, async (_, index) => {
          const actor = `worker-${trial}-${index}`;
          const worktree = index % 2 === 0 ? repo : linked;
          return {
            actor,
            worktree,
            ...(await runCliAsync(worktree, [
              'claim',
              '--next',
              '--actor',
              actor,
            ])),
          };
        }),
      );
      const winners = results.filter((result) => result.status === 0);
      assert.equal(
        winners.length,
        1,
        `trial ${trial}: ${results.map((r) => `${r.actor}=${r.status}`).join(', ')}`,
      );
      assert.equal(results.filter((result) => result.status === 75).length, 11);
      const saved = JSON.parse(readFileSync(claimPath, 'utf8')) as {
        actor: string;
      };
      assert.equal(saved.actor, winners[0]?.actor);
    }
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('takeover, release and plain claims race without leaving a double claim', async () => {
  const repo = await fixtureRepo('claim-race-mutations-', [task('T-1')]);
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  try {
    addWorktree(repo, linked, 'claim-race-mutations-linked');
    await claimTask(repo, 'T-1', { actor: 'seed' });
    const results = await Promise.all(
      Array.from({ length: 18 }, async (_, index) => {
        const kind = index < 6 ? 'takeover' : index < 12 ? 'release' : 'claim';
        const worktree = index % 2 === 0 ? repo : linked;
        try {
          if (kind === 'release') await releaseClaim(worktree, 'T-1');
          else
            await claimTask(worktree, 'T-1', {
              actor: `${kind}-${index}`,
              ...(kind === 'takeover'
                ? { takeover: true, reason: 'reassigning work' }
                : {}),
            });
          return { kind, code: 0 };
        } catch (error) {
          const code = (error as { exitCode?: number }).exitCode;
          if (code === undefined) throw error;
          return { kind, code };
        }
      }),
    );
    assert.ok(results.every(({ code }) => [0, 65, 75].includes(code)));
    assert.ok(
      results.some(({ kind, code }) => kind === 'takeover' && code === 0),
    );
    assert.ok(['live', 'none'].includes(inspectClaim(repo, 'T-1').state));
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('release removes the takeover markers an expired claim left behind', async () => {
  const repo = await fixtureRepo('claim-race-markers-', [task('T-1')]);
  try {
    await writeExpired(repo, 'T-1', 'marker');
    await claimTask(repo, 'T-1', { actor: 'fresh' });
    const directory = join(repo, '.krn', 'task-claims');
    assert.ok(
      readdirSync(directory).some((name) => name.includes('.expired-')),
    );
    await releaseClaim(repo, 'T-1');
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a 100-character task id can be claimed and released', async () => {
  const id = `T-${'1'.repeat(98)}`;
  const repo = await fixtureRepo('claim-race-long-id-', [task(id)]);
  try {
    await claimTask(repo, id, { actor: 'worker' });
    assert.equal(inspectClaim(repo, id).state, 'live');
    await releaseClaim(repo, id);
    assert.equal(inspectClaim(repo, id).state, 'none');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
