import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildIndex,
  indexPath,
  moduleHeader,
} from '../../scripts/claude/capability-index.ts';
import { commandLines } from '../../src/cli/help.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('moduleHeader reads line and block comments and skips a shebang', () => {
  assert.equal(moduleHeader('// One.\n// Two.\nimport x;'), 'One. Two.');
  assert.equal(moduleHeader('#!/usr/bin/env node\n// Run.\ncode'), 'Run.');
  assert.equal(moduleHeader('/** Block.\n * more */\ncode'), 'Block. more');
  assert.equal(moduleHeader('import x;\n// late'), undefined);
});

test('the index lists every src module with its header and every krn command', () => {
  const index = buildIndex(root);
  for (const path of sources(join(root, 'src'))) {
    const name = path.slice(root.length).replace(/^\//u, '');
    const line = index.split('\n').find((row) => row.startsWith(`${name}: `));
    assert.ok(line, `${name} has an index line`);
    const header = moduleHeader(readFileSync(path, 'utf8'));
    if (header) assert.ok(header.startsWith(line.slice(name.length + 2, 60)));
  }
  for (const command of commandLines())
    assert.ok(index.includes(command.split('  ')[0] ?? ''), command);
});

test('the committed index is fresh; run `node scripts/claude/capability-index.ts --write`', () => {
  assert.equal(readFileSync(join(root, indexPath), 'utf8'), buildIndex(root));
});

test('SessionStart replay: a lead that sees .mcp.json in git status finds the sandbox placeholder module in its context', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/claude/capability-index.ts')],
    {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(context.length <= 9500);
  // The lead's grep for the unknown file name hits the documenting module.
  const hit = context.split('\n').filter((row) => row.includes('.mcp.json'));
  assert.ok(
    hit.some((row) => row.startsWith('src/state/sandbox-placeholders.ts: ')),
    hit.join('\n'),
  );
});

test('the lead skill tells the lead to grep the index before calling anything foreign', () => {
  const skill = readFileSync(
    join(root, '.agents/skills/krn-lead/SKILL.md'),
    'utf8',
  );
  assert.match(skill, /capability index/u);
  assert.match(
    skill,
    /before calling anything foreign, unknown or missing[^.]*grep the index and src/u,
  );
});
