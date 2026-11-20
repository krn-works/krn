import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dropLane, startLane } from '../../src/cli/lane.ts';
import { applyPrune, planPrune } from '../../src/cli/prune.ts';
import {
  allowedTransition,
  createManifest,
  type LaneManifest,
  type LanePhase,
  laneManifestDir,
  listManifests,
  liveManifestOfWorktree,
  newLaneId,
  readManifest,
  transition,
} from '../../src/lane/manifest.ts';
import { recordShip } from '../../src/repo/ship-record.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git, startFixture } from '../helpers/lane-start.ts';

admitLanesOnAnyHost();

const head = 'a'.repeat(40);
const sha = 'b'.repeat(40);
const at = '2026-11-20T10:00:00.000Z';
const phases: Record<LanePhase['kind'], LanePhase> = {
  reserved: { kind: 'reserved' },
  started: { kind: 'started' },
  shipping: { kind: 'shipping', pid: 4242, head },
  shipped: { kind: 'shipped', pr: 7, head },
  parked: { kind: 'parked', reason: 'install failed' },
  merged: { kind: 'merged', sha, head },
  retired: { kind: 'retired', at, reason: 'dropped' },
};
const shippingWithPr: LanePhase = { kind: 'shipping', pid: 4242, head, pr: 7 };

// ADR 0029 decision 1, the transition table: every allowed edge per phase; anything else is refused.
const allowed: Record<LanePhase['kind'] | 'none', string[]> = {
  none: ['reserved', 'started'],
  reserved: ['started', 'retired'],
  started: ['shipping', 'shipping+pr', 'parked', 'retired'],
  shipping: ['shipping+pr', 'merged', 'shipped', 'started', 'retired'],
  shipped: ['shipping', 'shipping+pr', 'started', 'merged', 'retired'],
  parked: ['started', 'retired'],
  merged: ['retired'],
  retired: [],
};

const targets: Record<string, LanePhase> = {
  ...phases,
  'shipping+pr': shippingWithPr,
};

for (const [from, edges] of Object.entries(allowed))
  test(`from ${from} the table allows exactly ${edges.join(', ') || 'nothing'}`, () => {
    const source =
      from === 'none' ? undefined : phases[from as LanePhase['kind']];
    const actual = Object.entries(targets)
      .filter(([, to]) => allowedTransition(source, to))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(actual, [...edges].sort());
  });

test('shipping records its PR only under the same pid', () => {
  assert.equal(
    allowedTransition(phases.shipping, { ...shippingWithPr, pid: 9 }),
    false,
  );
});

function checkout(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'krn-manifest-')));
}

function fields(main: string, slug = 'lane'): Omit<LaneManifest, 'phase'> {
  return {
    laneId: newLaneId(slug),
    slug,
    branch: slug,
    worktree: join(main, '.krn', 'worktrees', slug),
    base: 'main',
    task: 't-abc1234',
    targets: [],
    actor: 'lead',
    createdAt: at,
    agents: [],
  };
}

test('a lane id is the slug and six base36 characters, new every time', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newLaneId('x')));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^x-[0-9a-z]{6}$/u);
});

test('each allowed edge is written and every refused edge leaves the file byte-identical', (t) => {
  const main = checkout();
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const lane = createManifest(main, fields(main), phases.started);
  const path = join(main, laneManifestDir, `${lane.laneId}.json`);
  const walk: LanePhase[] = [
    phases.shipping,
    shippingWithPr,
    phases.shipped,
    phases.shipping,
    phases.started,
    phases.parked,
    phases.started,
    phases.shipping,
    phases.merged,
  ];
  for (const to of walk) {
    const before = readFileSync(path);
    assert.throws(
      () => transition(main, lane.laneId, phases.reserved),
      (error: Error & { exitCode?: number }) => error.exitCode === 70,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(transition(main, lane.laneId, to).phase, to);
  }
  transition(main, lane.laneId, phases.retired);
  assert.equal(readManifest(main, lane.laneId)?.phase.kind, 'retired');
  assert.throws(
    () => transition(main, lane.laneId, phases.started),
    /retired/u,
  );
  // No temporary or marker file outlives a write.
  assert.deepEqual(readdirSync(join(main, laneManifestDir)), [
    `${lane.laneId}.json`,
  ]);
});

test('a worktree holds one live manifest; a retired one does not count', (t) => {
  const main = checkout();
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const first = createManifest(main, fields(main), phases.started);
  assert.throws(
    () => createManifest(main, fields(main), phases.started),
    /already has a live lane/u,
  );
  transition(main, first.laneId, phases.retired);
  const second = createManifest(main, fields(main), phases.started);
  assert.equal(
    liveManifestOfWorktree(main, second.worktree as string)?.laneId,
    second.laneId,
  );
});

test('a writer whose read went stale is refused with exit 75 and the newer bytes stay', (t) => {
  const main = checkout();
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const lane = createManifest(main, fields(main), phases.started);
  const path = join(main, laneManifestDir, `${lane.laneId}.json`);
  // Another writer holds the marker of exactly these bytes.
  const digest = createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')
    .slice(0, 32);
  writeFileSync(join(main, laneManifestDir, `.${digest}.lock`), '1');
  const before = readFileSync(path);
  assert.throws(
    () => transition(main, lane.laneId, phases.shipping),
    (error: Error & { exitCode?: number }) => error.exitCode === 75,
  );
  assert.deepEqual(readFileSync(path), before);
});

test('readers skip the lead files that share the directory and torn manifests', (t) => {
  const main = checkout();
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const dir = join(main, laneManifestDir);
  mkdirSync(join(dir, 'briefs'), { recursive: true });
  writeFileSync(join(dir, 'gold.md'), '# notes\n');
  writeFileSync(join(dir, 'torn-abcdef.json'), '{"laneId":');
  writeFileSync(join(dir, 'other.json'), '{"x":1}\n');
  const lane = createManifest(main, fields(main), phases.started);
  assert.deepEqual(
    listManifests(main).map((m) => m.laneId),
    [lane.laneId],
  );
});

test('prune deletes retired manifests older than seven days and keeps live and recent ones', (t) => {
  const main = checkout();
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const now = Date.parse(at) + 8 * 24 * 3_600_000;
  const live = createManifest(main, fields(main, 'live'), phases.started);
  const old = createManifest(main, fields(main, 'old'), phases.started);
  transition(main, old.laneId, phases.retired);
  const recent = createManifest(main, fields(main, 'recent'), phases.started);
  transition(main, recent.laneId, {
    kind: 'retired',
    at: new Date(now - 3_600_000).toISOString(),
    reason: 'dropped',
  });
  const plan = planPrune(main, { base: 'main', now, days: 0 });
  applyPrune(main, plan, () => []);
  assert.deepEqual(
    listManifests(main)
      .map((m) => m.slug)
      .sort(),
    ['live', 'recent'],
  );
  assert.equal(
    existsSync(join(main, laneManifestDir, `${old.laneId}.json`)),
    false,
  );
  assert.equal(live.phase.kind, 'started');
});

test('a started lane has one started manifest naming its worktree, task and base', async (t) => {
  const { repo } = startFixture(t);
  const { path } = await startLane([
    'reused',
    '--task',
    't-abc1234',
    '--root',
    repo,
  ]);
  const manifests = listManifests(repo);
  assert.equal(manifests.length, 1);
  const [lane] = manifests;
  assert.match(lane?.laneId ?? '', /^reused-[0-9a-z]{6}$/u);
  assert.deepEqual(
    {
      phase: lane?.phase,
      worktree: lane?.worktree,
      task: lane?.task,
      base: lane?.base,
      branch: lane?.branch,
    },
    {
      phase: { kind: 'started' },
      worktree: path,
      task: 't-abc1234',
      base: 'main',
      branch: 'reused',
    },
  );
});

test('a slug restarted after its worktree went retires the earlier manifest and starts a new lane', async (t) => {
  const { repo } = startFixture(t);
  const start = () =>
    startLane(['again', '--task', 't-abc1234', '--root', repo]);
  const { path } = await start();
  // Drop does not write `retired` yet: the worktree and branch go, the manifest stays.
  git(repo, 'worktree', 'remove', '--force', path);
  git(repo, 'branch', '-D', 'again');
  await start();
  const phases = listManifests(repo)
    .map((m) => m.phase.kind)
    .sort();
  assert.deepEqual(phases, ['retired', 'started']);
  assert.equal(liveManifestOfWorktree(repo, path)?.phase.kind, 'started');
});

const phaseOf = (repo: string, slug: string) =>
  listManifests(repo).find((m) => m.slug === slug)?.phase.kind;

function merged(repo: string, slug: string, path: string): void {
  writeFileSync(join(path, slug), slug);
  git(path, 'add', '.');
  git(path, 'commit', '-qm', slug);
  const head = git(path, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', head);
  git(repo, 'push', '-q', 'origin', 'main');
  recordShip(repo, { branch: slug, sha: git(repo, 'rev-parse', 'HEAD'), head });
  const old = new Date(Date.now() - 3 * 3_600_000);
  for (const f of [
    join(repo, '.krn/runs/ship', `${slug}.json`),
    join(path, '.git'),
  ])
    utimesSync(f, old, old);
}

test('drop retires; none is silent', async (t) => {
  const { repo } = startFixture(t);
  await startLane(['gone', '--root', repo]);
  await dropLane(['gone', '--root', repo]);
  assert.equal(phaseOf(repo, 'gone'), 'retired');
  git(repo, 'worktree', 'add', '-qb', 'bare', `${repo}/.krn/worktrees/bare`);
  await dropLane(['bare', '--root', repo]);
  assert.equal(readdirSync(join(repo, laneManifestDir)).length, 1);
});

test('prune retires its lane', async (t) => {
  const { repo } = startFixture(t);
  merged(repo, 'done', (await startLane(['done', '--root', repo])).path);
  const plan = planPrune(repo, { base: 'main', users: () => [] });
  applyPrune(repo, plan, () => []);
  assert.equal(phaseOf(repo, 'done'), 'retired');
});

test('start prune retires it', async (t) => {
  const { repo } = startFixture(t);
  merged(repo, 'old', (await startLane(['old', '--root', repo])).path);
  await startLane(['next', '--root', repo]);
  assert.equal(phaseOf(repo, 'old'), 'retired');
});
