// Review finding on 098c21a: a locked manifest aborted prune after it removed the worktree, leaving the rest of the plan unapplied.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyPrune, planPrune } from '../../src/cli/prune.ts';
import { createManifest, laneManifestDir } from '../../src/lane/manifest.ts';
import { git } from '../helpers/lane-start.ts';

function fixture(t: test.TestContext) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-review-retire-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-qb', 'main');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'seed',
  );
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const slug = 'finished';
  const path = join(repo, '.krn', 'worktrees', slug);
  git(repo, 'worktree', 'add', '-qb', slug, path);
  const manifest = createManifest(
    repo,
    {
      laneId: 'finished-abcdef',
      slug,
      branch: slug,
      worktree: path,
      base: 'main',
      targets: [],
      actor: 'lead',
      createdAt: new Date().toISOString(),
      agents: [],
    },
    { kind: 'started' },
  );
  const file = join(repo, laneManifestDir, `${manifest.laneId}.json`);
  return { repo, slug, path, manifest, file };
}

test('prune continues after removing a worktree whose manifest is locked', (t) => {
  const { repo, slug, path, file } = fixture(t);
  const digest = createHash('sha256')
    .update(readFileSync(file))
    .digest('hex')
    .slice(0, 32);
  writeFileSync(
    join(repo, laneManifestDir, `.${digest}.lock`),
    String(process.pid),
  );
  const scratch = join(repo, '.krn', 'runs', 'proof', 'scratch');
  mkdirSync(scratch, { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 3_600_000);
  utimesSync(scratch, old, old);
  utimesSync(join(path, '.git'), old, old);
  const plan = planPrune(repo, { base: 'main', users: () => [] });
  assert.equal(plan.worktrees[0]?.path, path);
  assert.equal(plan.scratch[0]?.path, scratch);
  const done = applyPrune(repo, plan, () => []);
  assert.equal(done.worktrees[0]?.path, path);
  assert.equal(git(repo, 'branch', '--list', slug), '');
  assert.equal(existsSync(scratch), false);
});
