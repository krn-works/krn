import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildIndex,
  indexBudget,
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

test('a synthetic src over budget degrades deterministically within the budget', () => {
  const synthetic = mkdtempSync(join(tmpdir(), 'krn-index-'));
  mkdirSync(join(synthetic, 'src'));
  for (let i = 0; i < 300; i++)
    writeFileSync(
      join(synthetic, 'src', `module-${String(i).padStart(3, '0')}.ts`),
      `// ${'Describes a long capability sentence. '.repeat(6)}\nexport const x = 1;\n`,
    );
  const index = buildIndex(synthetic);
  assert.ok(index.length <= indexBudget, String(index.length));
  assert.equal(index, buildIndex(synthetic));
  assert.ok(index.includes('module-000.ts: Describes'));
  assert.ok(index.includes('(more modules: grep src)'));
});

test('a repository slightly over budget shortens module lines and keeps every module', () => {
  const synthetic = mkdtempSync(join(tmpdir(), 'krn-index-'));
  mkdirSync(join(synthetic, 'src'));
  for (let i = 0; i < 40; i++)
    writeFileSync(
      join(synthetic, 'src', `m${i}.ts`),
      `// ${'word '.repeat(40)}\nexport const x = 1;\n`,
    );
  const roomy = buildIndex(synthetic, 1e9);
  const index = buildIndex(synthetic, roomy.length - 200);
  assert.ok(index.length <= roomy.length - 200);
  for (let i = 0; i < 40; i++) assert.ok(index.includes(`src/m${i}.ts: `));
});

test('the committed index fits the SessionStart budget whole', () => {
  assert.ok(readFileSync(join(root, indexPath), 'utf8').length <= indexBudget);
});
