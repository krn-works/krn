import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const skillsRoot = join(root, '.agents', 'skills');
const expected = ['krn-handoff', 'krn-lead', 'krn-retro'];

function skill(name: string): string {
  return readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
}

test('the lead loop skills are the project skills for Codex and Claude Code', () => {
  assert.deepEqual(readdirSync(skillsRoot).sort(), expected);
  const link = join(root, '.claude', 'skills');
  assert.ok(lstatSync(link).isSymbolicLink(), '.claude/skills must be a link');
  assert.equal(readlinkSync(link), '../.agents/skills');
  for (const name of expected) {
    const text = skill(name);
    const front = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/u.exec(
      text,
    );
    assert.ok(front, `${name} needs name and description frontmatter`);
    assert.equal(front[1], name);
    assert.ok(
      (front[2] ?? '').length > 40,
      `${name} needs a descriptive trigger`,
    );
  }
});

test('the lead loop skills name only current commands and flags', () => {
  const review = readFileSync(join(root, 'src', 'flow', 'cli.ts'), 'utf8');
  const all = expected.map(skill).join('\n');
  for (const stale of [
    /--issue\b/u,
    /--revision\b/u,
    /--submit\b/u,
    /krn work\b/u,
    /install-release\.sh/u,
  ])
    assert.doesNotMatch(all, stale);
  const lead = skill('krn-lead');
  for (const flag of lead
    .match(/krn review [^`\n]+/gu)
    ?.join(' ')
    .match(/--[a-z-]+/gu) ?? [])
    assert.ok(review.includes(flag), `krn review usage lacks ${flag}`);
  assert.match(lead, /krn review --repo <path> --pr <n>/u);
  assert.match(
    skill('krn-handoff'),
    /node scripts\/claude\/successor-launch\.ts --name "[^"]+" --prompt /u,
  );
});
