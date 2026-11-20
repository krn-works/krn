// Review finding on fab3b76: once the removal verbs stopped throwing on a locked manifest, lane start
// did too, and created the worktree (running post-checkout) before refusing the restart.
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
import { startLane } from '../../src/cli/lane.ts';
import {
  laneManifestDir,
  liveManifestOfWorktree,
} from '../../src/lane/manifest.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git } from '../helpers/lane-start.ts';

test('a restart blocked by the previous manifest does not run post-checkout', async (t) => {
  admitLanesOnAnyHost();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'krn-locked-restart-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '-qb', 'main', origin);
  git(root, 'init', '-qb', 'main', repo);
  git(repo, 'config', 'user.name', 'Lane Test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'commit', '--allow-empty', '-qm', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  const start = () =>
    startLane(['again', '--root', repo], { openPrs: () => undefined });
  const { path } = await start();
  const manifest = liveManifestOfWorktree(repo, path);
  assert.ok(manifest);
  git(repo, 'worktree', 'remove', '--force', path);
  git(repo, 'branch', '-D', 'again');

  const dir = join(repo, laneManifestDir);
  const bytes = readFileSync(join(dir, `${manifest.laneId}.json`));
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  writeFileSync(join(dir, `.${digest}.lock`), String(process.pid));

  const marker = join(repo, '.git', 'checkout-ran');
  const hooks = join(repo, '.git', 'hooks');
  git(repo, 'config', 'core.hooksPath', hooks);
  writeFileSync(
    join(hooks, 'post-checkout'),
    '#!/bin/sh\ntouch "$(git rev-parse --path-format=absolute --git-common-dir)/checkout-ran"\n',
    { mode: 0o755 },
  );

  await assert.rejects(start);
  assert.equal(
    existsSync(marker),
    false,
    'the rejected restart ran post-checkout',
  );
});
