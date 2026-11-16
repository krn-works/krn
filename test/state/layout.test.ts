import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratchRule } from '../../src/cli/lane-brief.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const OLD = new Date(Date.now() - 400 * 86_400_000);

function fixture(): { root: string; krn: string } {
  const root = mkdtempSync(join(tmpdir(), 'krn-layout-'));
  const krn = join(root, '.krn');
  for (const dir of [
    'tmp',
    'runs/delivery-loop',
    'runs/lanes/old-lane',
    'worktrees/lane-a',
    'task-claims',
    'sources/clone',
    'unknown-dir',
  ])
    mkdirSync(join(krn, dir), { recursive: true });
  writeFileSync(join(krn, 'tmp-x.log'), 'log');
  writeFileSync(join(krn, 'tmp/expired.log'), 'old');
  writeFileSync(join(krn, 'tmp/fresh.log'), 'new');
  writeFileSync(join(krn, 'runs/loose.log'), 'loose');
  writeFileSync(join(krn, 'runs/lanes/old-lane/brief.md'), 'old');
  writeFileSync(join(krn, 'runs/delivery-loop/handoff.md'), 'keep');
  writeFileSync(join(krn, 'sources/clone/f'), 'keep');
  writeFileSync(join(krn, 'task-claims/t-aaaaaaa.json'), '{}');
  for (const old of [
    'tmp/expired.log',
    'runs/lanes/old-lane/brief.md',
    'runs/lanes/old-lane',
    'runs/delivery-loop/handoff.md',
    'sources/clone/f',
    'sources/clone',
    'task-claims/t-aaaaaaa.json',
  ])
    utimesSync(join(krn, old), OLD, OLD);
  return { root, krn };
}

const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, 'state', ...args, '--root', root], {
    encoding: 'utf8',
  });

test('check names a root log, an unknown dir and an expired tmp file; tidy fixes all and check then exits 0', () => {
  const { root, krn } = fixture();
  try {
    const before = run(root, 'check');
    assert.equal(before.status, 1);
    assert.match(
      before.stderr,
      /\.krn\/tmp-x\.log is not in the declared layout/,
    );
    assert.match(
      before.stderr,
      /\.krn\/unknown-dir is not in the declared layout/,
    );
    assert.match(
      before.stderr,
      /\.krn\/tmp\/expired\.log is past its tmp retention/,
    );
    assert.match(
      before.stderr,
      /\.krn\/runs\/loose\.log is not in the declared layout/,
    );
    assert.match(
      before.stderr,
      /\.krn\/runs\/lanes\/old-lane is past its lanes retention/,
    );

    const tidy = run(root, 'tidy');
    assert.equal(tidy.status, 0, tidy.stderr);
    assert.match(tidy.stdout, /tidy: 3 stray\(s\), 2 expired, \d+ bytes/);

    const after = run(root, 'check');
    assert.equal(after.status, 0, after.stderr);
    const top = readdirSync(krn).filter((name) =>
      statSync(join(krn, name)).isFile(),
    );
    assert.deepEqual(top.sort(), ['INDEX.md']);
    assert.ok(existsSync(join(krn, 'tmp/stray/tmp-x.log')));
    assert.ok(existsSync(join(krn, 'tmp/stray/unknown-dir')));
    assert.ok(existsSync(join(krn, 'tmp/stray/runs__loose.log')));
    assert.ok(existsSync(join(krn, 'tmp/fresh.log')));
    assert.ok(!existsSync(join(krn, 'tmp/expired.log')));
    assert.ok(!existsSync(join(krn, 'runs/lanes/old-lane')));
    assert.ok(existsSync(join(krn, 'runs/lanes')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention never deletes worktrees, claims, handoffs or sources, however old', () => {
  const { root, krn } = fixture();
  try {
    assert.equal(run(root, 'tidy').status, 0);
    for (const kept of [
      'worktrees/lane-a',
      'task-claims/t-aaaaaaa.json',
      'runs/delivery-loop/handoff.md',
      'sources/clone/f',
    ])
      assert.ok(existsSync(join(krn, kept)), kept);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tidy --dry-run prints counts and changes nothing', () => {
  const { root, krn } = fixture();
  try {
    const listing = () =>
      readdirSync(krn, { recursive: true }).sort().join('\n');
    const before = listing();
    const dry = run(root, 'tidy', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(
      dry.stdout,
      /would move \.krn\/tmp-x\.log -> \.krn\/tmp\/stray\/tmp-x\.log/,
    );
    assert.match(dry.stdout, /would delete \.krn\/tmp\/expired\.log/);
    assert.match(
      dry.stdout,
      /tidy --dry-run: 3 stray\(s\), 2 expired, \d+ bytes/,
    );
    assert.equal(listing(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tidy regenerates INDEX.md with owner, purpose, size and last write', () => {
  const { root, krn } = fixture();
  try {
    run(root, 'tidy');
    const index = readFileSync(join(krn, 'INDEX.md'), 'utf8');
    assert.match(
      index,
      /\| entry \| owner \| purpose \| retention \| size \| last write \|/,
    );
    assert.match(
      index,
      /\| tmp \| any agent \|.*\| 14 days \| \d+ B \| \d{4}-\d\d-\d\d \|/,
    );
    assert.match(index, /\| delivery-loop \| lead \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the lane brief rule and both lanes.md copies name the worktree scratch dir', () => {
  assert.match(scratchRule(), /\.krn\/tmp\/.*own worktree/);
  const copies = [
    '../../.agents/skills/delivery-lead/lanes.md',
    '../../src/adopt/skills/delivery-lead/lanes.md',
  ].map((path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
  );
  assert.equal(copies[0], copies[1]);
  assert.match(copies[0] as string, /`\.krn\/tmp\/` inside your own worktree/);
});
