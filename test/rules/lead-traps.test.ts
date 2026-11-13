import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

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

test('the open traps section is either "none" or a list of ids that each have a workaround in the lead loop', () => {
  const lead = read('.agents/skills/krn-lead/SKILL.md');
  const { body, rest } = section(lead, 'Open traps');
  const ids = [...body.matchAll(/\bt-[0-9a-z]{7}\b/gu)].map(
    (match) => match[0],
  );
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (ids.length === 0 && !lines.some((line) => line === 'none'))
    assert.fail('an empty "Open traps" section must say `none`');
  // Every listed trap is steered around where the lead acts, not only listed.
  for (const id of new Set(ids))
    assert.ok(rest.includes(id), `${id} needs a workaround in the lead loop`);
});
