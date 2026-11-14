import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.md')
        ? [`${dir}/${entry.name}`]
        : [],
  );
const listed = (dir: string): string[] =>
  readdirSync(join(root, dir))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `${dir}/${file}`);
// Every agent-facing page is checked as it appears; none is enumerated by hand.
const documents = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  // proposals.md is the history register of retired mechanisms.
  ...listed('docs/program').filter((file) => !file.endsWith('/proposals.md')),
  ...listed('.claude/agents'),
  ...walk('.claude/skills'),
  ...walk('.agents/skills'),
];
// `work` is named only as replaced.
const elsewhere = new Set(['work']);

function spans(): { file: string; text: string }[] {
  return documents.flatMap((file) =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/`([^`\n]+)`/gu)].map(
      (match) => ({ file, text: match[1] ?? '' }),
    ),
  );
}

const topLevel = new Set(
  readdirSync(root).filter((name) => !['node_modules', '.git'].includes(name)),
);

// One span of backticked text: the npm scripts and repository paths it names
// that do not exist. Paths under .krn/ are local state; placeholders and globs
// are patterns, not paths.
function deadReferences(
  text: string,
  scripts: Record<string, string>,
  exists: (path: string) => boolean,
): string[] {
  const dead: string[] = [];
  for (const match of text.matchAll(/npm run ([\w:-]+)/gu))
    if (!((match[1] as string) in scripts)) dead.push(`npm run ${match[1]}`);
  for (const match of text.matchAll(
    /(?:^|[\s(])((?:\.?[\w-]+\/)+[\w.-]*)(?=$|[\s):,;])/gu,
  )) {
    const path = (match[1] ?? '').replace(/\/$/u, '');
    const first = path.split('/')[0] ?? '';
    const named = /\.[a-z]{1,4}$/u.test(path) || (match[1] ?? '').endsWith('/');
    if (first === '.krn' || !(named || topLevel.has(first))) continue;
    if (!exists(path)) dead.push(path);
  }
  return dead;
}

test('a dead path or retired script in instruction text is reported', () => {
  const scripts = { fast: 'x' };
  const exists = (path: string): boolean => path === 'scripts/boundaries.ts';
  assert.deepEqual(
    deadReferences(
      'run `npm run preflight` then edit docs/program/PLAN.md',
      scripts,
      exists,
    ),
    ['npm run preflight', 'docs/program/PLAN.md'],
  );
  assert.deepEqual(
    deadReferences(
      'npm run fast reads scripts/boundaries.ts, .krn/runs/x/plan.md, src/<name>/',
      scripts,
      exists,
    ),
    [],
  );
});

test('instructions name only npm scripts and repository files that exist', () => {
  const scripts = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const missing: string[] = [];
  for (const { file, text } of spans())
    for (const dead of deadReferences(text, scripts, (path) =>
      existsSync(join(root, path)),
    ))
      missing.push(`${file}: ${dead}`);
  assert.deepEqual(missing, []);
});

function unknownCommands(text: string, owned: Set<string | undefined>) {
  return [...text.matchAll(/(?:^|[\s(])(?:bin\/)?krn ([a-z-]+)/gu)]
    .map((match) => match[1] ?? '')
    .filter((name) => !owned.has(name) && !elsewhere.has(name))
    .map((name) => `krn ${name}`);
}

test('a retired krn command in instruction text is reported', () => {
  assert.deepEqual(
    unknownCommands('use krn ship or bin/krn task show', new Set(['task'])),
    ['krn ship'],
  );
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
  const unknown = spans().flatMap(({ file, text }) =>
    unknownCommands(text, owned).map((name) => `${file}: ${name}`),
  );
  assert.deepEqual(unknown, []);
});
