import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

interface TaskRecord {
  id: string;
  status: string;
  body: string[];
}

function openTrapIds(): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(join(root, 'tasks')).filter((file) =>
    file.endsWith('.json'),
  )) {
    const task = JSON.parse(read(join('tasks', name))) as TaskRecord;
    if (
      task.status === 'open' &&
      task.body.some((entry) => /^Lead trap: /mu.test(entry))
    )
      ids.push(task.id);
  }
  return ids.sort();
}

function section(
  text: string,
  heading: string,
): { body: string; rest: string } {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the lead skill needs a "## ${heading}" section`);
  const after = text.indexOf('\n## ', start + 1);
  const end = after === -1 ? text.length : after;
  return {
    body: text.slice(start, end),
    rest: text.slice(0, start) + text.slice(end),
  };
}

test('the lead skill lists exactly the open tasks tagged as lead traps', () => {
  const lead = read('.agents/skills/krn-lead/SKILL.md');
  const { body, rest } = section(lead, 'Open traps');
  const listed = [...body.matchAll(/\bt-[0-9a-z]{7}\b/gu)]
    .map((match) => match[0])
    .sort();
  const tagged = openTrapIds();
  assert.ok(
    tagged.length > 0,
    'at least one open task is tagged as a lead trap',
  );
  assert.deepEqual(listed, tagged);
  // Every listed trap is steered around where the lead acts, not only listed.
  for (const id of tagged)
    assert.ok(rest.includes(id), `${id} needs a workaround in the lead loop`);
});

test('a trap lesson patches the steering instruction in the same slice', () => {
  const retro = read('.agents/skills/krn-retro/SKILL.md');
  assert.ok(retro.includes('Lead trap:'));
  assert.ok(retro.includes('in the same slice'));
  assert.ok(retro.includes('"Open traps"'));
});
