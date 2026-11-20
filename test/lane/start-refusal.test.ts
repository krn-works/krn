import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { startLane } from '../../src/cli/lane.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git, startFixture } from '../helpers/lane-start.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

/** Every store a refused start must leave alone, as bytes. */
function snapshot(repo: string): Record<string, string> {
  const files: Record<string, string> = {};
  const read = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) read(path);
      else files[relative(repo, path)] = readFileSync(path, 'base64');
    }
  };
  for (const dir of ['.krn/runs/ship', '.krn/task-claims', '.krn/runs/lanes'])
    read(join(repo, dir));
  return {
    ...files,
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
    status: git(repo, 'status', '--porcelain'),
  };
}

const full = () => ({
  capacity: 16,
  sample: { availableMb: 8000, cores: 16, load1: 4 },
  usedUnits: 16,
});

test('a start refused for capacity, budget or a held claim leaves every lane store byte-identical', async (t) => {
  const { repo } = startFixture(t);
  const before = snapshot(repo);
  const start = (deps = {}) =>
    startLane(['reused', '--task', 't-abc1234', '--root', repo], deps);

  await assert.rejects(start({ capacity: full }), /lane capacity/u);
  assert.deepEqual(snapshot(repo), before, 'capacity refusal');

  process.env.KRN_LANE_MIN_FREE_GB = '999999999';
  try {
    await assert.rejects(start(), /lane budget/u);
  } finally {
    delete process.env.KRN_LANE_MIN_FREE_GB;
  }
  assert.deepEqual(snapshot(repo), before, 'budget refusal');

  mkdirSync(join(repo, '.krn', 'task-claims'), { recursive: true });
  writeFileSync(join(repo, '.krn', 'task-claims', 't-abc1234.json'), '{torn');
  const held = snapshot(repo);
  await assert.rejects(start(), /task is held/u);
  assert.deepEqual(snapshot(repo), held, 'claim refusal');
});
