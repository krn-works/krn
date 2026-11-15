// fast-covers: src/brain/task-quality.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TASK_RULES } from '../../src/brain/task-quality.ts';

// KRN-12: runs the real `krn standards` entry on scratch trackers, KRN's own tasks and an init skeleton.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const own = fileURLToPath(new URL('../..', import.meta.url));

function krn(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

const GOOD = [
  'Outcome: `krn foo` exits 0 and prints 3 lines.',
  'Files: src/foo.ts',
  'Proof: test/foo.test.ts passes and the output is checked.',
];

/** A scratch repository holding the plainest hand-written task records. */
function tracker(
  tasks: Record<string, Partial<Record<string, unknown>>>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-taskq-'));
  mkdirSync(join(root, 'tasks'));
  spawnSync('git', ['init', '-q', root]);
  for (const [id, fields] of Object.entries(tasks))
    writeFileSync(
      join(root, 'tasks', `${id}.json`),
      `${JSON.stringify({ id, status: 'open', resolution: null, created: '2026-11-15', priority: 2, title: 'T', after: [], body: GOOD, ...fields }, null, 2)}\n`,
    );
  return root;
}

function rule(root: string, name: string) {
  return krn('standards', 'task-quality', '--rule', name, '--root', root);
}

const RED: [string, Record<string, unknown>, RegExp][] = [
  [
    'measurable-outcome',
    { body: ['Outcome: make it nicer', GOOD[1], GOOD[2]] },
    /no measurable "Outcome:"/u,
  ],
  ['named-proof', { body: [GOOD[0], GOOD[1]] }, /no "Proof:" line/u],
  [
    'named-files',
    { body: [GOOD[0], 'Proof: the output is checked by hand.'] },
    /names no file/u,
  ],
  ['one-pr', { body: [...GOOD, 'Size: 3 PRs'] }, /more than one PR/u],
  [
    'declared-dependencies',
    { body: [...GOOD, 'After: t-abcdefg'], after: [] },
    /names t-abcdefg/u,
  ],
  [
    'close-evidence',
    {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    },
    /without evidence/u,
  ],
];

for (const [name, fields, message] of RED) {
  test(`task rule ${name} is red on a violating task and green on a good one`, () => {
    const red = rule(tracker({ 't-redred1': fields }), name);
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, message);
    assert.match(red.stdout, new RegExp(`FAIL task-quality ${name}`, 'u'));
    const green = rule(tracker({ 't-green01': {} }), name);
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });
}

test('a done close with a note, or a pre-rule record, is green', () => {
  const root = tracker({
    't-closed1': {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: 'test/foo.test.ts passes' },
    },
    't-old0001': {
      status: 'closed',
      created: '2026-10-26',
      resolution: { kind: 'done', ref: null, note: '' },
    },
  });
  assert.equal(rule(root, 'close-evidence').status, 0);
});

test('a dependency declared in after is green, and an unknown after id is red', () => {
  const ok = tracker({
    't-dep0001': {},
    't-main001': { body: [...GOOD, 'After: t-dep0001'], after: ['t-dep0001'] },
  });
  assert.equal(rule(ok, 'declared-dependencies').status, 0);
  const dangling = tracker({ 't-main001': { after: ['t-gone001'] } });
  assert.equal(rule(dangling, 'declared-dependencies').status, 1);
});

test('an unknown rule is a usage error', () => {
  const run = rule(tracker({}), 'nonsense');
  assert.equal(run.status, 64, run.stderr);
});

test('KRN own tasks pass every task rule: zero false-red', () => {
  for (const name of TASK_RULES) {
    const run = rule(own, name);
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
});

test('init seeds tasks that pass every task-quality record', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-taskq-init-'));
  const init = krn('adopt', root, '--init', '--stack', 'go', '--no-canary');
  assert.equal(init.status, 0, init.stderr + init.stdout);
  for (const name of TASK_RULES) {
    const run = rule(root, name);
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
  const check = krn('standards', 'check', '--tasks', '--root', root);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.doesNotMatch(check.stderr, /^task: /mu);
});

test('the pack holds at least six enforced task-quality records, each naming a rule', () => {
  const pack = JSON.parse(
    readFileSync(join(own, 'standards/records.json'), 'utf8'),
  ) as { area?: string; enforcement: { kind: string; args?: string[] } }[];
  const quality = pack.filter(
    (r) => r.area === 'task-quality' && r.enforcement.kind !== 'advisory',
  );
  assert.ok(quality.length >= 6, `${quality.length}`);
  const named = new Set(
    quality.flatMap((r) => r.enforcement.args?.slice(3) ?? []),
  );
  for (const name of TASK_RULES) assert.ok(named.has(name), name);
});

test('a task-quality record fails `krn standards check --record` on a violating tracker', () => {
  const root = tracker({ 't-redred1': { body: ['Outcome: nicer'] } });
  writeFileSync(join(root, 'krn.json'), '{"test":"true","tracker":"krn"}\n');
  const run = krn(
    'standards',
    'check',
    '--record',
    's-task-named-proof',
    '--root',
    root,
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /s-task-named-proof/u);
});
