import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, hookProjectDir, hookStdin } from '../harness/claude.ts';
import { TASKS_DIR } from '../task/paths.ts';

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

/** Drops heredoc bodies: their lines are data for the command, never commands themselves. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let terminator: string | undefined;
  for (const line of lines) {
    if (terminator !== undefined) {
      if (line.replace(/^\t+/u, '') === terminator) terminator = undefined;
      continue;
    }
    kept.push(line);
    const open = /<<-?\s*(["']?)([\w.-]+)\1/u.exec(line);
    if (open) terminator = open[2];
  }
  return kept.join('\n');
}

/**
 * Neutralises shell operators inside quotes: `'<task-id>'` or `"a > b"` is text, not a redirect.
 * Quoted paths keep their characters, so a quoted redirect target still resolves.
 */
function maskQuotes(command: string): string {
  return command.replace(/'[^']*'|"[^"]*"/gu, (quoted) =>
    quoted
      .slice(1, -1)
      .replace(/[<>|;&]/gu, '_')
      .replace(/\s/gu, '_'),
  );
}

// Write targets a Bash command shows cheaply: redirections, tee and sed -i operands.
function segmentTargets(segment: string, redirectsOnly = false): string[] {
  const found: string[] = [];
  // `>`, `>>`, `&>`, `&>>`, `>|`, `>&`, `<>` with an optional fd; `>&2` and `>&-` duplicate a descriptor.
  for (const match of segment.matchAll(
    /(?:^|[^>&\d<])(?:&|\d*)(?:>>?\|?|>&|<>)\s*([^\s|;&<>()]+)/gu,
  ))
    if (!/^\d+-?$|^-$/u.test(match[1] as string))
      found.push(match[1] as string);
  for (const match of segment.matchAll(/\btee\s+(?:-\w+\s+)*([^\s|;&<>]+)/gu))
    found.push(match[1] as string);
  if (redirectsOnly) return found.filter((target) => target !== '/dev/null');
  for (const match of segment.matchAll(
    /\bsed\s+(?:-\w+\s+)*-i\S*\s+(?:-e\s+)?\S+\s+(\S+)/gu,
  ))
    found.push(match[1] as string);
  found.push(...commandTargets(segment));
  return found.filter((target) => target !== '/dev/null');
}

/**
 * Write targets with the directory each one is relative to: a `cd DIR` segment moves the
 * directory for the segments after it, so `cd <worktree> && echo x > out` writes the worktree.
 */
export function bashTargets(
  command: string,
  cwd: string,
  redirectsOnly = false,
  home = process.env.HOME ?? '',
): string[] {
  const text = maskQuotes(stripHeredocs(command.replace(/\\\n/gu, ' ')));
  const found: string[] = [];
  let dir = cwd;
  for (const segment of text.split(/&&|\|\||[;\n]|(?<![>&])&(?![>&])/u)) {
    const cd = /^\s*(?:cd|pushd)\s+(?:--\s+)?([^\s|]+)\s*$/u.exec(segment);
    if (cd) {
      const to = expandHome(cd[1] as string, home);
      // `cd -` and `cd $D` go where the hook cannot see: later relative targets stay opaque.
      dir = to === '-' || opaque(to) ? join(UNRESOLVED, to) : resolve(dir, to);
      continue;
    }
    for (const raw of segmentTargets(segment, redirectsOnly)) {
      const target = expandHome(raw, home);
      found.push(isAbsolute(target) ? target : resolve(dir, target));
    }
  }
  return found;
}

/** Stands for a directory the hook cannot resolve; no allowed base lies under it. */
const UNRESOLVED = '/$unresolved';

/** `~`, `~/x`, `$HOME/x` and `${HOME}/x` name the home directory; any other expansion stays opaque. */
function expandHome(target: string, home: string): string {
  if (!home) return target;
  return target.replace(/^(?:~(?=\/|$)|\$HOME\b|\$\{HOME\})/u, home);
}

/** A target whose text the shell still expands (`$T`, `` `cmd` ``, `~user`) names no path the hook can check. */
function opaque(target: string): boolean {
  return /[$`]|^~/u.test(target);
}

/**
 * Device files a write may name outside any worktree, matched on the raw text: a lexical resolve
 * cannot see that /dev/fd links to /proc/self/fd, so `/dev/fd/../root/<path>` reaches any file.
 */
function isDevice(target: string): boolean {
  return /^\/dev\/(?:null|stdout|stderr|stdin|tty|zero|fd\/\d+)$/u.test(target);
}

/** Operands of rm, mv, cp and git add/checkout --/commit; anything else is unknown and allowed. */
function commandTargets(command: string): string[] {
  const found: string[] = [];
  for (const segment of command.split(/[|]/u)) {
    const words = segment.trim().split(/\s+/u).filter(Boolean);
    const [name, ...rest] = words;
    const operands = (list: string[]) =>
      list.filter((word) => !word.startsWith('-'));
    if (name === 'git' && rest[0] === '-C' && rest[1]) found.push(rest[1]);
    if (name === 'rm' || name === 'mv') found.push(...operands(rest));
    else if (name === 'cp') found.push(...operands(rest).slice(-1));
    else if (name === 'git' && rest[0] === 'add')
      found.push(...operands(rest.slice(1)));
    else if (name === 'git' && rest[0] === 'checkout') {
      const at = rest.indexOf('--');
      if (at >= 0) found.push(...rest.slice(at + 1));
    } else if (name === 'git' && rest[0] === 'commit') found.push('.');
  }
  return found;
}

/**
 * A lane runs in <main>/.krn/worktrees/<slug>. A write under <main> that is neither inside that
 * worktree nor under <main>/.krn/runs lands in the main checkout (the ci-wait lane did this).
 * A session whose root is not a KRN worktree has no main checkout to protect.
 */
export function outsideOwnWorktree(root: string, target: string): boolean {
  const marker = `${sep}.krn${sep}worktrees${sep}`;
  const at = root.indexOf(marker);
  if (at < 0) return false;
  const main = root.slice(0, at);
  const inside = (base: string) => {
    const rel = relative(base, target);
    return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
  };
  return inside(main) && !inside(root) && !inside(join(main, '.krn', 'runs'));
}

/**
 * An in-session krn-lane subagent carries the lead's environment, so its root is the main checkout
 * itself. Any write there outside <main>/.krn (runs, worktrees) belongs in its worktree instead.
 */
export function inMainCheckout(root: string, target: string): boolean {
  if (root.includes(`${sep}.krn${sep}worktrees${sep}`)) return false;
  const inside = (base: string) => {
    const rel = relative(base, target);
    return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
  };
  return inside(root) && !inside(join(root, '.krn'));
}

/**
 * Output a worker redirects (`>`, `>>`, `tee`) to an absolute path belongs in its worktree: the scratch rule
 * keeps logs under <worktree>/.krn/tmp. A lane redirected `krn pr ship` to /tmp/x (2026-11-17, t-gv984e8).
 * Outside the worktree stay allowed: /dev/* and the harness scratchpad, which lives under CLAUDE_CODE_TMPDIR.
 */
export function strayRedirect(
  command: string,
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): string | undefined {
  const inside = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
  };
  const marker = `${sep}.krn${sep}worktrees${sep}`;
  const at = root.indexOf(marker);
  const allowed = [
    root,
    ...extra,
    ...(at < 0 ? [] : [join(root.slice(0, at), '.krn', 'runs')]),
    ...(env.CLAUDE_CODE_TMPDIR ? [resolve(env.CLAUDE_CODE_TMPDIR)] : []),
  ];
  return bashTargets(command, cwd, true, env.HOME).find(
    (target) =>
      !isDevice(target) &&
      (opaque(target) ||
        !allowed.some((base) => inside(base, resolve(cwd, target)))),
  );
}

export interface Verdict {
  refusal?: string;
  note?: string;
}

/**
 * A write target outside the lane's own worktree, in any repository: Edit, Write and Bash get the same verdict.
 * Allowed: the worktree, <main>/.krn/runs, the harness scratchpad, /dev/*, and the lane-target paths.
 */
export function foreignTarget(
  root: string,
  targets: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  admitted: readonly string[],
): string | undefined {
  const marker = `${sep}.krn${sep}worktrees${sep}`;
  const at = root.indexOf(marker);
  if (at < 0) return undefined;
  const inside = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
  };
  const allowed = [
    root,
    join(root.slice(0, at), '.krn', 'runs'),
    ...(env.CLAUDE_CODE_TMPDIR ? [resolve(env.CLAUDE_CODE_TMPDIR)] : []),
    ...admitted,
  ];
  return targets.find(
    (target) =>
      !isDevice(target) &&
      (opaque(target) ||
        !allowed.some((base) => inside(base, resolve(cwd, target)))),
  );
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
  const root = resolve(
    env.CLAUDE_PROJECT_DIR ??
      (typeof fields.cwd === 'string' ? fields.cwd : process.cwd()),
  );
  const who = worker(env, root, branch, payload);
  if (!who) return {};
  if (who.unidentified) return { refusal: `Refused: ${UNIDENTIFIED_LANE}` };
  const cwd = typeof fields.cwd === 'string' ? fields.cwd : root;
  const input = fields.tool_input;
  const targets: string[] = [];
  if (fields.tool_name === 'Write' || fields.tool_name === 'Edit') {
    if (typeof input.file_path === 'string') targets.push(input.file_path);
  } else if (fields.tool_name === 'NotebookEdit') {
    if (typeof input.notebook_path === 'string')
      targets.push(input.notebook_path);
  } else if (fields.tool_name === 'Bash') {
    if (typeof input.command === 'string')
      targets.push(
        ...bashTargets(input.command, resolve(cwd), false, env.HOME),
      );
  } else return {};
  const escaped = targets.find((target) =>
    outsideOwnWorktree(
      root,
      isAbsolute(target) ? target : resolve(cwd, target),
    ),
  );
  const admitted = laneTargets(env, root, branch);
  const foreign = foreignTarget(root, targets, cwd, env, admitted);
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
    const absolute = (target: string) =>
      isAbsolute(target) ? target : resolve(cwd, target);
    const main = targets.find((target) =>
      inMainCheckout(root, absolute(target)),
    );
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
    const path = relative(
      root,
      isAbsolute(target) ? target : resolve(cwd, target),
    );
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
