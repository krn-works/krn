import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// PreToolUse hook for Bash and Read: refuses the lead a large file dump. `sed -n`, `cat`
// and `grep` returned 54% of the lead's Bash result bytes, and every byte is re-read from
// cache on each later turn (.krn/runs/roadmap-refill/token-per-slice.md, section 6).
// Subagents read freely: Claude Code adds `agent_id` to a subagent's hook payload and
// omits it for the lead (test/claude/fixtures/pretooluse-bash-lead-subagent.jsonl).
// It classifies only unpiped cat, sed -n ranges, recursive grep and unbounded Read;
// anything it cannot classify is allowed.
export const maxBytes = 8000;
export const maxLines = 80;

const advice = `Delegate the reading to the krn-reader subagent (it returns a verdict and a path), or read a slice: Read with offset and limit, \`sed -n 'A,Bp'\` of at most ${maxLines} lines, \`grep -c\`, \`grep -l\` or the Grep tool with head_limit (scripts/claude/lead-file-read.ts).`;

type Size = (path: string) => { bytes: number; lines: number } | undefined;

const measure: Size = (path) => {
  try {
    if (!statSync(path).isFile()) return undefined;
    const text = readFileSync(path, 'utf8');
    return {
      bytes: Buffer.byteLength(text),
      lines: text.split('\n').length - 1,
    };
  } catch {
    return undefined;
  }
};

// Drops heredoc bodies so their lines are not read as commands.
function withoutHeredocs(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let end: string | undefined;
  for (const line of lines) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    kept.push(line);
    end = /<<-?\s*['"]?(\w+)['"]?/u.exec(line)?.[1];
  }
  return kept.join('\n');
}

const words = (text: string) =>
  [...text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );

function judge(stage: string, cwd: string, size: Size): string | undefined {
  if (/[<>]/u.test(stage.replace(/2>&1|2>\/dev\/null/gu, ''))) return undefined;
  const [name, ...args] = words(stage.replace(/^(?:\w+=\S*\s+)*/u, ''));
  const files = (list: string[]) =>
    list
      .filter((arg) => !arg.startsWith('-'))
      .map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg)));
  if (name === 'cat') {
    const bytes = files(args).reduce(
      (sum, path) => sum + (size(path)?.bytes ?? 0),
      0,
    );
    if (bytes > maxBytes)
      return `\`${stage}\` prints ${bytes} bytes of file text`;
    return undefined;
  }
  if (name === 'sed' && args.includes('-n')) {
    const scripts = args.filter((arg) => /^[\d,$;p]+$/u.test(arg));
    const targets = files(args.filter((arg) => !scripts.includes(arg)));
    const total = Math.max(0, ...targets.map((path) => size(path)?.lines ?? 0));
    let lines = 0;
    for (const script of scripts)
      for (const part of script.split(';')) {
        const range = /^(\d+),(\d+|\$)p$/u.exec(part);
        if (!range) continue;
        const end = range[2] === '$' ? total : Number(range[2]);
        lines += Math.max(
          0,
          Math.min(end, total || end) - Number(range[1]) + 1,
        );
      }
    if (lines > maxLines) return `\`${stage}\` prints ${lines} lines`;
    return undefined;
  }
  const flags = args.filter((arg) => arg.startsWith('-'));
  const recursive =
    name === 'rg' ||
    (name === 'grep' &&
      flags.some(
        (flag) => /^-[a-zA-Z]*[rR]/u.test(flag) || flag === '--recursive',
      ));
  const bounded = flags.some(
    (flag) =>
      /^-[a-zA-Z]*[lLcqm]/u.test(flag) ||
      /^--(?:files-with(?:out)?-matches|count|quiet|max-count|files)/u.test(
        flag,
      ),
  );
  if (recursive && !bounded)
    return `\`${stage}\` prints every match across a tree`;
  return undefined;
}

export function decide(
  payload: unknown,
  size: Size = measure,
): string | undefined {
  const fields = payload as {
    agent_id?: unknown;
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: { command?: unknown; file_path?: unknown; limit?: unknown };
  } | null;
  if (!fields || typeof fields.agent_id === 'string') return undefined;
  let cwd = typeof fields.cwd === 'string' ? fields.cwd : process.cwd();
  const input = fields.tool_input;
  if (fields.tool_name === 'Read') {
    if (typeof input?.file_path !== 'string' || input.limit !== undefined)
      return undefined;
    const bytes = size(input.file_path)?.bytes ?? 0;
    if (/\.(?:png|jpe?g|gif|webp|pdf|ipynb)$/iu.test(input.file_path))
      return undefined;
    if (bytes <= maxBytes) return undefined;
    return `Refused: reading all of \`${input.file_path}\` puts ${bytes} bytes into the lead's context, where every later turn re-reads them. ${advice}`;
  }
  if (typeof input?.command !== 'string') return undefined;
  for (const list of withoutHeredocs(input.command).split(/&&|\|\||;|\n/u)) {
    const stages = list.split(/\|&?/u).map((stage) => stage.trim());
    const [first] = stages;
    if (!first) continue;
    const cd = /^cd\s+(\S+)$/u.exec(first);
    if (cd?.[1]) {
      cwd = resolve(cwd, words(cd[1])[0] ?? '.');
      continue;
    }
    if (stages.length > 1) continue;
    const reason = judge(first, cwd, size);
    if (reason)
      return `Refused: ${reason} into the lead's context, where every later turn re-reads them. Nothing in this Bash call ran, including its other commands. ${advice}`;
  }
  return undefined;
}

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const reason = decide(payload);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}
main();
