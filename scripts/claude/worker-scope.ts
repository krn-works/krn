import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PreToolUse hook for Write, Edit, NotebookEdit and Bash: a worker session may not write the tracker,
// the roadmap or the harness files unless the brief's Scope names them (KRN-11: only the lead changes
// tracker state). D23 arm K, running as the lead, edited tasks/, the roadmap and harness files outside Scope
// in 11 of 20 units.
// A session is a worker when `krn lane run` started it (KRN_SESSION_CLASS=lane) or the launcher set
// KRN_ROLE=worker. The lead sets neither, so it is never refused here.
// Scope comes from KRN_SCOPE (the brief's `Scope:` line or a comma list), else from the Scope line of
// tasks/<id>.json for the id in KRN_TASK, else for the task id in the worktree branch or directory name.
// A lane session whose scope cannot be resolved is allowed (nothing to compare with); a KRN_ROLE=worker
// session without a scope has an empty one.
export const guarded = [
  'tasks/',
  'docs/program/roadmap.md',
  '.agents/',
  '.claude/',
  'AGENTS.md',
  'CLAUDE.md',
];

/** The path entries of a Scope line or comma list. */
export function parseScope(text: string): string[] {
  const line =
    /^\s*Scope:\s*(.*)$/mu.exec(text)?.[1] ??
    (text.includes('\n') ? '' : text.replace(/^\s*Scope:\s*/u, ''));
  return line
    .split(/[,\n]/u)
    .map((entry) =>
      entry
        .replace(/[`'"]/gu, '')
        .trim()
        .replace(/\.$/u, '')
        .replace(/^\.\//u, ''),
    )
    .filter((entry) => /^[\w.@/-]+$/u.test(entry));
}

const covers = (scope: string[], path: string) =>
  scope.some((entry) =>
    entry.endsWith('/')
      ? path.startsWith(entry)
      : path === entry || path.startsWith(`${entry}/`),
  );

const isGuarded = (path: string) =>
  guarded.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );

export interface Worker {
  scope: string[];
}

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
export function worker(
  env: NodeJS.ProcessEnv,
  root: string,
  branch = '',
): Worker | undefined {
  const lane = env.KRN_SESSION_CLASS === 'lane';
  if (!lane && env.KRN_ROLE !== 'worker') return undefined;
  if (env.KRN_SCOPE !== undefined) return { scope: parseScope(env.KRN_SCOPE) };
  const id =
    env.KRN_TASK ??
    /t-[a-z0-9]{7}/u.exec(branch)?.[0] ??
    /t-[a-z0-9]{7}/u.exec(root)?.[0];
  const scope = id === undefined ? undefined : taskScope(root, id);
  if (scope) return { scope };
  return lane ? undefined : { scope: [] };
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

/** The refusal text, or undefined when the call is allowed. */
export function decide(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  branch = '',
): string | undefined {
  const fields = payload as {
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: Record<string, unknown>;
  } | null;
  if (!fields || typeof fields.tool_input !== 'object') return undefined;
  const root = resolve(
    env.CLAUDE_PROJECT_DIR ??
      (typeof fields.cwd === 'string' ? fields.cwd : process.cwd()),
  );
  const who = worker(env, root, branch);
  if (!who) return undefined;
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
  } else return undefined;
  for (const target of targets) {
    const path = relative(
      root,
      isAbsolute(target) ? target : resolve(cwd, target),
    );
    if (path.startsWith('..') || !isGuarded(path) || covers(who.scope, path))
      continue;
    return `Refused: ${path} is tracker, roadmap or harness state that only the lead changes, and the brief's Scope does not name it (${who.scope.join(', ') || 'no scope'}). Nothing in this call ran. Leave it unchanged and report the need in your final reply (scripts/claude/worker-scope.ts).`;
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
  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    encoding: 'utf8',
  }).stdout;
  const reason = decide(payload, process.env, branch);
  if (reason === undefined) return;
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
