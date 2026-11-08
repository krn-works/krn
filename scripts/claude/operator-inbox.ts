import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allEntries,
  capture,
  dispose,
  oneLine,
  openEntries,
} from './operator-inbox-store.ts';

const usage = `Usage:
  operator-inbox.ts capture            (UserPromptSubmit hook; reads hook JSON on stdin)
  operator-inbox.ts open [--root <repository>]
  operator-inbox.ts dispose <hash> --task <id> | --memory <slug> | --answered <reason> [--root <repository>]
  operator-inbox.ts search <words...> [--root <repository>] [--memory <directory>]`;

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'capture') {
  // Never block, fail or print: the prompt proceeds whatever happens here.
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
    if (
      typeof input.prompt === 'string' &&
      typeof root === 'string' &&
      typeof input.session_id === 'string'
    )
      capture(root, input.session_id, input.prompt);
  } catch {
    /* ignored on purpose */
  }
  process.exit(0);
}

const { memoryDirectory } = await import('./memory-directory.ts');

function flags(arguments_: string[]) {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const queue = [...arguments_];
  for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
    if (a.startsWith('--')) {
      const value = queue.shift();
      if (value === undefined) fail(usage, 64);
      values.set(a, value);
    } else positional.push(a);
  }
  return { values, positional };
}

const { values, positional } = flags(rest);
const root = resolve(values.get('--root') ?? process.cwd());

if (command === 'open') {
  const open = openEntries(root);
  for (const entry of open)
    process.stdout.write(
      `${entry.hash} ${entry.time} ${entry.session.slice(0, 8)} ${oneLine(entry.text, 160)}\n`,
    );
  process.stdout.write(`${open.length} open\n`);
} else if (command === 'dispose') {
  const prefix = positional[0];
  if (!prefix || !/^[0-9a-f]{4,12}$/u.test(prefix)) fail(usage, 64);
  const matches = [
    ...new Set(
      allEntries(root)
        .map((entry) => entry.hash)
        .filter((hash) => hash.startsWith(prefix)),
    ),
  ];
  if (matches.length !== 1)
    fail(`FAIL ${prefix}: ${matches.length} matching inbox entries`, 1);
  const hash = matches[0] as string;
  const task = values.get('--task');
  const memory = values.get('--memory');
  const answered = values.get('--answered');
  if ([task, memory, answered].filter((v) => v !== undefined).length !== 1)
    fail(usage, 64);
  if (task !== undefined) {
    if (
      !/^t-[a-z0-9]{7}$/u.test(task) ||
      !existsSync(join(root, 'tasks', `${task}.json`))
    )
      fail(`FAIL ${task}: no tasks/${task}.json`, 1);
    dispose(root, hash, 'task', task);
  } else if (memory !== undefined) {
    const slug = memory.replace(/\.md$/u, '');
    const directory = values.get('--memory-dir') ?? memoryDirectory(root);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(slug) ||
      !existsSync(join(directory, `${slug}.md`))
    )
      fail(`FAIL memory:${slug}: no ${join(directory, `${slug}.md`)}`, 1);
    dispose(root, hash, 'memory', slug);
  } else {
    if (!answered?.trim()) fail(usage, 64);
    dispose(root, hash, 'answered', answered.trim());
  }
  process.stdout.write(`disposed ${hash}\n`);
} else if (command === 'search') {
  const words = positional
    .flatMap((word) => word.toLowerCase().split(/\s+/u))
    .filter((word) => word.length >= 3);
  if (words.length === 0) fail(usage, 64);
  const memory = values.get('--memory') ?? memoryDirectory(root);
  const sources: { path: string; text: string }[] = [];
  const read = (directory: string, extension: string) => {
    try {
      for (const name of readdirSync(directory))
        if (name.endsWith(extension))
          sources.push({
            path: join(directory, name),
            text: readFileSync(join(directory, name), 'utf8').toLowerCase(),
          });
    } catch {
      /* A missing directory has no mentions. */
    }
  };
  read(join(root, 'tasks'), '.json');
  read(memory, '.md');
  for (const entry of allEntries(root))
    sources.push({
      path: `inbox:${entry.hash}`,
      text: entry.text.toLowerCase(),
    });
  const scored = sources
    .map((source) => ({
      path: source.path,
      score: words.filter((word) => source.text.includes(word)).length,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 12);
  for (const hit of scored)
    process.stdout.write(`${hit.score}/${words.length} ${hit.path}\n`);
  process.stdout.write(
    scored.length === 0
      ? `no mention of: ${words.join(' ')}\n`
      : `${scored.length} source(s) mention these words; read them before claiming absence\n`,
  );
} else fail(usage, 64);
