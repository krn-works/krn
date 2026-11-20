// The agent-side check of the commit subject and PR title format in any repository: a PreToolUse Bash
// hook that refuses `git commit` and `gh pr create|edit` whose subject or title breaks the format of
// src/repo/commit-title.ts. It runs only on agent tool calls (user-scope Claude Code and Codex hooks,
// and KRN's own pre-tool event), never as a git hook, so the operator's own terminal commits pass.
// A call whose subject cannot be read from the command line (-F, editor, --no-edit, a shell
// variable) passes: the hook judges only text it can see.
import { hookStdin } from '../harness/claude.ts';
import { TITLE_FORM, titleProblem } from '../repo/commit-title.ts';

type Token = { word: string } | { separator: true };

/** A `"$(cat <<'EOF' ... EOF)"` word: the heredoc text, else undefined. */
function heredocText(word: string): string | undefined {
  const match =
    /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*\n?\s*\)\s*$/u.exec(
      word,
    );
  return match?.[3];
}

/** Shell words and command separators of `command`; quotes are removed, `$(...)` inside double quotes is kept verbatim. */
export function shellTokens(command: string): Token[] {
  const tokens: Token[] = [];
  let word: string | undefined;
  let dynamic = false;
  const push = () => {
    if (word !== undefined)
      tokens.push({ word: dynamic ? `\u0000${word}` : word });
    word = undefined;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word = (word ?? '') + command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let text = '';
      i++;
      while (i < command.length && command[i] !== '"') {
        const d = command[i] ?? '';
        if (d === '\\' && i + 1 < command.length) {
          text += command[i + 1];
          i += 2;
        } else if (d === '$' && command[i + 1] === '(') {
          const heredoc = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n/u.exec(
            command.slice(i),
          );
          let end: number;
          if (heredoc) {
            const close = new RegExp(
              `\\n\\s*${heredoc[2]}\\s*\\n?\\s*\\)`,
              'u',
            );
            const found = close.exec(command.slice(i + heredoc[0].length - 1));
            end = found
              ? i + heredoc[0].length - 1 + found.index + found[0].length
              : command.length;
          } else {
            let depth = 0;
            end = i + 1;
            for (; end < command.length; end++) {
              if (command[end] === '(') depth++;
              else if (command[end] === ')' && --depth === 0) break;
            }
            end++;
          }
          const inner = command.slice(i, end);
          const text2 = heredocText(inner);
          if (text2 === undefined) dynamic = true;
          text += text2 ?? inner;
          i = end;
        } else {
          if (d === '$' || d === '`') dynamic = true;
          text += d;
          i++;
        }
      }
      word = (word ?? '') + text;
    } else if (c === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[i + 1];
      i++;
    } else if (/[\s]/u.test(c)) {
      push();
      if (c === '\n') tokens.push({ separator: true });
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      push();
      tokens.push({ separator: true });
    } else {
      if (c === '$' || c === '`') dynamic = true;
      word = (word ?? '') + c;
    }
  }
  push();
  return tokens;
}

/** The commands of `command`: each a list of words, separators dropped. */
export function commands(command: string): string[][] {
  const out: string[][] = [[]];
  for (const token of shellTokens(command)) {
    if ('separator' in token) out.push([]);
    else out[out.length - 1]?.push(token.word);
  }
  return out.filter((words) => words.length > 0);
}

const dynamicWord = (word: string): boolean => word.startsWith('\u0000');

/** The words after the program name, past `VAR=value` prefixes and an `env` wrapper; undefined when the program differs. */
function argsOf(words: string[], program: string): string[] | undefined {
  let i = 0;
  const skipAssignments = () => {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[i] ?? ''))
      i++;
  };
  skipAssignments();
  // `env [-i] [-u NAME] [VAR=value] cmd` runs cmd: look through the wrapper.
  if (words[i] === 'env' || (words[i] ?? '').endsWith('/env')) {
    i++;
    while ((words[i] ?? '').startsWith('-') && words[i] !== '--') {
      i += ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(
        words[i] ?? '',
      )
        ? 2
        : 1;
    }
    skipAssignments();
  }
  const name = words[i] ?? '';
  if (name !== program && !name.endsWith(`/${program}`)) return undefined;
  return words.slice(i + 1);
}

/** The value of a flag at `i` (`-m X`, `-mX`, `--message=X`, `-am X`); undefined when it is not one. */
function flagValue(
  args: string[],
  i: number,
  long: string,
  short: string,
): { value: string; next: number } | undefined {
  const arg = args[i] ?? '';
  if (arg === long || arg === `-${short}`)
    return { value: args[i + 1] ?? '', next: i + 1 };
  if (arg.startsWith(`${long}=`))
    return { value: arg.slice(long.length + 1), next: i };
  const cluster = new RegExp(`^-[a-zA-Z]*${short}(.*)$`, 'u').exec(arg);
  if (cluster && !arg.startsWith('--')) {
    const rest = cluster[1] ?? '';
    return rest === ''
      ? { value: args[i + 1] ?? '', next: i + 1 }
      : { value: rest, next: i };
  }
  return undefined;
}

/** The subject `git commit` would record from its first -m, when the command line holds it. */
export function commitSubject(words: string[]): string | undefined {
  const git = argsOf(words, 'git');
  if (git === undefined) return undefined;
  let i = 0;
  while (i < git.length && (git[i] ?? '').startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(git[i] ?? '')) i++;
    i++;
  }
  if (git[i] !== 'commit') return undefined;
  const args = git.slice(i + 1);
  for (let j = 0; j < args.length; j++) {
    const arg = args[j] ?? '';
    if (arg === '--') return undefined;
    if (
      /^(?:-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash)(?:=|$)/u.test(
        arg,
      )
    )
      return undefined;
    const found = flagValue(args, j, '--message', 'm');
    if (found === undefined) continue;
    if (dynamicWord(found.value)) return undefined;
    return found.value.split('\n')[0]?.trim();
  }
  return undefined;
}

/** The title `gh pr create|edit` sets, when the command line holds it. */
export function prTitle(words: string[]): string | undefined {
  const gh = argsOf(words, 'gh');
  if (gh?.[0] !== 'pr' || !['create', 'edit'].includes(gh[1] ?? ''))
    return undefined;
  const args = gh.slice(2);
  for (let j = 0; j < args.length; j++) {
    const found = flagValue(args, j, '--title', 't');
    if (found === undefined) continue;
    if (dynamicWord(found.value)) return undefined;
    return found.value;
  }
  return undefined;
}

/** The refusal for a Bash command, or undefined when every subject and title it sets is well formed. */
export function decide(payload: unknown): string | undefined {
  const call = payload as {
    tool_name?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  const command = call?.tool_input?.command;
  if (call?.tool_name !== 'Bash' || typeof command !== 'string')
    return undefined;
  if (!/\bgit\b[\s\S]*\bcommit\b|\bgh\b[\s\S]*\bpr\b/u.test(command))
    return undefined;
  for (const words of commands(command)) {
    const subject = commitSubject(words);
    const title = prTitle(words);
    const text = subject ?? title;
    if (text === undefined || /^(?:fixup|squash|amend)! /u.test(text)) continue;
    const problem = titleProblem(text);
    if (problem)
      return `Refused: ${subject === undefined ? 'PR title' : 'commit subject'} ${problem}. Expected ${TITLE_FORM}: type is the change kind, scope the area, outcome the observable behaviour after the change (what now works or no longer breaks); the PR title is the intended squash subject.`;
  }
  return undefined;
}

export function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
  } catch {
    return;
  }
  const reason = decide(payload);
  if (reason === undefined) return;
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

if (import.meta.main) main();
