// The agent-side client of the host heavy-job gate in any repository: a PreToolUse Bash hook that sends
// a test run, build, package install or browser test through `heavy-gate run` (scripts/host/heavy-gate.ts),
// so every project on the host waits for a slot instead of piling onto a loaded laptop. Claude Code gets
// the command rewritten through updatedInput; Codex (`--codex`) gets a refusal naming the wrapped command
// to run instead. A heavy form in watch or server mode is gated like any other run: the gate holds its
// slot for one lease (KRN_GATE_LEASE_S) and lets it run on, so no command guesses which runs end. It passes a command
// already inside the gate, KRN's own checkouts (fast and the Stop hook gate themselves) and the
// excluded repositories (wilq-seo is never gated). The host config ($XDG_CONFIG_HOME/krn/heavy-gate.json,
// untracked) adds excluded repository names and patterns of the host's own heavy jobs (a project's
// replay or judge script); KRN_HEAVY_GATE_EXCLUDE replaces the excluded names.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hookStdin } from '../harness/claude.ts';
import { slotHeld } from '../repo/host-gate.ts';
import { shellWord } from '../repo/shell-text.ts';
import { commands, commandsOf, readShell, type Word } from './shell-reader.ts';

/** Repositories (by directory name) whose commands are never gated. */
export const DEFAULT_EXCLUDE = ['wilq-seo'];

/** The gate entry of the checkout this hook runs from. */
export const gateEntry = fileURLToPath(
  new URL('../../bin/heavy-gate', import.meta.url),
);

const pkg = '(?:npm|pnpm|yarn|bun)';
const heavyForms: RegExp[] = [
  new RegExp(String.raw`^${pkg} (?:test|t|install|i|ci|add)(?:\s|$)`, 'u'),
  new RegExp(
    String.raw`^${pkg} (?:run )?(?:test|build|check|lint|typecheck|e2e|fast)[\w:.-]*(?:\s|$)`,
    'u',
  ),
  /^(?:npx |pnpm exec |pnpm dlx |yarn |bunx )?(?:playwright test|vitest|jest|tsc|next build|vite build)(?:\s|$)/u,
  /^node (?:\S+ )*--test(?:\s|$)/u,
  /^(?:uv run |poetry run )?(?:python3? -m )?pytest(?:\s|$)/u,
  /^cargo (?:build|test|check|clippy)(?:\s|$)/u,
  /^go (?:build|test|vet)(?:\s|$)/u,
  /^composer (?:install|update)(?:\s|$)/u,
  /^mise run (?:test|check|build|e2e)[\w:.-]*(?:\s|$)/u,
  /^docker (?:build|compose build)(?:\s|$)/u,
];
const wrappers = new Set(['time', 'nice', 'exec', 'command', 'env']);

const pattern = z.string().refine((source) => {
  try {
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');
const hostConfigSchema = z.object({
  exclude: z.array(z.string().min(1)).default([]),
  heavy: z.array(pattern).default([]),
});
export type HostConfig = z.infer<typeof hostConfigSchema>;
const emptyConfig: HostConfig = { exclude: [], heavy: [] };

/** The host config path: $XDG_CONFIG_HOME/krn/heavy-gate.json, else ~/.config/krn/heavy-gate.json. */
export function hostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'krn',
    'heavy-gate.json',
  );
}

/** The host config; an absent file is the empty config, an invalid one is named on stderr and ignored. */
export function hostConfig(path: string): HostConfig {
  if (!existsSync(path)) return emptyConfig;
  try {
    return hostConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    process.stderr.write(
      `heavy-command: ignoring ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return emptyConfig;
  }
}

/** One command's words past `VAR=value` prefixes and wrappers (`time`, `nice -n 5`, `timeout 600`), joined. */
function program(words: readonly string[]): string {
  let i = 0;
  for (;;) {
    const word = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) i += 1;
    else if (wrappers.has(word)) {
      i += 1;
      while ((words[i] ?? '').startsWith('-')) i += 1;
      if (word === 'nice' && /^\d+$/u.test(words[i] ?? '')) i += 1;
    } else if (word === 'timeout') {
      i += 1;
      while ((words[i] ?? '').startsWith('-')) i += 1;
      i += 1;
    } else break;
  }
  return words.slice(i).join(' ');
}

/** The programs of `command` as text; quoted text and heredoc bodies are data, not commands. */
function programs(command: string): string[] {
  return commandsOf(command).map(({ words }) =>
    program(words.map((word) => word.text)),
  );
}

/** True when one of the commands of `command` is a heavy job (test run, build, install, browser test, or a host pattern) that ends on its own. */
export function isHeavy(
  command: string,
  extra: readonly string[] = [],
): boolean {
  const forms = [
    ...heavyForms,
    ...extra.map((source) => new RegExp(source, 'u')),
  ];
  return programs(command).some((text) =>
    forms.some((form) => form.test(text)),
  );
}

/** The repository directory holding `dir`: the nearest ancestor with a `.git` entry, else `dir`. */
function repoRoot(dir: string): string {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return dir;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The paths `dir` belongs to: itself and, inside a linked worktree, the git dir its `.git` file points at. */
function homes(dir: string): string[] {
  const root = repoRoot(dir);
  const git = join(root, '.git');
  if (!existsSync(git) || statSync(git).isDirectory()) return [dir];
  const target = /^gitdir:\s*(.+)$/mu.exec(readFileSync(git, 'utf8'))?.[1];
  return target ? [dir, resolve(root, target.trim())] : [dir];
}

const dirFlag = /^(?:-C|--prefix|--dir|--cwd)(?:=(.+))?$/u;

/**
 * The directories `command` runs in besides its cwd: `cd` and `pushd` operands and the values of
 * `-C`, `--prefix`, `--dir` and `--cwd`. A word in a comment, a message or a file argument is none.
 */
function runDirs(command: string, extra: readonly string[]): string[] {
  const found: string[] = [];
  let depth = 0;
  const all: { words: readonly Word[]; forked: boolean }[] = [];
  for (const step of readShell(command)) {
    if (step.kind === 'open') depth += 1;
    else if (step.kind === 'close') depth -= 1;
    else if (step.command.words.length > 0)
      all.push({
        words: step.command.words,
        forked: step.command.forked || depth > 0,
      });
  }
  // A `cd` in a subshell, substitution or pipeline stage does not move the commands of the parent shell:
  // it counts only while no heavy command runs in the parent.
  const parentHeavy = all.some(
    ({ words, forked }) =>
      !forked && isHeavy(words.map((word) => word.text).join(' '), extra),
  );
  for (const { words: tokens, forked } of all) {
    const words = tokens.map((word) => word.text);
    const comment = words.findIndex((word) => word.startsWith('#'));
    const live = comment < 0 ? words : words.slice(0, comment);
    const first = live.findIndex(
      (word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word),
    );
    const name = live[first];
    if ((name === 'cd' || name === 'pushd') && !(forked && parentHeavy)) {
      const operand = live.slice(first + 1).find((w) => !w.startsWith('-'));
      if (operand) found.push(operand);
    }
    live.forEach((word, at) => {
      const flag = dirFlag.exec(word);
      const value = flag && (flag[1] ?? live[at + 1]);
      if (value) found.push(value);
    });
  }
  return found;
}

/** Why the command is left alone in `cwd`, else undefined. */
export function exemption(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: HostConfig = emptyConfig,
): string | undefined {
  if (slotHeld(env)) return 'already inside a gate slot';
  // Already gated only when every heavy command runs inside a gate call: a `$(heavy-gate status)`
  // beside an ungated `npm test` exempts nothing.
  const all = commands(command);
  const viaGate = (words: string[]) =>
    basename(program(words).split(' ')[0] ?? '') === 'heavy-gate';
  if (
    all.some(viaGate) &&
    !all.some(
      (words) => !viaGate(words) && isHeavy(words.join(' '), config.heavy),
    )
  )
    return 'already gated';
  const exclude =
    env.KRN_HEAVY_GATE_EXCLUDE === undefined
      ? [...DEFAULT_EXCLUDE, ...config.exclude]
      : env.KRN_HEAVY_GATE_EXCLUDE.split(',')
          .map((name) => name.trim())
          .filter(Boolean);
  const dir = real(cwd);
  const segments = [
    dir,
    ...runDirs(command, config.heavy).map((to) => real(resolve(dir, to))),
  ]
    .flatMap(homes)
    .flatMap((path) => path.split(sep));
  const named = exclude.find((name) => segments.includes(name));
  if (named) return `${named} is never gated`;
  if (existsSync(join(repoRoot(dir), 'scripts', 'host', 'heavy-gate.ts')))
    return 'KRN gates its own checks';
  return undefined;
}

/** The deadline for the slot wait: half the Bash timeout in the foreground, half an hour in the background. */
export function deadlineMs(input: Record<string, unknown>): number {
  if (input.run_in_background === true) return 30 * 60 * 1000;
  const timeout = typeof input.timeout === 'number' ? input.timeout : 120_000;
  return Math.max(10_000, Math.floor(timeout / 2));
}

/**
 * The command run through the gate as one unit: one slot lease wraps the whole original text, which the
 * child shell runs unchanged. The step reader only decides that a command is heavy; no part of the text
 * is cut out or rewritten, so pipes across newlines, heredocs, comments, wrappers and shell state set
 * by an earlier step reach the heavy step as they do without the gate. No permission decision is made,
 * so the normal permission flow applies to it.
 */
export function gated(
  command: string,
  deadline: number,
  gate = gateEntry,
): string {
  return `${shellWord(gate)} run --deadline-ms ${deadline} -- bash -c ${shellWord(command)}`;
}

export type Verdict = { rewrite: string } | undefined;

/** The rewrite for a Bash payload, or undefined to let it through unchanged. */
export function judge(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  config: HostConfig = hostConfig(hostConfigPath(env)),
): Verdict {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { tool_name, tool_input, cwd } = payload as Record<string, unknown>;
  if (tool_name !== 'Bash' || typeof tool_input !== 'object' || !tool_input)
    return undefined;
  const input = tool_input as Record<string, unknown>;
  const command = input.command;
  if (typeof command !== 'string' || !isHeavy(command, config.heavy))
    return undefined;
  const dir = typeof cwd === 'string' ? cwd : process.cwd();
  if (exemption(command, dir, env, config)) return undefined;
  const rewrite = gated(command, deadlineMs(input));
  return rewrite === command ? undefined : { rewrite };
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
  } catch {
    return;
  }
  const verdict = judge(payload);
  if (!verdict) return;
  if (argv.includes('--codex')) {
    process.stderr.write(
      `Refused: this is a heavy job (test run, build, install or browser test) and the host shares one heavy-job gate across all projects. Nothing ran. Run it through the gate instead, unchanged otherwise:\n${verdict.rewrite}\n(the gate waits for a free slot; exit 75 means the host stayed busy past the deadline: rerun later or in the background)\n`,
    );
    process.exitCode = 2;
    return;
  }
  const input = (payload as { tool_input: Record<string, unknown> }).tool_input;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...input, command: verdict.rewrite },
      },
    })}\n`,
  );
}

if (import.meta.main) main();
