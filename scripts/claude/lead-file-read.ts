import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PreToolUse hook for Bash and Read: refuses the lead a large file dump. `sed -n`, `cat`
// and `grep` returned 54% of the lead's Bash result bytes before the first refusal and 51%
// across 30 sessions after it (`sed -n` 21%, `grep` 11%, `cat` 9%), so the `sed -n` cap is 40 lines (maxLines);
// every byte is re-read from cache on each later turn.
// Subagents read freely: Claude Code adds `agent_id` to a subagent's hook payload and
// omits it for the lead (test/claude/fixtures/pretooluse-bash-lead-subagent.jsonl).
// It classifies only unpiped cat, sed -n ranges, recursive grep and unbounded Read, and
// sums the cat and sed -n reads chained in one call against the same byte budget (compound
// calls were 571 kB of 908 kB of read-family result bytes after d395d05);
// anything it cannot classify is allowed.
export const maxBytes = 8000;
export const maxLines = 40;
export const maxMatches = 200;

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

type Spent = { bytes: number; reads: number };
type Finding = { reason: string; bounded: string; search?: true };

// The bounded form of an over-long reading stage: the same read cut to the budget.
const cut = {
  bytes: (stage: string) => `${stage} | head -c ${maxBytes}`,
  lines: (stage: string) => `${stage} | head -n ${maxLines}`,
  matches: (stage: string) => `${stage} | head -n ${maxMatches}`,
};

function judge(
  stage: string,
  cwd: string,
  size: Size,
  spent: Spent,
): Finding | undefined {
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
    spent.bytes += bytes;
    spent.reads += 1;
    if (bytes > maxBytes)
      return {
        reason: `\`${stage}\` prints ${bytes} bytes of file text`,
        bounded: cut.bytes(stage),
      };
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
    const sized = targets.map((path) => size(path)).find((one) => one?.lines);
    spent.bytes += Math.round(
      lines * ((sized?.bytes ?? 0) / Math.max(sized?.lines ?? 1, 1)),
    );
    spent.reads += 1;
    if (lines > maxLines)
      return {
        reason: `\`${stage}\` prints ${lines} lines`,
        bounded: cut.lines(stage),
      };
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
    return {
      reason: `\`${stage}\` prints every match across a tree`,
      bounded: cut.matches(stage),
      search: true,
    };
  return undefined;
}

export type Verdict = { refuse: string } | { rewrite: string };

// A Bash call is judged per reading stage. A search with no bound is always rewritten to
// its bounded form. An over-long cat or sed -n inside a compound call is cut to the budget
// in place, so the call's other commands still run; alone it is refused, so the lead
// picks a slice.
export function verdict(
  payload: unknown,
  size: Size = measure,
): Verdict | undefined {
  const fields = payload as {
    agent_id?: unknown;
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: { command?: unknown; file_path?: unknown; limit?: unknown };
  } | null;
  if (!fields || typeof fields.agent_id === 'string') return undefined;
  // A headless `krn lane run` session is a main session with no lead to protect.
  if (process.env.KRN_SESSION_CLASS === 'lane') return undefined;
  let cwd = typeof fields.cwd === 'string' ? fields.cwd : process.cwd();
  const input = fields.tool_input;
  if (fields.tool_name === 'Read') {
    if (typeof input?.file_path !== 'string' || input.limit !== undefined)
      return undefined;
    const bytes = size(input.file_path)?.bytes ?? 0;
    if (/\.(?:png|jpe?g|gif|webp|pdf|ipynb)$/iu.test(input.file_path))
      return undefined;
    if (bytes <= maxBytes) return undefined;
    return {
      refuse: `Refused: reading all of \`${input.file_path}\` puts ${bytes} bytes into the lead's context, where every later turn re-reads them. ${advice}`,
    };
  }
  if (typeof input?.command !== 'string') return undefined;
  const command = input.command;
  const spent: Spent = { bytes: 0, reads: 0 };
  const found: { stage: string; finding: Finding }[] = [];
  let commands = 0;
  for (const list of withoutHeredocs(command).split(/&&|\|\||;|\n/u)) {
    const stages = list.split(/\|&?/u).map((stage) => stage.trim());
    const [first] = stages;
    if (!first) continue;
    const cd = /^cd\s+(\S+)$/u.exec(first);
    if (cd?.[1]) {
      cwd = resolve(cwd, words(cd[1])[0] ?? '.');
      continue;
    }
    commands += 1;
    if (stages.length > 1) continue;
    const finding = judge(first, cwd, size, spent);
    if (finding) found.push({ stage: first, finding });
  }
  let rewritten = command;
  for (const { stage, finding } of found) {
    const alone = commands <= 1 && !finding.search;
    if (alone || command.split(stage).length !== 2)
      return {
        refuse: `Refused: ${finding.reason} into the lead's context, where every later turn re-reads them. Nothing in this Bash call ran, including its other commands. ${advice}`,
      };
    rewritten = rewritten.replace(stage, () => finding.bounded);
  }
  if (found.length > 0) return { rewrite: rewritten };
  if (spent.reads > 1 && spent.bytes > maxBytes)
    return {
      refuse: `Refused: the reads chained in this Bash call print about ${spent.bytes} bytes of file text (budget ${maxBytes} for the whole call) into the lead's context, where every later turn re-reads them. Nothing in this Bash call ran. ${advice}`,
    };
  return undefined;
}

// The refusal text, or undefined when the call is allowed (rewritten or untouched).
export function decide(payload: unknown, size: Size = measure) {
  const result = verdict(payload, size);
  return result && 'refuse' in result ? result.refuse : undefined;
}

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const result = verdict(payload);
  if (!result) return;
  if ('refuse' in result) {
    process.stderr.write(`${result.refuse}\n`);
    process.exitCode = 2;
    return;
  }
  const input = (payload as { tool_input: Record<string, unknown> }).tool_input;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'the over-long reading stage was cut to the lead read budget; the call is otherwise unchanged',
        updatedInput: { ...input, command: result.rewrite },
      },
    })}\n`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
