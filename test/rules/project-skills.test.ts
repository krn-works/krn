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

test('the lead loop skills name the real launch command', () => {
  assert.match(
    skill('krn-handoff'),
    /node scripts\/claude\/successor-launch\.ts --name "[^"]+" --model claude-opus-5-5 --effort medium --prompt /u,
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
    readFileSync(join(root, 'README.md'), 'utf8'),
  ];
  for (const text of shipping) {
    assert.doesNotMatch(text, /gh pr merge[^`\n]*--merge/u);
    assert.doesNotMatch(text, /gh pr merge[^`\n]*--rebase/u);
  }
  assert.match(skill('krn-lead'), /krn pr ship/u);
  assert.match(skill('krn-retro'), /krn task create/u);
});

function frontmatter(path: string): Map<string, string> {
  const text = readFileSync(join(root, path), 'utf8');
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  assert.ok(block, `${path} needs frontmatter`);
  return new Map(
    (block[1] ?? '').split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

// Claude Code skips an agent file without a description: krn-reader went
// missing from every session's agent list until 2026-11-09.
test('every project agent has a name and a description', () => {
  for (const file of readdirSync(join(root, '.claude/agents'))) {
    const fields = frontmatter(`.claude/agents/${file}`);
    assert.equal(fields.get('name'), file.replace(/\.md$/u, ''), file);
    assert.ok(fields.get('description'), `${file} needs a description`);
  }
});

test('read-only agents cap their turns so a recon lane cannot grow its context unbounded', () => {
  for (const file of ['krn-reader', 'krn-research', 'krn-lane', 'krn-radar']) {
    const turns = Number(
      frontmatter(`.claude/agents/${file}.md`).get('maxTurns'),
    );
    assert.ok(turns > 0 && turns <= 90, `${file} needs maxTurns of 90 or less`);
  }
});

test('research lanes read untrusted content without a shell, file writes or sub-agents', () => {
  const fields = frontmatter('.claude/agents/krn-research.md');
  assert.equal(fields.get('name'), 'krn-research');
  assert.ok(fields.get('model'), 'krn-research needs an explicit model');
  const tools = (fields.get('tools') ?? '')
    .split(',')
    .map((tool) => tool.trim());
  assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
  for (const banned of ['Agent', 'Task', 'Bash', 'Edit', 'MultiEdit', 'Write'])
    assert.ok(!tools.includes(banned), `krn-research must not get ${banned}`);
  const lanes = readFileSync(
    join(root, '.agents/skills/krn-lead/lanes.md'),
    'utf8',
  );
  assert.match(lanes, /`krn-research`/u);
  assert.match(lanes, /bin\/krn ci wait --repo/u);
  assert.doesNotMatch(lanes, /every 60s/u);
});

test('the radar agent is read-only, bounded, named by the roadmap, and rss_news stays denied', () => {
  const fields = frontmatter('.claude/agents/krn-radar.md');
  assert.ok(fields.get('model'), 'krn-radar needs an explicit model');
  assert.ok(Number(fields.get('maxTurns')) > 0);
  const tools = (fields.get('tools') ?? '')
    .split(',')
    .map((tool) => tool.trim());
  assert.deepEqual(tools, ['Bash', 'Read', 'Grep']);
  for (const banned of ['Edit', 'Write', 'Agent'])
    assert.ok(!tools.includes(banned), `krn-radar must not get ${banned}`);
  assert.match(
    readFileSync(join(root, 'docs/program/roadmap.md'), 'utf8'),
    /`krn-radar`/u,
  );
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as { deniedMcpServers: { serverName: string }[] };
  assert.ok(settings.deniedMcpServers.some((s) => s.serverName === 'rss_news'));
});
