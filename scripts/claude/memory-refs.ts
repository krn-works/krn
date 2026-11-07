import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryDirectory } from './memory-directory.ts';

export type Finding = {
  kind:
    | 'MISSING-INDEX'
    | 'UNINDEXED'
    | 'MISSING-TASK'
    | 'STALE-TASK'
    | 'DANGLING'
    | 'INDEX-SIZE'
    | 'TOO-LARGE'
    | 'UNREADABLE'
    | 'PENDING-LESSON';
  file: string;
  line: number;
  target: string;
};

const limit = 256 * 1024;
// About 600 tokens: the lead index holds operator preferences, grants and decisions only;
// lessons move into checks, rules or host notes.
export const indexBudget = 2400;
export const indexLineBudget = 200;

// Counts lines of an oversized file in fixed chunks, splitting on CRLF, CR or LF like the
// in-memory scan, without holding the file in memory.
function countLines(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let separators = 0;
    let previous = 0x0a;
    for (
      let read = readSync(fd, buffer);
      read > 0;
      read = readSync(fd, buffer)
    ) {
      for (let index = 0; index < read; index++) {
        const byte = buffer[index] ?? 0;
        // A CR counts once; an LF right after it completes the same CRLF separator.
        if (byte === 0x0d || (byte === 0x0a && previous !== 0x0d)) separators++;
        previous = byte;
      }
    }
    return previous === 0x0a || previous === 0x0d ? separators : separators + 1;
  } finally {
    closeSync(fd);
  }
}
const safe = (text: string) =>
  (text.split(/[\n\r\u2028\u2029]/u)[0] ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '');
const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
function mainCheckout(root: string): string {
  try {
    return dirname(
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
    return root;
  }
}
// O_NOFOLLOW also protects against replacement between lstat and open.
function read(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > limit) throw new RangeError('too large');
    const bytes = Buffer.alloc(limit + 1);
    // Reading through the descriptor avoids following a replaced directory entry.
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new RangeError('too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function checkMemory({
  root,
  memory,
}: {
  root: string;
  memory: string;
}): { findings: Finding[]; files: number } {
  const directory = exists(memory);
  if (!directory?.isDirectory() || directory.isSymbolicLink())
    throw new Error(`memory directory not found: ${memory}`);
  const main = mainCheckout(root);
  const findings: Finding[] = [];
  const keys = new Set<string>();
  const add = (kind: Finding['kind'], file: string, line = 0, target = '') => {
    const key = JSON.stringify([kind, file, line, target]);
    if (!keys.has(key)) {
      keys.add(key);
      findings.push({ kind, file, line, target });
    }
  };
  // Directories never count as memory files, so they cannot exhaust the file bound.
  const names = readdirSync(memory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.md') && !entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const indexed = new Set<string>();
  let files = 0;
  for (const file of names.slice(0, 500)) {
    const path = join(memory, file);
    const stat = exists(path);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      add('DANGLING', file, 0, 'symlink');
      continue;
    }
    if (!stat.isFile()) continue;
    files++;
    if (stat.size > limit) {
      if (file !== 'MEMORY.md') {
        add('TOO-LARGE', file);
        continue;
      }
      let count: number;
      try {
        count = countLines(path);
      } catch {
        // An unreadable oversized index is reported like any unreadable file; the scan goes on.
        add('UNREADABLE', file);
        continue;
      }
      add('INDEX-SIZE', file, 0, `${count} lines ${stat.size} bytes`);
      continue;
    }
    let text: string | undefined;
    try {
      text = read(path);
    } catch (error) {
      if (!exists(path)) {
        files--;
        continue;
      }
      add(error instanceof RangeError ? 'TOO-LARGE' : 'UNREADABLE', file);
      continue;
    }
    if (text === undefined) continue;
    const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
    const count = lines.length - (lines.at(-1) === '' ? 1 : 0);
    if (
      file === 'MEMORY.md' &&
      (count > indexLineBudget || stat.size > indexBudget)
    )
      add('INDEX-SIZE', file, 0, `${count} lines ${stat.size} bytes`);
    for (const [index, line] of lines.entries()) {
      const number = index + 1;
      if (file === 'MEMORY.md')
        for (const match of line.matchAll(
          /\[[^\]]*\]\(<?([^\s<>]+)\.md>?\)/gu,
        )) {
          const target = match[1];
          if (!target || indexed.has(`${target}.md`)) continue;
          indexed.add(`${target}.md`);
          if (!exists(join(memory, `${target}.md`)))
            add('MISSING-INDEX', file, number, target);
        }
      // A lesson belongs in a check or a repository rule; lead memory keeps operator
      // preferences and decisions only, so a marked lesson still waiting is a finding.
      const pending = /^\s*Lesson pending enforcement:\s*(.*)$/u.exec(line);
      if (pending)
        add('PENDING-LESSON', file, number, pending[1]?.trim() ?? '');
      for (const match of line.matchAll(/\bt-[a-z0-9]{7}\b/gu)) {
        const id = match[0];
        try {
          const taskText = read(join(main, 'tasks', `${id}.json`));
          const task: unknown = JSON.parse(taskText ?? '');
          if (typeof task !== 'object' || task === null)
            throw new Error('invalid task');
          if (
            'status' in task &&
            task.status === 'closed' &&
            /\b(open|pending|still open|waits?|blocked|next|todo)\b/iu.test(
              line,
            )
          )
            add('STALE-TASK', file, number, id);
        } catch {
          add('MISSING-TASK', file, number, id);
        }
      }
      for (const match of line.matchAll(/`([^`]+)`/gu)) {
        const token = match[1] ?? '';
        if (
          !token.includes('/') ||
          /[<>*{}$|]|\.\.\.|…|:\/\//u.test(token) ||
          !/^(~\/|\/|\.{0,2}\/?[A-Za-z0-9._-]+\/)[^\s<>*{}$|]*$/u.test(token)
        )
          continue;
        const path = token.replace(/:\d+([-,]\d+)*$/u, '');
        if (path.startsWith('/')) {
          if (path.split('/').filter(Boolean).length < 2) continue;
        } else if (
          !path.startsWith('~/') &&
          !path.endsWith('/') &&
          !path.split('/').at(-1)?.includes('.')
        ) {
          continue;
        }
        const target = path.startsWith('~/')
          ? join(homedir(), path.slice(2))
          : resolve(main, path);
        if (!exists(target)) add('DANGLING', file, number, token);
      }
    }
  }
  if (names.length > 500)
    add('TOO-LARGE', 'MEMORY.md', 0, `${names.length} files`);
  for (const file of names.slice(0, 500))
    if (
      file !== 'MEMORY.md' &&
      exists(join(memory, file))?.isFile() &&
      !indexed.has(file)
    )
      add('UNINDEXED', file);
  findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      a.kind.localeCompare(b.kind) ||
      a.target.localeCompare(b.target),
  );
  return { findings, files };
}
function format(finding: Finding): string {
  const { kind, file, line, target } = finding;
  const location = [
    'UNINDEXED',
    'INDEX-SIZE',
    'TOO-LARGE',
    'UNREADABLE',
  ].includes(kind)
    ? safe(file)
    : `${safe(file)}:${line}`;
  return `${kind} ${location}${target ? ` ${safe(target)}` : ''}`;
}
function cli() {
  let root = process.cwd();
  let memory: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--root', '--memory'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--')
    ) {
      process.stderr.write(
        'Usage: node scripts/claude/memory-refs.ts [--root <repository>] [--memory <directory>]\n',
      );
      process.exitCode = 64;
      return;
    }
    if (flag === '--root') root = resolve(value);
    else memory = resolve(value);
  }
  memory ??= memoryDirectory(root);
  try {
    const result = checkMemory({ root, memory });
    for (const finding of result.findings.slice(0, 200))
      console.log(format(finding));
    if (result.findings.length > 200)
      console.log(`... ${result.findings.length - 200} more`);
    console.log(
      `memory-refs: ${result.findings.length} findings in ${result.files} files`,
    );
    process.exitCode = result.findings.length ? 65 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal error';
    console.error(safe(message));
    process.exitCode = message.startsWith('memory directory not found:')
      ? 64
      : 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli();
