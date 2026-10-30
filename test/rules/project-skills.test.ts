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
  assert.match(skill('krn-handoff'), /claude --bg -n /u);
});

test('handoffs choose the active harness and keep native Codex sessions resumable', () => {
  const handoff = skill('krn-handoff');
  for (const requirement of [
    /Select the active harness from runtime context, never from executable presence/iu,
    /mcp__codex_tui__create_thread/u,
    /descriptive title and a prompt containing only handoff\/task pointers/iu,
    /omit the model/iu,
    /verify the repository cwd is inherited/iu,
    /fresh `threadId`/u,
    /never fork/iu,
    /Start only an operator-authorized task/iu,
    /report an unsupported/iu,
    /do not silently launch Claude or invent a background flag/iu,
    /retain the current owner/iu,
    /reconcile .* before retrying/iu,
    /stops writing/iu,
    /verified same-server command .*codex --remote <observed endpoint> resume <returned threadId>/u,
    /codex agents --remote <observed endpoint>/u,
    /never infer it from `sessionId`/iu,
    /thread\.id/iu,
    /Never hardcode this host's endpoint globally, expose tokens/iu,
    /claim automatic UI switching/iu,
    /exec --json/iu,
    /runtime owner still must demonstrate a real/iu,
  ])
    assert.match(handoff, requirement);
});

test('lead context policy thresholds are not presented as the native model window', () => {
  const lead = skill('krn-lead');
  assert.match(
    lead,
    /120k or 160k.*policy thresholds are not the native model context window/iu,
  );
  assert.match(lead, /state `unknown` when its measurement is unavailable/iu);
  assert.doesNotMatch(lead, /120k and 160k of 200k/iu);
});
