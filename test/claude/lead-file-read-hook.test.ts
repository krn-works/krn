import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/lead-file-read.ts', import.meta.url),
);
// Verbatim Claude Code PreToolUse payloads: the lead's carries no agent_id, a subagent's does.
const [lead, subagent] = readFileSync(
  new URL('fixtures/pretooluse-bash-lead-subagent.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .slice(0, -1)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const dir = mkdtempSync(join(tmpdir(), 'lead-file-read-'));
writeFileSync(join(dir, 'big.md'), `${'line of text\n'.repeat(1000)}`);
writeFileSync(join(dir, 'mid.md'), 'line of text\n'.repeat(600));
writeFileSync(join(dir, 'small.md'), 'one\ntwo\n');

const run = (base: Record<string, unknown> | undefined, tool_input: object) =>
  spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify({
      ...base,
      cwd: dir,
      tool_name: 'command' in tool_input ? 'Bash' : 'Read',
      tool_input,
    }),
  });

test('lead file read hook refuses the lead a large file dump', () => {
  for (const command of [
    'cat big.md',
    `cd ${dir} && sed -n '1,200p' big.md`,
    "sed -n '900,$p' big.md",
  ]) {
    const result = run(lead, { command });
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /krn-reader subagent/u, command);
    assert.match(result.stderr, /Nothing in this Bash call ran/u, command);
  }
  const read = run(lead, { file_path: join(dir, 'big.md') });
  assert.equal(read.status, 2);
  assert.match(read.stderr, /13000 bytes/u);
});

test('lead file read hook allows slices, bounded searches, writes and subagents', () => {
  for (const command of [
    'cat small.md',
    "sed -n '1,40p' big.md",
    "sed -n '5p;9p' big.md",
    'cat big.md | wc -l',
    'grep -rl TODO .',
    'grep -rc TODO .',
    'grep -n TODO big.md',
    'rg -l TODO',
    'cat > out.md <<EOF\ncat big.md\nEOF',
    'cat missing.md',
    'cat small.md; cat small.md',
    'cat mid.md; wc -l mid.md; grep -c line mid.md',
    'cat mid.md; echo "exit=$?"',
  ]) {
    const result = run(lead, { command });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  for (const input of [
    { command: 'cat big.md' },
    { file_path: join(dir, 'big.md') },
  ])
    assert.equal(run(subagent, input).status, 0);
  assert.equal(
    run(lead, { file_path: join(dir, 'big.md'), offset: 1, limit: 50 }).status,
    0,
  );
  assert.equal(run(lead, { file_path: join(dir, 'small.md') }).status, 0);
});

test('lead file read hook refuses reads chained past the budget in one call', () => {
  for (const command of [
    'cat mid.md; cat mid.md',
    'cat mid.md && cat mid.md',
    "cat mid.md; sed -n '1,35p' mid.md; sed -n '1,35p' mid.md",
    `cd ${dir} && cat mid.md; cat mid.md`,
  ]) {
    const result = run(lead, { command });
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /chained in this Bash call/u, command);
  }
});

const rewritten = (command: string) => {
  const result = run(lead, { command });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  const out = JSON.parse(result.stdout) as {
    hookSpecificOutput: {
      permissionDecision: string;
      updatedInput: { command: string };
    };
  };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  return out.hookSpecificOutput.updatedInput.command;
};

test('lead file read hook cuts only the over-long read of a compound call', () => {
  assert.equal(
    rewritten('cat small.md big.md; echo done'),
    'cat small.md big.md | head -c 8000; echo done',
  );
  assert.equal(
    rewritten("git status && sed -n '1,200p' big.md && echo ok"),
    "git status && sed -n '1,200p' big.md | head -n 40 && echo ok",
  );
  assert.equal(
    rewritten('echo a; cat big.md; cat small.md'),
    'echo a; cat big.md | head -c 8000; cat small.md',
  );
});

test('lead file read hook gives an unbounded search its bounded form', () => {
  assert.equal(rewritten('grep -rn TODO .'), 'grep -rn TODO . | head -n 200');
  assert.equal(rewritten('rg TODO'), 'rg TODO | head -n 200');
  assert.equal(
    rewritten('cd src && rg TODO && echo done'),
    'cd src && rg TODO | head -n 200 && echo done',
  );
});

test('lead file read hook refuses a repeated over-long stage it cannot cut in place', () => {
  const result = run(lead, { command: 'cat big.md; echo x; cat big.md' });
  assert.equal(result.status, 2);
});
