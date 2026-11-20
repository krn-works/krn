import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createManifest,
  laneManifestDir,
  liveManifestOfWorktree,
  readManifest,
  retireLane,
} from '../../src/lane/manifest.ts';

// Review finding on c41be9b: a live manifest written under the old directory became
// invisible to lookups by id and worktree, so removing its lane never retired it.
test('a live manifest in the legacy directory is found and retired in place', (t) => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'krn-legacy-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const worktree = join(main, '.krn', 'worktrees', 'old');
  mkdirSync(join(main, '.krn', 'worktrees'), { recursive: true });
  createManifest(
    main,
    {
      laneId: 'old-abcdef',
      slug: 'old',
      worktree,
      base: 'main',
      targets: [],
      actor: 'lead',
      createdAt: new Date().toISOString(),
      agents: [],
    },
    { kind: 'started' },
  );
  const legacyDir = join(main, '.krn', 'runs', 'lanes');
  mkdirSync(legacyDir, { recursive: true });
  const legacy = join(legacyDir, 'old-abcdef.json');
  renameSync(join(main, laneManifestDir, 'old-abcdef.json'), legacy);

  assert.equal(readManifest(main, 'old-abcdef')?.phase.kind, 'started');
  assert.equal(liveManifestOfWorktree(main, worktree)?.laneId, 'old-abcdef');

  retireLane(main, worktree, 'dropped');

  assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).phase.kind, 'retired');
  assert.equal(
    existsSync(join(main, laneManifestDir, 'old-abcdef.json')),
    false,
  );
  assert.equal(liveManifestOfWorktree(main, worktree), undefined);
});
