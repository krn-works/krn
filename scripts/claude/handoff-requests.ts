import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// A handoff must record every open operator request durably: a task, a memory entry, or an explicit close.
const usage =
  'Usage: node scripts/claude/handoff-requests.ts <handoff.md> [--root <repository>] [--memory <directory>]';

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function options(arguments_: string[]) {
  let handoff: string | undefined;
  let root = process.cwd();
  let memory: string | undefined;
  const queue = [...arguments_];
  for (
    let argument = queue.shift();
    argument !== undefined;
    argument = queue.shift()
  ) {
    if (argument === '--root' || argument === '--memory') {
      const value = queue.shift();
      if (!value) fail(usage, 64);
      if (argument === '--root') root = resolve(value);
      else memory = resolve(value);
    } else if (!argument.startsWith('-') && handoff === undefined)
      handoff = resolve(argument);
    else fail(usage, 64);
  }
  if (!handoff) fail(usage, 64);
  return { handoff, root, memory: memory ?? memoryDirectory(root) };
}

// Claude Code keys auto memory by the main checkout, so worktrees share it.
function memoryDirectory(root: string): string {
  let main = root;
  try {
    main = dirname(
      resolve(
        root,
        execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ),
    );
  } catch {
    /* Outside Git the root itself names the project. */
  }
  return join(
    homedir(),
    '.claude/projects',
    main.replace(/[^A-Za-z0-9]/gu, '-'),
    'memory',
  );
}

const { handoff, root, memory } = options(process.argv.slice(2));
let text: string;
try {
  text = readFileSync(handoff, 'utf8');
} catch {
  fail(`FAIL ${handoff}: unreadable`, 1);
}

const lines = text.split('\n');
const start = lines.findIndex((line) =>
  /^##\s+operator requests\s*$/iu.test(line.trim()),
);
if (start === -1) fail(`FAIL ${handoff}: no "## Operator requests" section`, 1);

// Top-level bullets until the next heading; indented lines continue the bullet above.
const items: { line: number; text: string }[] = [];
for (const [offset, line] of lines.slice(start + 1).entries()) {
  if (/^#{1,6}\s/u.test(line)) break;
  const last = items.at(-1);
  if (/^[-*]\s+/u.test(line))
    items.push({
      line: start + offset + 2,
      text: line.replace(/^[-*]\s+/u, ''),
    });
  else if (/^\s+\S/u.test(line) && last) last.text += ` ${line.trim()}`;
}

const failures: string[] = [];
if (items.length === 0)
  failures.push(
    `FAIL ${handoff}:${start + 1}: empty section; write "- none" when no request is open`,
  );
const none = items.filter((item) => /^none\.?$/iu.test(item.text.trim()));
if (none.length > 0 && items.length > 1)
  failures.push(
    `FAIL ${handoff}:${none[0]?.line}: "none" cannot sit beside other requests`,
  );
for (const item of items) {
  if (none.includes(item) || /^closed:\s*\S/iu.test(item.text)) continue;
  const tasks = [...item.text.matchAll(/\bt-[a-z0-9]{7}\b/gu)].map(
    (match) => match[0],
  );
  const memories = [
    ...item.text.matchAll(/\bmemory:([A-Za-z0-9][A-Za-z0-9._-]*)/gu),
  ].map((match) => (match[1] ?? '').replace(/\.md$/u, ''));
  if (tasks.length === 0 && memories.length === 0) {
    failures.push(
      `FAIL ${handoff}:${item.line}: request has no task id, memory:<slug> or "closed:" prefix`,
    );
    continue;
  }
  for (const id of tasks)
    if (!existsSync(join(root, 'tasks', `${id}.json`)))
      failures.push(
        `FAIL ${handoff}:${item.line}: ${id} has no tasks/${id}.json`,
      );
  for (const slug of memories)
    if (!existsSync(join(memory, `${slug}.md`)))
      failures.push(
        `FAIL ${handoff}:${item.line}: memory:${slug} has no ${join(memory, `${slug}.md`)}`,
      );
}

if (failures.length > 0) fail(failures.join('\n'), 1);
process.stdout.write(
  `PASS ${handoff}: ${none.length > 0 ? 0 : items.length} open operator request(s) recorded\n`,
);
