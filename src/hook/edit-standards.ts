// PreToolUse hook on Edit|Write|MultiEdit|Bash (`krn hook edit`): the first edit of a file kind (its stack, else
// its extension) in a session brings the records scoped to that file (its stack or a path pattern it
// matches) as additional context, at most EDIT_BUDGET tokens. A later edit of the same kind adds only records not yet
// shown; a record the session was already shown or withheld (any exposure of this session's run in the log) never
// repeats; one in 10 is withheld by the holdout and logged as such, so `krn standards effect` counts the
// edit moment. Headless lane sessions edit through Bash (a python or sed one-liner) as often as through
// Edit, so a Bash command that names a repository file of a kind counts as touching that kind. Any failure
// leaves the edit untouched.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  appendExposure,
  readExposures,
  servedExposure,
} from '../brain/exposures.ts';
import { SERVE_POLICY } from '../brain/packet.ts';
import type { Standard } from '../brain/standards.ts';
import { taskKey } from '../brain/task-query.ts';
import {
  EDIT_BUDGET,
  editLine,
  editRecords,
  fileStack,
  heldOut,
  queryStandards,
  withinBudget,
} from '../brain/worker-packet.ts';
import { emitContext, hookInput, hookStdin } from '../harness/claude.ts';
import { PATH_WORD } from './edit-route.ts';
import { ruleViolations, writtenText } from './edit-rules.ts';
import { taskId } from './scope.ts';

/** The exposure channel of the edit moment. */
export const EDIT_CHANNEL = 'edit';

/** The repository-relative path a PreToolUse payload edits, or undefined for another tool or a file outside `project`. */
export function editedFile(
  project: string,
  payload: Record<string, unknown>,
): string | undefined {
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null) return undefined;
  const path = (input as Record<string, unknown>).file_path;
  if (typeof path !== 'string' || path === '') return undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : project;
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const inside = relative(project, absolute);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    return undefined;
  return inside.split(sep).join('/');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The repository-relative files a Bash payload's command names, in order and once each: a word that
 * resolves inside `project` and is an existing file or has a stack's extension (a file the command
 * creates). Empty for another tool.
 */
export function commandFiles(
  project: string,
  payload: Record<string, unknown>,
): string[] {
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null) return [];
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string') return [];
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : project;
  const files: string[] = [];
  for (const [word] of command.matchAll(PATH_WORD)) {
    const absolute = isAbsolute(word) ? word : resolve(cwd, word);
    const inside = relative(project, absolute);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
      continue;
    const file = inside.split(sep).join('/');
    if (files.includes(file)) continue;
    if (isFile(absolute) || fileStack(file) !== undefined) files.push(file);
  }
  return files;
}

/**
 * The records scoped to `file`, the ones the task's words match first. The scope list alone ranks by tier,
 * so a file with dozens of scoped records buried the one the work needed (3 of 12 reachable labels in the
 * first five); the task's title and Outcome rank them the way a query does. Without task text the order is
 * the scope list's.
 */
export function editRecordsFor(
  project: string,
  file: string,
  asOf: string,
  taskText = '',
): Standard[] {
  const scoped = editRecords(project, file, asOf);
  if (taskText.trim() === '' || scoped.length < 2) return scoped;
  const order = queryStandards(project, {
    text: taskText,
    files: [file],
    asOf,
    budget: Number.MAX_SAFE_INTEGER,
  }).map((hit) => hit.id);
  const rank = (standard: Standard) => {
    const at = order.indexOf(standard.id);
    return at < 0 ? order.length : at;
  };
  return [...scoped].sort((a, b) => rank(a) - rank(b));
}

/** The retrieval text of the task a session works on: its title, Outcome and Files, or empty. */
function sessionTaskText(project: string, main: string, id: string): string {
  return (taskKey(project, id) ?? taskKey(main, id))?.text ?? '';
}

/** The kind of `file` the edit moment fires once for: its stack, else `*.<extension>`, else its name. */
export function fileKind(file: string): string {
  const stack = fileStack(file);
  if (stack !== undefined) return stack;
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `*${name.slice(dot).toLowerCase()}` : name;
}

/**
 * The block for one edit of `file` in session `sessionId`, or undefined when no record scoped to the
 * file's kind is new to the session. Served and withheld records are logged under the session's run.
 * The holdout is keyed by `holdoutKey` (the task, so a retried session lands in the same arm), else the session.
 */
export function editContext(
  project: string,
  main: string,
  sessionId: string,
  file: string,
  asOf: string = new Date().toISOString().slice(0, 10),
  holdoutKey: string = sessionId,
  taskText = '',
): string | undefined {
  const kind = fileKind(file);
  const own = readExposures(main).filter(
    (exposure) => exposure.run === sessionId,
  );
  const shown = new Set(
    own.flatMap((exposure) => [...exposure.served, ...exposure.withheld]),
  );
  const fresh = editRecordsFor(project, file, asOf, taskText).filter(
    (standard) => !shown.has(standard.id),
  );
  if (fresh.length === 0) return undefined;
  // The would-serve set is what the budget admits without the holdout; withheld is that set's held-out part.
  const wouldServe = withinBudget(fresh, EDIT_BUDGET);
  const withheld = wouldServe
    .filter((standard) => heldOut(holdoutKey, standard.id))
    .map((standard) => standard.id);
  const served = withinBudget(
    fresh.filter((standard) => !heldOut(holdoutKey, standard.id)),
    EDIT_BUDGET,
  );
  try {
    appendExposure(main, {
      ...servedExposure(
        sessionId,
        EDIT_CHANNEL,
        served.map((standard) => standard.id),
      ),
      withheld,
      scope: kind,
    });
  } catch {
    /* The log is evidence, never a reason to lose the block. */
  }
  if (served.length === 0) return undefined;
  return `Standards for editing ${file} (${served.length}; ${SERVE_POLICY}):\n${served.map(editLine).join('\n')}`;
}

/** The main checkout of `project` (the worktree's common directory's parent). */
function mainCheckout(project: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return dirname(resolve(project, common));
}

export function main(): void {
  try {
    const raw = hookStdin();
    const input = hookInput(['PreToolUse'], raw);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const edited = editedFile(input.project, payload);
    const text = writtenText(payload);
    const violations =
      edited !== undefined && text !== undefined
        ? ruleViolations(edited, text)
        : [];
    const files =
      edited === undefined ? commandFiles(input.project, payload) : [edited];
    let blocks: string[] = [];
    try {
      const main = mainCheckout(input.project);
      const task = process.env.KRN_TASK ?? taskId(input.project);
      const taskText =
        task === undefined ? '' : sessionTaskText(input.project, main, task);
      blocks = files.flatMap(
        (file) =>
          editContext(
            input.project,
            main,
            input.sessionId,
            file,
            undefined,
            task ?? input.sessionId,
            taskText,
          ) ?? [],
      );
    } catch {
      /* A missing brain still lets the rule violations through. */
    }
    if (violations.length > 0)
      blocks.unshift(`Rule violations in this edit:\n${violations.join('\n')}`);
    if (blocks.length > 0) emitContext(input.event, blocks.join('\n\n'));
  } catch {
    /* A missing brain is not a reason to interrupt an edit. */
  }
}

if (import.meta.main) main();
