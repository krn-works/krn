import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const skills = readdirSync(join(root, '.agents', 'skills')).flatMap((name) =>
  readdirSync(join(root, '.agents', 'skills', name))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `.agents/skills/${name}/${file}`),
);
const documents = [
  'AGENTS.md',
  'docs/program/lead-rules.md',
  'docs/program/repository-workflow.md',
  '.claude/agents/krn-reader.md',
  ...skills,
];
// Pages that instructions name only to say KRN no longer creates them.
const retired = new Set(['docs/research/workflow-lessons.md']);
// `state` belongs to the global KRN install; `work` is named only as replaced.
const elsewhere = new Set(['state', 'work']);

function spans(): { file: string; text: string }[] {
  return documents.flatMap((file) =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/`([^`\n]+)`/gu)].map(
      (match) => ({ file, text: match[1] ?? '' }),
    ),
  );
}

test('instructions name only npm scripts and repository files that exist', () => {
  const scripts = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const missing: string[] = [];
  for (const { file, text } of spans()) {
    for (const match of text.matchAll(/npm run ([\w:-]+)/gu))
      if (!(match[1] ?? '') || !((match[1] as string) in scripts))
        missing.push(`${file}: npm run ${match[1]}`);
    for (const match of text.matchAll(
      /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]*\.[a-z]{1,4})(?=$|[\s):,;])/gu,
    )) {
      const path = match[1] ?? '';
      if (path.startsWith('.krn/') || retired.has(path)) continue;
      if (!existsSync(join(root, path))) missing.push(`${file}: ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('instructions name only krn commands the CLI owns', () => {
  const help = execFileSync('node', ['src/cli/main.ts', '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  const owned = new Set(
    [...help.matchAll(/^ {2}krn ([a-z-]+)/gmu)].map((match) => match[1]),
  );
  assert.ok(owned.has('task'));
  const unknown: string[] = [];
  for (const { file, text } of spans())
    for (const match of text.matchAll(/(?:^|[\s(])(?:bin\/)?krn ([a-z-]+)/gu))
      if (!owned.has(match[1]) && !elsewhere.has(match[1] ?? ''))
        unknown.push(`${file}: krn ${match[1]}`);
  assert.deepEqual(unknown, []);
});
