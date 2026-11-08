import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const skillsRoot = join(root, '.agents', 'skills');
const expected = [
  'architecture',
  'krn-handoff',
  'krn-lead',
  'krn-retro',
  'typescript',
];

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

test('the lead loop skills name only existing review flags and the real launch command', () => {
  const review = readFileSync(join(root, 'src', 'flow', 'cli.ts'), 'utf8');
  const lead = skill('krn-lead');
  for (const flag of lead
    .match(/krn review [^`\n]+/gu)
    ?.join(' ')
    .match(/--[a-z-]+/gu) ?? [])
    assert.ok(review.includes(flag), `krn review usage lacks ${flag}`);
  assert.match(lead, /krn review --repo <path> --base <sha> --head <sha>/u);
  assert.match(
    skill('krn-handoff'),
    /node scripts\/claude\/successor-launch\.ts --name "[^"]+" --model claude-opus-5-5 --effort medium --prompt /u,
  );
  assert.match(
    skill('krn-handoff'),
    /detects the harness the lead is running in from the runtime environment/u,
  );
});

test('every slice ships as one squash-merged PR with the template sections and its retro inside', () => {
  const template = readFileSync(
    join(root, '.github', 'pull_request_template.md'),
    'utf8',
  );
  for (const section of ['Problem', 'Change', 'Verification', 'Task'])
    assert.match(template, new RegExp(`^## ${section}$`, 'mu'));
  assert.match(template, /^Agent:/mu);
  const shipping = [
    skill('krn-lead'),
    readFileSync(join(skillsRoot, 'krn-lead', 'lanes.md'), 'utf8'),
    readFileSync(join(root, 'docs', 'program', 'lead-rules.md'), 'utf8'),
    readFileSync(
      join(root, 'docs', 'program', 'repository-workflow.md'),
      'utf8',
    ),
    readFileSync(join(root, 'docs', 'program', 'PLAN.md'), 'utf8'),
    readFileSync(join(root, 'README.md'), 'utf8'),
  ];
  for (const text of shipping) {
    assert.doesNotMatch(text, /gh pr merge[^`\n]*--merge/u);
    assert.doesNotMatch(text, /gh pr merge[^`\n]*--rebase/u);
  }
  assert.match(skill('krn-lead'), /gh pr merge <n> --auto --squash/u);
  assert.match(skill('krn-retro'), /never open a separate retro PR/u);
});
