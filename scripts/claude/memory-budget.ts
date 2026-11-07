import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { memoryDirectory } from './memory-directory.ts';
import { indexBudget, indexLineBudget } from './memory-refs.ts';

// PreToolUse hook for Write|Edit: refuses a change that would push the auto-memory index
// over its budget, so the writer consolidates first. A write that does not grow the
// index is always allowed, which keeps consolidation of an already oversized index possible.
const measure = (text: string) => {
  const lines = text.split(/\r\n|\r|\n/u);
  return {
    bytes: Buffer.byteLength(text),
    lines: lines.length - (lines.at(-1) === '' ? 1 : 0),
  };
};
function current(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
export function decide(payload: unknown, root: string): string | undefined {
  const input = (payload as { tool_input?: Record<string, unknown> } | null)
    ?.tool_input;
  const file = input?.file_path;
  if (typeof file !== 'string' || basename(file) !== 'MEMORY.md')
    return undefined;
  const path = resolve(root, file);
  if (path !== resolve(memoryDirectory(root), 'MEMORY.md')) return undefined;
  const before = current(path);
  let after: string;
  if (typeof input?.content === 'string') after = input.content;
  else if (
    typeof input?.old_string === 'string' &&
    typeof input.new_string === 'string' &&
    input.old_string !== ''
  ) {
    after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, () => String(input.new_string));
  } else return undefined;
  const next = measure(after);
  const prior = measure(before);
  const over = next.bytes > indexBudget || next.lines > indexLineBudget;
  if (!over || (next.bytes <= prior.bytes && next.lines <= prior.lines))
    return undefined;
  return `MEMORY.md would be ${next.bytes} bytes and ${next.lines} lines; the index budget is ${indexBudget} bytes and ${indexLineBudget} lines (INDEX-SIZE, scripts/claude/memory-refs.ts). Consolidate or retire entries first, then write.`;
}
function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const cwd = (payload as { cwd?: unknown } | null)?.cwd;
  const reason = decide(payload, typeof cwd === 'string' ? cwd : process.cwd());
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}
main();
