import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The roadmap says "A row leaves the table when its task closes"; a closed
// task's row survived #466 unnoticed, so the rule is checked here.
test('every roadmap row names an existing open task', () => {
  const roadmap = readFileSync(join(root, 'docs/program/roadmap.md'), 'utf8');
  const rows = roadmap
    .split('\n')
    .filter((line) => /^\| \d+ \| R\d+ \|/u.test(line));
  const stale: string[] = [];
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    const id = cells.at(-2) ?? '';
    const path = join(root, 'tasks', `${id}.json`);
    if (!/^t-[a-z0-9]+$/u.test(id) || !existsSync(path)) {
      stale.push(`${cells[2]}: no task file for "${id}"`);
      continue;
    }
    const task = JSON.parse(readFileSync(path, 'utf8')) as { status: string };
    if (task.status !== 'open')
      stale.push(`${cells[2]}: ${id} is ${task.status}`);
  }
  assert.deepEqual(stale, []);
});
