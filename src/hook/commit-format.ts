// The agent-side check of the commit subject and PR title format in any repository: a PreToolUse Bash
// hook that refuses `git commit` and `gh pr create|edit` whose subject or title breaks the format of
// src/repo/commit-title.ts. It runs only on agent tool calls (user-scope Claude Code and Codex hooks,
// and KRN's own pre-tool event), never as a git hook, so the operator's own terminal commits pass.
// A call whose subject cannot be read from the command line (-F, editor, --no-edit, a shell
// variable) passes: the hook judges only text it can see.
import { hookStdin } from '../harness/claude.ts';
import { TITLE_FORM, titleProblem } from '../repo/commit-title.ts';
import {
  commandsOf,
  gitCall,
  programName,
  resolveCommand,
  type Word,
} from './shell-reader.ts';

/** The words after `program`, past `VAR=value` prefixes and the env, command and exec wrappers; undefined when the program differs or no command runs. */
function argsOf(
  words: readonly Word[],
  program: string,
): readonly Word[] | undefined {
  const resolved = resolveCommand(words);
  if (resolved === undefined || programName(resolved.argv[0]) !== program)
    return undefined;
  return resolved.argv.slice(1);
}

/** The value of a flag at `i` (`-m X`, `-mX`, `--message=X`, `-am X`); undefined when it is not one. */
function flagValue(
  args: readonly Word[],
  i: number,
  long: string,
  short: string,
): Word | undefined {
  const word = args[i];
  const arg = word?.text ?? '';
  const next = args[i + 1] ?? { text: '', expands: false, quoted: false };
  if (arg === long || arg === `-${short}`) return next;
  if (arg.startsWith(`${long}=`))
    return { ...(word as Word), text: arg.slice(long.length + 1) };
  const cluster = new RegExp(`^-[a-zA-Z]*${short}(.*)$`, 'su').exec(arg);
  if (cluster && !arg.startsWith('--')) {
    const rest = cluster[1] ?? '';
    return rest === '' ? next : { ...(word as Word), text: rest };
  }
  return undefined;
}

/** The subject `git commit` would record from its first -m, when the command line holds it. */
export function commitSubject(words: readonly Word[]): string | undefined {
  const resolved = resolveCommand(words);
  const git = resolved && gitCall(resolved.argv);
  if (git?.verb !== 'commit') return undefined;
  const args = git.args;
  for (let j = 0; j < args.length; j++) {
    const arg = args[j]?.text ?? '';
    if (arg === '--') return undefined;
    if (
      /^(?:-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash)(?:=|$)/u.test(
        arg,
      )
    )
      return undefined;
    const found = flagValue(args, j, '--message', 'm');
    if (found === undefined) continue;
    if (found.expands) return undefined;
    return found.text.split('\n')[0]?.trim();
  }
  return undefined;
}

/** The title `gh pr create|edit` sets, when the command line holds it. */
export function prTitle(words: readonly Word[]): string | undefined {
  const gh = argsOf(words, 'gh');
  if (gh?.[0]?.text !== 'pr' || !['create', 'edit'].includes(gh[1]?.text ?? ''))
    return undefined;
  const args = gh.slice(2);
  for (let j = 0; j < args.length; j++) {
    const found = flagValue(args, j, '--title', 't');
    if (found === undefined) continue;
    if (found.expands) return undefined;
    return found.text;
  }
  return undefined;
}

const MESSAGE_FROM_ELSEWHERE =
  /^(?:-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash)(?:=|$)/u;

/** An opaque command that runs `git commit` with a message it does not take from a file or another commit. */
function opaqueCommit(words: readonly Word[]): boolean {
  const texts = words.map((word) => word.text);
  if (!texts.some((text) => /\bgit\b/u.test(text))) return false;
  if (!texts.some((text) => /\bcommit\b/u.test(text))) return false;
  return !texts.some((text) => MESSAGE_FROM_ELSEWHERE.test(text));
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
  for (const { words, opaque } of commandsOf(command)) {
    if (opaque !== undefined && opaqueCommit(words))
      return `Refused: the commit message cannot be read because the command uses ${opaque}. Write the message as -m '<subject>' or pass -F <file>.`;
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
