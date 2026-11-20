import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, hookProjectDir, hookStdin } from '../harness/claude.ts';
import { TASKS_DIR } from '../task/paths.ts';
import {
  gitCall,
  programName,
  readShell,
  resolveCommand,
  type Word,
} from './shell-reader.ts';

// PreToolUse hook for Write, Edit, NotebookEdit and Bash: a worker session may not write the tracker
// unless the brief's Scope names them; a harness file outside Scope is allowed and reported (KRN-11: only the lead changes
// tracker state). D23 arm K, running as the lead, edited tasks/ and harness files outside Scope
// in 11 of 20 units.
// A session is a worker when `krn lane run` started it (KRN_SESSION_CLASS=lane) or the launcher set
// KRN_ROLE=worker. The lead sets neither, so it is never refused here.
// Scope comes from KRN_SCOPE (the brief's `Scope:` line or a comma list), else from the Scope line of
// tasks/<id>.json for the id in KRN_TASK, else for the task id in the worktree branch or directory name.
// An in-session krn-lane subagent is a worker too: its payload carries agent_type=krn-lane and agent_id
// while its environment is the lead's. Without a resolvable scope it has an empty one.
// A lane session whose scope cannot be resolved is allowed (nothing to compare with); a KRN_ROLE=worker
// session without a scope has an empty one.
// Tracker state is the lead's alone: a worker edit outside Scope is refused.
export const guarded = [`${TASKS_DIR}/`];
// Harness files outside Scope are allowed and reported: a red test that needs one must not stay red,
// and a refusal there left finished work uncommitted in D23 (units 470 and 547).
export const harness: readonly string[] = harnessPaths;

/**
 * The path entries of a Scope line or comma list. A prose entry ("delivery-lead skill text") names no path;
 * a path inside prose (".claude/settings.json autoCompactWindow") still counts.
 */
export function parseScope(text: string): string[] {
  const line =
    /^\s*Scope:\s*(.*)$/mu.exec(text)?.[1] ??
    (text.includes('\n') ? '' : text.replace(/^\s*Scope:\s*/u, ''));
  const found: string[] = [];
  for (const entry of line.split(/[,;\n]/u)) {
    for (const token of entry.split(/\s+/u)) {
      const path = token
        .replace(/[`'"()]/gu, '')
        .replace(/[.:]+$/u, '')
        .replace(/^\.\//u, '');
      if (/^[\w.@/-]+$/u.test(path) && /[/.]/u.test(path.replace(/^\./u, '')))
        found.push(path);
    }
  }
  return found;
}

const covers = (scope: string[], path: string) =>
  scope.some((entry) =>
    entry.endsWith('/')
      ? path.startsWith(entry)
      : path === entry || path.startsWith(`${entry}/`),
  );

const under = (list: readonly string[], path: string) =>
  list.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );

export interface Worker {
  scope: string[];
  /** A lane session with no scope to enforce (a goal lane, or a task whose brief names no Scope). */
  unscoped?: true;
  /** A lane session that names no task and no lane: refused, never treated as the lead. */
  unidentified?: true;
}

export const UNIDENTIFIED_LANE =
  'this lane session names no task: KRN_TASK (or KRN_LANE for a goal lane) is unset, so it cannot be told from the lead. Start it with `krn lane run`.';

function taskScope(root: string, id: string): string[] | undefined {
  try {
    const task = JSON.parse(
      readFileSync(resolve(root, 'tasks', `${id}.json`), 'utf8'),
    ) as { body?: string[] };
    return parseScope((task.body ?? []).join('\n'));
  } catch {
    return undefined;
  }
}

/**
 * Foreign paths the lead admitted for this lane: `lane-target: <path>` lines in the task record's body
 * (the brief), or the comma list in KRN_LANE_TARGET. A target covers the path and everything under it.
 */
export function laneTargets(
  env: NodeJS.ProcessEnv,
  root: string,
  branch = '',
): string[] {
  const found = (env.KRN_LANE_TARGET ?? '').split(',');
  const id = env.KRN_TASK ?? taskId(branch) ?? taskId(basename(root));
  if (id !== undefined) {
    try {
      const task = JSON.parse(
        readFileSync(resolve(root, 'tasks', `${id}.json`), 'utf8'),
      ) as { body?: string[] };
      for (const match of (task.body ?? [])
        .join('\n')
        .matchAll(/^\s*lane-target:\s*(\S+)/gimu))
        found.push(match[1] as string);
    } catch {
      // no task record: no admitted target
    }
  }
  return found
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((e) => resolve(e));
}

/** The worker identity of this session, or undefined for the lead. */
// A task id stands alone in a branch or path: `verdict-evidence` holds `t-evidenc`, which is no id.
const taskIdToken = /(?<![a-z0-9])t-[a-z0-9]{7}(?![a-z0-9])/u;

export function taskId(text: string): string | undefined {
  return taskIdToken.exec(text)?.[0];
}

/** Whether a hook payload comes from an in-session krn-lane subagent, which carries the lead's environment. */
export function isLaneSubagent(payload: unknown): boolean {
  const fields = payload as { agent_type?: unknown; agent_id?: unknown } | null;
  return (
    fields?.agent_type === 'krn-lane' && typeof fields.agent_id === 'string'
  );
}

/** True for a call of a lane or worker session, the only calls the Scope judges. */
function workerCall(env: NodeJS.ProcessEnv, payload: unknown): boolean {
  return (
    env.KRN_SESSION_CLASS === 'lane' ||
    env.KRN_ROLE === 'worker' ||
    isLaneSubagent(payload)
  );
}

export function worker(
  env: NodeJS.ProcessEnv,
  root: string,
  branch = '',
  payload?: unknown,
): Worker | undefined {
  if (!workerCall(env, payload)) return undefined;
  const lane = env.KRN_SESSION_CLASS === 'lane';
  if (env.KRN_SCOPE !== undefined) return { scope: parseScope(env.KRN_SCOPE) };
  const id = env.KRN_TASK ?? taskId(branch) ?? taskId(basename(root));
  const scope = id === undefined ? undefined : taskScope(root, id);
  if (scope) return { scope };
  if (!lane) return { scope: [] };
  if (id === undefined && !env.KRN_LANE)
    return { scope: [], unidentified: true };
  return { scope: [], unscoped: true };
}

// Redirections that open their target for writing; `>&` with a descriptor (`>&2`, `>&-`) duplicates one.
const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

/**
 * Where each write target lands: a `cd DIR` command moves the directory for the commands after it,
 * so `cd <worktree> && echo x > out` writes the worktree; a subshell or substitution runs in a copy
 * of the directory, so its `cd` ends at the `)`, and a pipeline member or `&` job never moves it.
 * `cd` and every target follow symlinks (`landing`); a descriptor device keeps its text and a word
 * the shell still expands stays opaque. Words come from the shared reader (shell-reader.ts).
 */
export function bashTargets(
  command: string,
  cwd: string,
  redirectsOnly = false,
  home = process.env.HOME ?? '',
): string[] {
  const found: string[] = [];
  let dir = cwd;
  const outer: string[] = [];
  const text = (word: Word) =>
    word.expands ? expandHome(word.text, home) : word.text;
  const opaque = (word: Word) => word.expands && /[$`]|^~/u.test(text(word));
  // The directory a `cd` or `-C` word moves `base` to.
  const move = (word: Word, base: string) =>
    text(word) === '-' || opaque(word) || unresolved(base)
      ? join(UNRESOLVED, text(word))
      : landing(text(word), base);
  const place = (word: Word, base: string) => {
    const target = text(word);
    if (target === '/dev/null' && !opaque(word)) return;
    if (!opaque(word) && isDevice(target)) found.push(target);
    else if (opaque(word) || (unresolved(base) && !isAbsolute(target)))
      found.push(join(UNRESOLVED, target));
    else found.push(landing(target, base));
  };
  for (const step of readShell(command)) {
    if (step.kind === 'open') {
      outer.push(dir);
      continue;
    }
    if (step.kind === 'close') {
      dir = outer.pop() ?? dir;
      continue;
    }
    const { words, redirects, forked } = step.command;
    for (const redirect of redirects)
      if (
        WRITE_OPS.has(redirect.op) &&
        !(redirect.op === '>&' && /^(?:\d+-?|-)$/u.test(redirect.target.text))
      )
        place(redirect.target, dir);
    const resolved = resolveCommand(words);
    if (resolved === undefined) continue;
    const base = resolved.chdirs.reduce<string>(
      (at, word) => move(word, at),
      dir,
    );
    const [head, ...rest] = resolved.argv;
    const name = programName(head);
    if (name === 'cd' || name === 'pushd') {
      if (forked || resolved.chdirs.length > 0) continue;
      const to = operands(rest)[0];
      if (to) dir = move(to, dir);
      else if (name === 'cd' && home) dir = landing(home, dir);
      continue;
    }
    for (const word of commandTargets(resolved.argv, redirectsOnly, (dirs) =>
      dirs.reduce<string>((at, word) => move(word, at), base),
    ))
      place(word.word, word.base ?? base);
  }
  return found;
}

/** Stands for a directory the hook cannot resolve; no allowed base lies under it. */
const UNRESOLVED = '/$unresolved';
const unresolved = (dir: string) =>
  dir === UNRESOLVED || dir.startsWith(`${UNRESOLVED}${sep}`);

/** `~`, `~/x`, `$HOME/x` and `${HOME}/x` name the home directory; any other expansion stays opaque. */
function expandHome(target: string, home: string): string {
  if (!home) return target;
  return target.replace(/^(?:~(?=\/|$)|\$HOME\b|\$\{HOME\})/u, home);
}

/**
 * Device files a write may name outside any worktree: the null sink and the session's own terminal and
 * descriptors, matched on the raw text. A lexical resolve cannot see that /dev/fd links to /proc/self/fd,
 * so `/dev/fd/../root/<path>` reaches any file and `/dev/fd/5/../1` is not /dev/fd/1.
 */
function isDevice(target: string): boolean {
  return /^\/dev\/(?:null|stdout|stderr|stdin|tty|zero|fd\/\d+)$/u.test(target);
}

/** The operands of an argument list: words that are not options, and every word after `--`. */
function operands(args: readonly Word[]): Word[] {
  const at = args.findIndex((word) => word.text === '--');
  const before = at < 0 ? args : args.slice(0, at);
  return [
    ...before.filter((word) => !word.text.startsWith('-') || word.text === '-'),
    ...(at < 0 ? [] : args.slice(at + 1)),
  ];
}

/** The files `sed -i` edits in place: operands after the script, or all of them when -e or -f gave it. */
function sedFiles(args: readonly Word[]): Word[] {
  let inPlace = false;
  let script = false;
  const rest: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as Word;
    const text = word.text;
    if (text === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (text.startsWith('--')) {
      if (/^--in-place(?:=|$)/u.test(text)) inPlace = true;
      if (/^--(?:expression|file)(?:=|$)/u.test(text)) {
        script = true;
        if (!text.includes('=')) i++;
      } else if (/^--line-length$/u.test(text)) i++;
      continue;
    }
    if (!text.startsWith('-') || text === '-') {
      rest.push(word);
      continue;
    }
    for (let j = 1; j < text.length; j++) {
      const letter = text[j];
      if (letter === 'i') {
        inPlace = true;
        break;
      }
      if (letter === 'e' || letter === 'f' || letter === 'l') {
        if (letter !== 'l') script = true;
        if (j + 1 === text.length) i++;
        break;
      }
    }
  }
  if (!inPlace) return [];
  return script ? rest : rest.slice(1);
}

/**
 * Write targets a command's words show when its program heads it: tee and sed -i operands; rm, mv and cp operands, git -C directories and git add/checkout --/commit paths when the
 * program heads it. Anything else is unknown and allowed. `at` resolves a git -C chain to its base.
 */
function commandTargets(
  argv: readonly Word[],
  redirectsOnly: boolean,
  at: (dirs: readonly Word[]) => string,
): { word: Word; base?: string }[] {
  const found: { word: Word; base?: string }[] = [];
  const after = (program: string) =>
    programName(argv[0]) === program ? argv.slice(1) : undefined;
  const tee = after('tee');
  if (tee) for (const word of operands(tee)) found.push({ word });
  if (redirectsOnly) return found;
  const sed = after('sed');
  if (sed) for (const word of sedFiles(sed)) found.push({ word });
  const [head, ...rest] = argv;
  const name = programName(head);
  if (name === 'rm' || name === 'mv')
    for (const word of operands(rest)) found.push({ word });
  else if (name === 'cp') {
    // `cp -t DIR SRC...` writes DIR/<name of each SRC>; otherwise the last operand is the target.
    const dash = rest.findIndex((word) => word.text === '--');
    const flag = (dash < 0 ? rest : rest.slice(0, dash)).findIndex((word) =>
      /^(?:-t|--target-directory(?:=|$))/u.test(word.text),
    );
    const text = rest[flag]?.text ?? '';
    const attached =
      text.includes('=') || (text.startsWith('-t') && text.length > 2);
    const into =
      flag < 0
        ? undefined
        : attached
          ? {
              ...(rest[flag] as Word),
              text: text.replace(/^(?:-t|--target-directory=)/u, ''),
            }
          : rest[flag + 1];
    if (flag < 0) {
      const last = operands(rest).at(-1);
      if (last) found.push({ word: last });
    } else if (into) {
      const sources = operands(
        rest.filter(
          (_, index) => index !== flag && (attached || index !== flag + 1),
        ),
      );
      for (const source of sources)
        found.push({
          word: { ...into, text: `${into.text}/${basename(source.text)}` },
        });
    }
  }
  const git = gitCall(argv);
  if (git) {
    for (const [index, dir] of git.dirs.entries())
      found.push({ word: dir, base: at(git.dirs.slice(0, index)) });
    const base = at(git.dirs);
    const args = git.args;
    if (git.verb === 'add')
      for (const word of operands(args)) found.push({ word, base });
    else if (git.verb === 'checkout') {
      const dash = args.findIndex((word) => word.text === '--');
      if (dash >= 0)
        for (const word of args.slice(dash + 1)) found.push({ word, base });
    } else if (git.verb === 'commit')
      found.push({ word: { text: '.', expands: false, quoted: false }, base });
  }
  return found;
}

/** Most symlinks one path may pass through, as Linux allows (MAXSYMLINKS); past it the kernel fails ELOOP. */
const MAX_LINKS = 40;

/**
 * Where a write to `target` lands, walked component by component as the kernel does: each existing
 * symlink is replaced by its target (a dangling one too, since open(O_CREAT) follows it), `..` steps
 * out of the resolved directory, never the spelled one (`link/../x` is beside the link's target), and a
 * missing component is kept as spelled, since it holds no link yet. Every guard here compares landing
 * paths only: a prefix test on the spelling let `/dev/../<other repo>`, `/dev/fd/../root` and a link
 * inside the worktree write outside it. A link loop lands nowhere the hook can check.
 */
export function landing(target: string, cwd: string): string {
  const split = (path: string) =>
    path.split(sep).filter((part) => part !== '' && part !== '.');
  const pending = split(isAbsolute(target) ? target : `${cwd}${sep}${target}`);
  let at: string = sep;
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '..') {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    const stat = lstatSync(next, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) {
      at = next;
      continue;
    }
    if (++links > MAX_LINKS) return join(UNRESOLVED, target);
    let link: string;
    try {
      link = readlinkSync(next);
    } catch {
      at = next;
      continue;
    }
    if (isAbsolute(link)) at = sep;
    pending.unshift(...split(link));
  }
  return at;
}

/** True when `target` is `base` or below it; both are landing paths. */
function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
}

/**
 * The first target under none of the allowed bases: a descriptor device is never outside, a target the
 * shell still expands always is.
 */
function outside(
  targets: readonly string[],
  allowed: readonly string[],
): string | undefined {
  const bases = allowed.map((base) => landing(base, sep));
  return targets.find(
    (target) =>
      !isDevice(target) &&
      (unresolved(target) || !bases.some((base) => inside(base, target))),
  );
}

const worktreeMarker = `${sep}.krn${sep}worktrees${sep}`;

/** The harness scratchpad, which lives under CLAUDE_CODE_TMPDIR. */
const scratchpad = (env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CODE_TMPDIR ? [env.CLAUDE_CODE_TMPDIR] : [];

/**
 * A lane runs in <main>/.krn/worktrees/<slug>. A write under <main> that is neither inside that
 * worktree nor under <main>/.krn/runs lands in the main checkout (the ci-wait lane did this).
 * A session whose root is not a KRN worktree has no main checkout to protect. Both are landing paths.
 */
export function outsideOwnWorktree(root: string, target: string): boolean {
  const at = root.indexOf(worktreeMarker);
  if (at < 0) return false;
  const main = root.slice(0, at);
  return (
    inside(main, target) &&
    !inside(root, target) &&
    !inside(join(main, '.krn', 'runs'), target)
  );
}

/**
 * An in-session krn-lane subagent carries the lead's environment, so its root is the main checkout
 * itself. Any write there outside <main>/.krn (runs, worktrees) belongs in its worktree instead.
 */
export function inMainCheckout(root: string, target: string): boolean {
  if (root.includes(worktreeMarker)) return false;
  return inside(root, target) && !inside(join(root, '.krn'), target);
}

/**
 * Output a worker redirects (`>`, `>>`, `tee`) to an absolute path belongs in its worktree: the scratch rule
 * keeps logs under <worktree>/.krn/tmp. A lane redirected `krn pr ship` to /tmp/x (2026-11-17, t-gv984e8).
 * Outside the worktree stay allowed: descriptor devices and the harness scratchpad.
 */
export function strayRedirect(
  command: string,
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): string | undefined {
  const at = root.indexOf(worktreeMarker);
  return outside(bashTargets(command, landing(cwd, sep), true, env.HOME), [
    root,
    ...extra,
    ...(at < 0 ? [] : [join(root.slice(0, at), '.krn', 'runs')]),
    ...scratchpad(env),
  ]);
}

export interface Verdict {
  refusal?: string;
  note?: string;
}

/**
 * A landing target outside the lane's own worktree, in any repository: Edit, Write and Bash get the same verdict.
 * Allowed: the worktree, <main>/.krn/runs, the harness scratchpad, descriptor devices, and the lane-target paths.
 */
export function foreignTarget(
  root: string,
  targets: readonly string[],
  env: NodeJS.ProcessEnv,
  admitted: readonly string[],
): string | undefined {
  const at = root.indexOf(worktreeMarker);
  if (at < 0) return undefined;
  return outside(targets, [
    root,
    join(root.slice(0, at), '.krn', 'runs'),
    ...scratchpad(env),
    ...admitted,
  ]);
}

/** The refusal text, or undefined when the call is allowed. */
export function decide(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  branch = '',
): string | undefined {
  return judge(payload, env, branch).refusal;
}

/** The refusal of a tracker write, or the note about an allowed harness write outside Scope. */
export function judge(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  branch = '',
): Verdict {
  const fields = payload as {
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: Record<string, unknown>;
  } | null;
  if (!fields || typeof fields.tool_input !== 'object') return {};
  const root = landing(
    env.CLAUDE_PROJECT_DIR ??
      (typeof fields.cwd === 'string' ? fields.cwd : process.cwd()),
    process.cwd(),
  );
  const who = worker(env, root, branch, payload);
  if (!who) return {};
  if (who.unidentified) return { refusal: `Refused: ${UNIDENTIFIED_LANE}` };
  const cwd = typeof fields.cwd === 'string' ? resolve(fields.cwd) : root;
  const input = fields.tool_input;
  // Judged where each write lands, never by its spelling.
  const targets: string[] = [];
  const land = (path: string) => (isDevice(path) ? path : landing(path, cwd));
  if (fields.tool_name === 'Write' || fields.tool_name === 'Edit') {
    if (typeof input.file_path === 'string')
      targets.push(land(input.file_path));
  } else if (fields.tool_name === 'NotebookEdit') {
    if (typeof input.notebook_path === 'string')
      targets.push(land(input.notebook_path));
  } else if (fields.tool_name === 'Bash') {
    if (typeof input.command === 'string')
      targets.push(
        ...bashTargets(input.command, landing(cwd, sep), false, env.HOME),
      );
  } else return {};
  const escaped = targets.find((target) => outsideOwnWorktree(root, target));
  const admitted = laneTargets(env, root, branch);
  const foreign = foreignTarget(root, targets, env, admitted);
  if (foreign !== undefined && escaped === undefined)
    return {
      refusal: `Refused: ${foreign} is outside this lane's worktree (${root}). Nothing in this call ran. Write under your worktree; a foreign repository needs a \`lane-target: <path>\` line in the brief (src/hook/scope.ts).`,
    };
  if (escaped !== undefined)
    return {
      refusal: `Refused: ${escaped} is in the main checkout, outside this lane's worktree (${root}). Nothing in this call ran. Write under your own worktree or .krn/runs/ (src/hook/scope.ts).`,
    };
  if (fields.tool_name === 'Bash' && typeof input.command === 'string') {
    const stray = strayRedirect(
      input.command,
      resolve(cwd),
      root,
      env,
      admitted,
    );
    if (stray !== undefined)
      return {
        refusal: `Refused: ${stray} is outside this lane's worktree (${root}). Nothing in this call ran. Scratch rule: write logs and drafts under ${join(root, '.krn', 'tmp')}, never /tmp or another outside path (src/hook/scope.ts).`,
      };
  }
  if (isLaneSubagent(payload)) {
    const main = targets.find((target) => inMainCheckout(root, target));
    if (main !== undefined) {
      const marker = join(root, '.krn', 'worktrees');
      const own = relative(marker, resolve(cwd));
      const lane =
        own.startsWith('..') || isAbsolute(own) || own === ''
          ? ''
          : own.split(sep)[0];
      const where = lane ? join(marker, lane) : join(marker, '<lane>');
      return {
        refusal: `Refused: ${main} is in the main checkout, which a lane never writes. Nothing in this call ran. Write under your own worktree (${where}) or .krn/runs/ (src/hook/scope.ts).`,
      };
    }
  }
  if (who.unscoped) return {};
  const notes: string[] = [];
  for (const target of targets) {
    const path = relative(root, target);
    if (path.startsWith('..') || covers(who.scope, path)) continue;
    if (under(harness, path)) {
      notes.push(path);
      continue;
    }
    if (!under(guarded, path)) continue;
    return {
      refusal: `Refused: ${path} is tracker state that only the lead changes, and the brief's Scope does not name it (${who.scope.join(', ') || 'no scope'}). Nothing in this call ran. Leave it unchanged and report the need in your final reply (src/hook/scope.ts).`,
    };
  }
  return notes.length === 0
    ? {}
    : {
        note: `Allowed outside Scope: ${notes.join(', ')} (harness file). Keep it only if a named test is red without it, and name it in your final reply; otherwise revert it and stay inside Scope. Never leave a failing test behind to avoid it.`,
      };
}

export function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
  } catch {
    return;
  }
  // The branch names the task of a worker; a lead's call needs no git process.
  const branch = workerCall(process.env, payload)
    ? spawnSync('git', ['branch', '--show-current'], {
        cwd: hookProjectDir(),
        encoding: 'utf8',
      }).stdout
    : '';
  const { refusal, note } = judge(payload, process.env, branch);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
  } else if (note !== undefined)
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: note } })}\n`,
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
