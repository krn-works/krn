import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  pruneRoadmap,
  roadmapRows,
  taskStatus,
} from '../../scripts/claude/roadmap-prune.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const roadmap = readFileSync(join(root, 'docs/program/roadmap.md'), 'utf8');

// Ids are stable and the table order is the rank, so removing or moving a row
// touches only that row; a row may outlive its task until the lead prunes it.
test('every roadmap row has a unique stable id and an existing task', () => {
  const tableLines = roadmap
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\| (Id|---)/u.test(line));
  const rows = roadmapRows(roadmap);
  assert.equal(
    rows.length,
    tableLines.length,
    'row shape: | R<n> | ... | t-id |',
  );
  const ids = rows.map((row) => row.id);
  assert.deepEqual(ids, [...new Set(ids)], 'duplicate roadmap id');
  const missing = rows
    .filter((row) => taskStatus(root, row.task) === undefined)
    .map((row) => `${row.id}: no task file for ${row.task}`);
  assert.deepEqual(missing, []);
});

test('prune removes only rows whose task is not open', () => {
  const text =
    '| Id | Task |\n|---|---|\n| R1 | a | t-a |\n| R2 | b | t-b |\n| R3 | c | t-c |\n';
  const result = pruneRoadmap(text, (task) =>
    task === 't-b' ? 'open' : 'closed',
  );
  assert.equal(result.text, '| Id | Task |\n|---|---|\n| R2 | b | t-b |\n');
  assert.deepEqual(
    result.removed.map((row) => row.id),
    ['R1', 'R3'],
  );
});

// Replays 2026-11-09: two lanes each close a different roadmap task. With
// positional ids the first removal renumbered every later row and the second
// lane had to rebase; with stable ids the separate removals merge cleanly.
function merge(base: string, ours: string, theirs: string) {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-merge-'));
  try {
    for (const [name, text] of Object.entries({ base, ours, theirs }))
      writeFileSync(join(dir, name), text);
    return spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], {
      cwd: dir,
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const table = (...rows: string[]) =>
  ['| Id | Opportunity | Task |', '|---|---|---|', ...rows, ''].join('\n');

test('two branches removing different rows merge without conflict', () => {
  const base = table(
    '| R1 | a | t-a |',
    '| R2 | b | t-b |',
    '| R3 | c | t-c |',
  );
  const stable = merge(
    base,
    table('| R2 | b | t-b |', '| R3 | c | t-c |'),
    table('| R1 | a | t-a |', '| R2 | b | t-b |'),
  );
  assert.equal(stable.status, 0, stable.stdout);
  assert.equal(stable.stdout, table('| R2 | b | t-b |'));
  // The retired positional scheme: removing R1 renumbered R2 and R3.
  const positional = merge(
    base,
    table('| R1 | b | t-b |', '| R2 | c | t-c |'),
    table('| R1 | a | t-a |', '| R2 | b | t-b |'),
  );
  assert.notEqual(positional.status, 0);
});

test('prune CLI refuses an unknown option with exit 64 and usage', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/claude/roadmap-prune.ts'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown option --help[\s\S]*usage:/u);
  assert.equal(result.stdout, '');
});
