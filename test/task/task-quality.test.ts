// fast-covers: src/task/quality.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allTaskQualityFailures,
  TASK_RULES,
  type TaskRule,
  taskQualityFailures,
} from '../../src/task/quality.ts';

// KRN-12: runs the real `krn standards` entry on scratch trackers, KRN's own tasks and an init skeleton.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const own = fileURLToPath(new URL('../..', import.meta.url));

function krn(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
  });
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
    const red = taskQualityFailures(
      tracker({ 't-redred1': fields }),
      name as TaskRule,
    );
    assert.match(red.join('\n'), message);
    assert.deepEqual(
      taskQualityFailures(tracker({ 't-green01': {} }), name as TaskRule),
      [],
    );
  });
}

test('krn task check fails on a violating record and names the rule finding', () => {
  const run = krn(
    tracker({ 't-redred1': { body: ['Outcome: make it nicer', GOOD[1]] } }),
    'task',
    'check',
    '--quality',
  );
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr + run.stdout, /no measurable "Outcome:"/u);
  const green = krn(tracker({ 't-green01': {} }), 'task', 'check', '--quality');
  assert.equal(green.status, 0, green.stdout + green.stderr);
});

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
  assert.deepEqual(taskQualityFailures(root, 'close-evidence'), []);
});

test('a dependency declared in after is green, and an unknown after id is red', () => {
  const ok = tracker({
    't-dep0001': {},
    't-main001': { body: [...GOOD, 'After: t-dep0001'], after: ['t-dep0001'] },
  });
  assert.deepEqual(taskQualityFailures(ok, 'declared-dependencies'), []);
  const dangling = tracker({ 't-main001': { after: ['t-gone001'] } });
  assert.equal(
    taskQualityFailures(dangling, 'declared-dependencies').length,
    1,
  );
});

test('an after id that lives only in the task archive is not unknown', () => {
  const root = tracker({
    't-main001': { body: [...GOOD, 'After: t-arch001'], after: ['t-arch001'] },
  });
  mkdirSync(join(root, 'tasks', 'archive'));
  writeFileSync(
    join(root, 'tasks', 'archive', '2026-11.jsonl'),
    `${JSON.stringify({ id: 't-arch001', status: 'closed', resolution: { kind: 'done', ref: null, note: '' }, created: '2026-11-01', priority: 2, title: 'T', after: [], body: GOOD })}\n`,
  );
  assert.deepEqual(taskQualityFailures(root, 'declared-dependencies'), []);
});

test('KRN own tasks pass every task rule: zero false-red', () => {
  assert.deepEqual(allTaskQualityFailures(own), []);
  const run = krn(own, 'task', 'check', '--quality');
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('init seeds tasks that pass every task-quality rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-taskq-init-'));
  const init = krn(
    own,
    'adopt',
    root,
    '--init',
    '--stack',
    'go',
    '--no-canary',
  );
  assert.equal(init.status, 0, init.stderr + init.stdout);
  assert.deepEqual(allTaskQualityFailures(root), []);
});

test('the standards pack holds no task-quality record: the rules live in krn task check', () => {
  const pack = JSON.parse(
    readFileSync(join(own, 'standards/records.json'), 'utf8'),
  ) as { area?: string }[];
  assert.deepEqual(
    pack.filter((r) => r.area === 'task-quality'),
    [],
  );
  assert.equal(TASK_RULES.length, 6);
});

test('allTaskQualityFailures names a vague open task and passes a measured one (npm run lint gate)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lint-quality-'));
  try {
    mkdirSync(join(root, 'tasks'));
    const task = (body: string[]) =>
      JSON.stringify({
        id: 't-lint000',
        title: 'Lint gate',
        status: 'open',
        priority: 2,
        created: '2026-11-15',
        after: [],
        body,
      });
    writeFileSync(
      join(root, 'tasks', 't-lint000.json'),
      task(['Outcome: it is better.']),
    );
    assert.ok(
      allTaskQualityFailures(root).some((f) =>
        /no measurable "Outcome:"/u.test(f),
      ),
    );
    writeFileSync(
      join(root, 'tasks', 't-lint000.json'),
      task([
        'Outcome: krn task check exits 0.',
        'Files: src/task/cli.ts.',
        'Proof: the task command test passes.',
      ]),
    );
    assert.deepEqual(allTaskQualityFailures(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('krn task check ignores the quality rules unless --quality is given, and takes it once', () => {
  const root = tracker({
    't-redred1': { body: ['Outcome: make it nicer', GOOD[1], GOOD[2]] },
  });
  const plain = krn(root, 'task', 'check');
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  const strict = krn(root, 'task', 'check', '--quality');
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /t-redred1: no measurable/u);
  const twice = krn(root, 'task', 'check', '--quality', '--quality');
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /--quality may be supplied once/u);
});
