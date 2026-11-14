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
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evidenceLine,
  generateRoadmap,
  roadmapRows,
  taskStatus,
} from '../../src/repo/roadmap.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/claude/roadmap-prune.ts');

test('every roadmap row names an existing task', () => {
  const roadmap = readFileSync(join(root, 'docs/program/roadmap.md'), 'utf8');
  const tableLines = roadmap
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\| (Task|---)/u.test(line));
  const rows = roadmapRows(roadmap);
  assert.equal(rows.length, tableLines.length, 'row shape: | t-id | ... |');
  const ids = rows.map((row) => row.task);
  assert.deepEqual(ids, [...new Set(ids)], 'duplicate roadmap row');
  const missing = rows
    .filter((row) => taskStatus(root, row.task) === undefined)
    .map((row) => `no task file for ${row.task}`);
  assert.deepEqual(missing, []);
});

const task = (
  id: string,
  priority: number,
  status = 'open',
  body = [`Why: evidence for ${id}\nOutcome: x`],
) => ({ id, status, priority, title: `title ${id}`, body });

test('the roadmap lists only open tasks ranked by priority then id with the Why line', () => {
  const text = generateRoadmap([
    task('t-ccccccc', 3),
    task('t-bbbbbbb', 2, 'closed'),
    task('t-aaaaaaa', 3),
    task('t-ddddddd', 1),
  ]);
  assert.deepEqual(
    roadmapRows(text).map((row) => row.task),
    ['t-ddddddd', 't-aaaaaaa', 't-ccccccc'],
  );
  assert.match(
    text,
    /\| t-ddddddd \| 1 \| title t-ddddddd \| evidence for t-ddddddd \|/u,
  );
  assert.doesNotMatch(text, /t-bbbbbbb/u);
});

test('the roadmap stays under its context budget at 100 open tasks and counts the rest', () => {
  const budget = JSON.parse(
    readFileSync(join(root, 'spec/context-budget.json'), 'utf8'),
  ).files['docs/program/roadmap.md'] as number;
  const long = 'x'.repeat(400);
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    ...task(`t-${String(index).padStart(7, '0')}`, (index % 3) + 1, 'open', [
      `Why: ${long}`,
    ]),
    title: long,
  }));
  const text = generateRoadmap(tasks);
  assert.ok(
    Buffer.byteLength(text) <= budget,
    `${Buffer.byteLength(text)} > ${budget}`,
  );
  const shown = roadmapRows(text).length;
  assert.ok(shown > 0 && shown < 100);
  assert.match(
    text,
    new RegExp(`\\n${100 - shown} more open task\\(s\\) are not shown`, 'u'),
  );
  assert.ok(roadmapRows(text).every((row) => row.line.includes('| 1 |')));
});

test('a task waiting on an open task ranks after its ready peers', () => {
  const text = generateRoadmap([
    { ...task('t-aaaaaaa', 1), after: ['t-ccccccc'] },
    task('t-bbbbbbb', 1),
    task('t-ccccccc', 2),
    { ...task('t-ddddddd', 1), after: ['t-eeeeeee'] },
    task('t-eeeeeee', 1, 'closed'),
  ]);
  assert.deepEqual(
    roadmapRows(text).map((row) => row.task),
    ['t-bbbbbbb', 't-ddddddd', 't-aaaaaaa', 't-ccccccc'],
  );
  assert.doesNotMatch(text, /not shown/u);
});

test('an evidence line is one table cell', () => {
  assert.equal(
    evidenceLine({ id: 't-a', body: ['Why: a | b\nOutcome: c'] }),
    'a / b',
  );
  assert.equal(evidenceLine({ id: 't-a', body: ['Outcome: c'] }), '');
});

// Two lanes closing different tasks never edit the file; regeneration is one
// deterministic output, so the same tasks always give the same bytes.
test('generation is deterministic', () => {
  const tasks = [task('t-aaaaaaa', 2), task('t-bbbbbbb', 1)];
  assert.equal(generateRoadmap(tasks), generateRoadmap([...tasks].reverse()));
});

test('prune CLI writes the roadmap, --check reports in-sync or drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-cli-'));
  try {
    mkdirSync(join(dir, 'tasks'));
    mkdirSync(join(dir, 'docs/program'), { recursive: true });
    writeFileSync(
      join(dir, 'tasks/t-aaaaaaa.json'),
      JSON.stringify(task('t-aaaaaaa', 2)),
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args, dir], {
        encoding: 'utf8',
      });
    const drift = run('--check');
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /out of sync/u);
    assert.equal(run().status, 0);
    const synced = run('--check');
    assert.equal(synced.status, 0);
    assert.match(synced.stdout, /in-sync/u);
    writeFileSync(
      join(dir, 'tasks/t-aaaaaaa.json'),
      JSON.stringify(task('t-aaaaaaa', 2, 'closed')),
    );
    assert.equal(run('--check').status, 1);
    assert.equal(run().status, 0);
    assert.doesNotMatch(
      readFileSync(join(dir, 'docs/program/roadmap.md'), 'utf8'),
      /t-aaaaaaa/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prune CLI refuses an unknown option with exit 64 and usage', () => {
  const result = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown option --help[\s\S]*usage:/u);
  assert.equal(result.stdout, '');
});
