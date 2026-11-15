import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, hookProjectDir } from '../harness/claude.ts';
import { TASKS_DIR } from '../task/paths.ts';

// PreToolUse hook for Write, Edit, NotebookEdit and Bash: a worker session may not write the tracker or
// the roadmap unless the brief's Scope names them; a harness file outside Scope is allowed and reported (KRN-11: only the lead changes
// tracker state). D23 arm K, running as the lead, edited tasks/, the roadmap and harness files outside Scope
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

export function worker(
  env: NodeJS.ProcessEnv,
  root: string,
  branch = '',
  payload?: unknown,
): Worker | undefined {
  const lane = env.KRN_SESSION_CLASS === 'lane';
  if (!lane && env.KRN_ROLE !== 'worker' && !isLaneSubagent(payload))
    return undefined;
  if (env.KRN_SCOPE !== undefined) return { scope: parseScope(env.KRN_SCOPE) };
  const id = env.KRN_TASK ?? taskId(branch) ?? taskId(root);
  const scope = id === undefined ? undefined : taskScope(root, id);
  if (scope) return { scope };
  if (!lane) return { scope: [] };
  if (id === undefined && !env.KRN_LANE)
    return { scope: [], unidentified: true };
  return { scope: [], unscoped: true };
}

// Write targets a Bash command shows cheaply: redirections, tee and sed -i operands.
function bashTargets(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(
    /(?:^|[^>&\d])\d*>>?\s*(["']?)([^\s"'|;&<>]+)\1/gu,
  ))
    found.push(match[2] as string);
  for (const match of command.matchAll(/\btee\s+(?:-\w+\s+)*([^\s|;&<>]+)/gu))
    found.push(match[1] as string);
  for (const match of command.matchAll(
    /\bsed\s+(?:-\w+\s+)*-i\S*\s+(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)/gu,
  ))
    found.push(match[1] as string);
  return found.filter((target) => target !== '/dev/null');
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

export interface Verdict {
  refusal?: string;
  note?: string;
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
      targets.push(...bashTargets(input.command));
  } else return {};
  const escaped = targets.find((target) =>
    outsideOwnWorktree(
      root,
      isAbsolute(target) ? target : resolve(cwd, target),
    ),
  );
  if (escaped !== undefined)
    return {
      refusal: `Refused: ${escaped} is in the main checkout, outside this lane's worktree (${root}). Nothing in this call ran. Write under your own worktree or .krn/runs/ (src/hook/scope.ts).`,
    };
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

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd: hookProjectDir(),
    encoding: 'utf8',
  }).stdout;
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
