import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clausesFromBrief } from '../../evals/d23/clauses.ts';

const script = fileURLToPath(
  new URL('../../evals/d23/clauses.ts', import.meta.url),
);

const task =
  'Task t-abc1234: Do the thing\n\nOutcome: the parser accepts a bare list. (1) It rejects an empty list. (2) It keeps order of items.\n';
const iface =
  '\n\nInterface the acceptance tests use (keep these module paths and export names):\n- `src/x.ts` exports `parseList`\n';

test('clauses come from the brief words only, never from the appended interface paragraph', () => {
  const text = clausesFromBrief(task + iface);
  assert.match(text, /^Acceptance clauses \(cover every one\):/u);
  assert.match(text, /1\. It rejects an empty list\./u);
  assert.match(text, /2\. It keeps order of items\./u);
  assert.doesNotMatch(text, /parseList/u);
});

test('a body with under two clauses asks the worker to write its own', () => {
  const text = clausesFromBrief('Task t-abc1234: x\n\nFix the bug.\n');
  assert.match(text, /^Acceptance clauses \(write them first\):/u);
});

test('the command prints the section for a task text file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd23-clauses-'));
  try {
    const file = join(dir, 'task.txt');
    writeFileSync(file, task + iface);
    const r = spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1\. It rejects an empty list\./u);
    assert.equal(spawnSync(process.execPath, [script]).status, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
