// The lead surfaces state the one lane limit of the lane budget and one delivery path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(`${root}${file}`, 'utf8');
const files = [
  'docs/program/lead-rules.md',
  '.claude/skills/krn-lead/SKILL.md',
  '.claude/skills/krn-lead/lanes.md',
];
const words = 'one two three four five six seven eight nine ten twelve';
const limitLine = /\b(at most|maximum|cap of|at once|live worktrees?)\b/i;

function budgetLimit(): number {
  const match = /limit\('KRN_LANE_MAX_LIVE', (\d+)\)/.exec(
    read('src/cli/lane.ts'),
  );
  assert.ok(match?.[1], 'lane budget limit not found in src/cli/lane.ts');
  return Number(match[1]);
}

test('lead surfaces state only the lane budget limit', () => {
  const limit = budgetLimit();
  const named = new Set<number>();
  for (const file of files)
    for (const line of read(file).split('\n')) {
      if (!limitLine.test(line) || !/\b(lanes?|worktrees?)\b/i.test(line))
        continue;
      for (const [, token = ''] of line.matchAll(
        /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b(?= (?:lead |live )?(?:lanes?|worktrees?|deliveries))/gi,
      )) {
        const index = words.split(' ').indexOf(token.toLowerCase());
        named.add(index >= 0 ? index + (index > 9 ? 2 : 1) : Number(token));
      }
    }
  assert.deepEqual([...named], [limit], 'one lane limit, the lane budget');
});

test('lead surfaces never merge with gh pr merge', () => {
  for (const file of files)
    assert.doesNotMatch(read(file), /gh pr merge/, file);
});
