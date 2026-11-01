import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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

// CommonMark subset: ATX headings take up to three leading spaces and optional closing hashes;
// a backtick fence's info string holds no backtick. The section admits only unindented one-line
// bullets and blank lines, so indented lines, code, nested lists and subheadings inside it fail
// closed instead of hiding a request; a level-one or level-two heading, indented or not, ends it.
// A second section or any other mention of "operator requests" (code, setext, quote, list or
// HTML) could fake or hide a section, so it fails as ambiguous.
const headingPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const fencePattern = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/u;
const isSection = (heading: RegExpExecArray | null) =>
  heading?.[1] === '##' && /^operator requests$/iu.test(heading[2] ?? '');
const items: { line: number; text: string }[] = [];
const failures: string[] = [];
let sections = 0;
let section: { line: number; items: number } | undefined;
let fence: string | undefined;
const endSection = () => {
  if (section && section.items === items.length)
    failures.push(
      `FAIL ${handoff}:${section.line}: empty section; write "- none" when there is no request`,
    );
  section = undefined;
};
for (const [index, line] of text
  .replace(/^\uFEFF/u, '')
  .split(/\r\n|\r|\n/u)
  .entries()) {
  if (
    /operator\s+requests/iu.test(line) &&
    (fence || !isSection(headingPattern.exec(line)))
  )
    failures.push(
      `FAIL ${handoff}:${index + 1}: "operator requests" is ambiguous outside a "## Operator requests" heading; reword or move it`,
    );
  if (fence) {
    const close = fencePattern.exec(line)?.[1];
    if (
      close !== undefined &&
      close[0] === fence[0] &&
      close.length >= fence.length &&
      line.trim() === close
    )
      fence = undefined;
    continue;
  }
  const heading = headingPattern.exec(line);
  const endsSection =
    heading !== null &&
    (heading[1] ?? '').length <= 2 &&
    /[^#\s]/u.test(heading[2] ?? '');
  const misplaced =
    !section || !line.trim() || endsSection
      ? undefined
      : /^\s/u.test(line)
        ? 'indented lines are'
        : /^(?:`{3}|~{3})/u.test(line)
          ? 'fenced code is'
          : /^#{1,6}[ \t#]*$/u.test(line)
            ? 'empty headings are'
            : /^#{3,6}(?:[ \t]|$)/u.test(line)
              ? 'subheadings are'
              : undefined;
  if (misplaced) {
    failures.push(
      `FAIL ${handoff}:${index + 1}: ${misplaced} not allowed in the operator requests section; write each request as one unindented bullet line`,
    );
    continue;
  }
  const open = fencePattern.exec(line)?.[1];
  if (open) {
    fence = open;
    continue;
  }
  if (heading) {
    endSection();
    if (isSection(heading)) {
      if (sections > 0)
        failures.push(
          `FAIL ${handoff}:${index + 1}: a second "## Operator requests" section is not allowed; keep every request in one section`,
        );
      sections++;
      section = { line: index + 1, items: items.length };
    }
    continue;
  }
  if (!section || !line.trim()) continue;
  const bullet = /^[-*+](?:[ \t]+(.*))?$/u.exec(line);
  if (bullet) items.push({ line: index + 1, text: (bullet[1] ?? '').trim() });
  else
    failures.push(
      `FAIL ${handoff}:${index + 1}: write each operator request as a top-level bullet`,
    );
}
endSection();
if (sections === 0)
  failures.push(`FAIL ${handoff}: no "## Operator requests" section`);

const file = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;
const none = items.filter((item) => /^none\.?$/iu.test(item.text));
if (none.length > 0 && items.length > 1)
  failures.push(
    `FAIL ${handoff}:${none[0]?.line}: "none" cannot sit beside other requests`,
  );
let open = 0;
for (const item of items) {
  if (none.includes(item) || /^closed:[ \t]+\S/iu.test(item.text)) continue;
  open++;
  const tasks = [...item.text.matchAll(/\bt-[a-z0-9]{7}\b/gu)].map(
    (match) => match[0],
  );
  // Sentence punctuation may follow a slug; anything else must be a plain file name.
  const memories = [...item.text.matchAll(/\bmemory:(\S*)/gu)].map((match) =>
    (match[1] ?? '').replace(/[.,;:!?)\]`'"*]+$/u, '').replace(/\.md$/u, ''),
  );
  if (tasks.length === 0 && memories.length === 0) {
    failures.push(
      `FAIL ${handoff}:${item.line}: request has no task id, memory:<slug> or "closed: <reason>" prefix`,
    );
    continue;
  }
  for (const id of tasks)
    if (!file(join(root, 'tasks', `${id}.json`)))
      failures.push(
        `FAIL ${handoff}:${item.line}: ${id} has no tasks/${id}.json`,
      );
  for (const slug of memories)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(slug) || slug.includes('..'))
      failures.push(
        `FAIL ${handoff}:${item.line}: memory:${slug} is not a memory file name`,
      );
    else if (!file(join(memory, `${slug}.md`)))
      failures.push(
        `FAIL ${handoff}:${item.line}: memory:${slug} has no ${join(memory, `${slug}.md`)}`,
      );
}

if (failures.length > 0) fail(failures.join('\n'), 1);
process.stdout.write(
  `PASS ${handoff}: ${open} open operator request(s) recorded\n`,
);
