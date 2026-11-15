// fast-covers: src/adopt/first-turn.ts, src/adopt/unused.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_TOKENS } from '../../src/adopt/first-turn.ts';

// KRN-12: transcript lines in the plain Claude Code shape (assistant message, tool_use block) are read by the real CLI.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

const call = (name: string, input: object = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg_${name}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    },
  });

function project(sessions: string[][]) {
  const root = mkdtempSync(join(tmpdir(), 'krn-prune-'));
  mkdirSync(join(root, '.claude/skills/used-skill'), { recursive: true });
  mkdirSync(join(root, '.claude/skills/idle-skill'), { recursive: true });
  writeFileSync(
    join(root, '.claude/skills/used-skill/SKILL.md'),
    '---\nname: used-skill\ndescription: a skill the sessions call\n---\nbody\n',
  );
  writeFileSync(
    join(root, '.claude/skills/idle-skill/SKILL.md'),
    '---\nname: idle-skill\ndescription: a skill no session calls\n---\nbody\n',
  );
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { live: {}, idle: {} } }),
  );
  const transcripts = join(root, 'transcripts');
  mkdirSync(transcripts);
  sessions.forEach((lines, i) => {
    const file = join(transcripts, `s${i}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    utimesSync(file, 1000 + i, 1000 + i);
  });
  return { root, transcripts };
}

const used = [
  call('mcp__live__search', { q: 'x' }),
  call('Skill', { skill: 'used-skill' }),
  call('Bash', { command: 'true' }),
];

function run(root: string, transcripts: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [cli, ...args, '--transcripts', transcripts],
    { encoding: 'utf8', cwd: root },
  );
}
const ledger = (root: string, transcripts: string) =>
  run(root, transcripts, 'ledger', '--unused', '--root', root);
const prune = (root: string, transcripts: string) =>
  run(root, transcripts, 'adopt', root, '--prune-unused');

test('clause 4 and 8: ledger --unused reads transcripts and lists the server and skill with 0 calls', () => {
  const { root, transcripts } = project([used, used]);
  const out = ledger(root, transcripts);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /unused MCP server idle: 0 calls in 2 sessions/u);
  assert.match(out.stdout, /unused skill idle-skill: 0 calls in 2 sessions/u);
  assert.doesNotMatch(out.stdout, /live|used-skill/u);
});

test('clause 5 and 7: the report names the token weight and the total saving', () => {
  const { root, transcripts } = project([used, used]);
  const out = ledger(root, transcripts).stdout;
  assert.match(
    out,
    new RegExp(`MCP server idle: .*~${MCP_SERVER_TOKENS} tokens`, 'u'),
  );
  const skill = /unused skill idle-skill: .*~(\d+) tokens/u.exec(out)?.[1];
  assert.ok(Number(skill) > 0);
  assert.match(
    out,
    new RegExp(
      `unused total: ~${MCP_SERVER_TOKENS + Number(skill)} tokens`,
      'u',
    ),
  );
});

test('clause 4: one session is too few to call anything unused', () => {
  const { root, transcripts } = project([used]);
  const out = ledger(root, transcripts).stdout;
  assert.match(out, /1 session\(s\) read, at least 2 needed/u);
  assert.doesNotMatch(out, /unused MCP server/u);
});

test('clause 6: the saving is an estimate, never a percentage claim', () => {
  const { root, transcripts } = project([used, used]);
  const out = ledger(root, transcripts).stdout;
  assert.match(out, /a flat estimate/u);
  assert.doesNotMatch(out, /%/u);
});

test('clause 9: nothing is disabled without the flag', () => {
  const { root, transcripts } = project([used, used]);
  ledger(root, transcripts);
  run(root, transcripts, 'adopt', root, '--verify');
  assert.throws(() => readFileSync(join(root, '.claude/settings.json')));
});

test('clause 7 and 9: the flag writes the disable entries and keeps the other settings', () => {
  const { root, transcripts } = project([used, used]);
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ model: 'x', permissions: { deny: ['Bash(rm *)'] } }),
  );
  const out = prune(root, transcripts);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /disabled disabledMcpjsonServers: idle/u);
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  );
  assert.deepEqual(settings.disabledMcpjsonServers, ['idle']);
  assert.deepEqual(settings.permissions.deny, [
    'Bash(rm *)',
    'Skill(idle-skill)',
  ]);
  assert.equal(settings.model, 'x');
});

test('clause 10: a rerun changes nothing', () => {
  const { root, transcripts } = project([used, used]);
  prune(root, transcripts);
  const first = readFileSync(join(root, '.claude/settings.json'), 'utf8');
  const again = prune(root, transcripts);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /disabled /u);
  assert.equal(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    first,
  );
});
