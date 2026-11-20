import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dropLane } from '../../src/cli/lane.ts';
import { createManifest, laneManifestDir } from '../../src/lane/manifest.ts';
import { git } from '../helpers/lane-start.ts';

// Review finding on b5e48ef: a manifest write blocked by a held swap marker made
// drop throw after it had removed the worktree, leaving the branch behind.
test('a blocked manifest write does not leave a half-dropped lane', async (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-drop-retire-')));
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
  const path = join(repo, '.krn', 'worktrees', 'blocked');
  git(repo, 'worktree', 'add', '-qb', 'blocked', path);
  const manifest = createManifest(
    repo,
    {
      laneId: 'blocked-abcdef',
      slug: 'blocked',
      branch: 'blocked',
      worktree: path,
      base: 'main',
      targets: [],
      actor: 'lead',
      createdAt: new Date().toISOString(),
      agents: [],
    },
    { kind: 'started' },
  );
  const dir = join(repo, laneManifestDir);
  const bytes = readFileSync(join(dir, `${manifest.laneId}.json`));
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  writeFileSync(join(dir, `.${digest}.lock`), '999999999');

  const out = await dropLane(['blocked', '--root', repo]);
  assert.match(out, /^dropped lane blocked/u);
  assert.equal(existsSync(path), false);
  assert.equal(git(repo, 'branch', '--list', 'blocked'), '');
});
