// PreToolUse hook on Edit|Write|MultiEdit (`krn hook edit`): the first edit of a file kind (its stack, else
// its extension) in a session brings the records scoped to that file (its stack or a path pattern it
// matches) as additional context, at most EDIT_BUDGET tokens. Later edits of the same kind add nothing; a
// record the session was already shown or withheld (any exposure of this session's run in the log) never
// repeats; one in 10 is withheld by the holdout and logged as such, so `krn standards effect` counts the
// edit moment. Any failure leaves the edit untouched.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  appendExposure,
  readExposures,
  servedExposure,
} from '../brain/exposures.ts';
import {
  EDIT_BUDGET,
  editLine,
  editRecords,
  fileStack,
  heldOut,
  withinBudget,
} from '../brain/worker-packet.ts';
import { emitContext, hookInput } from '../harness/claude.ts';

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
 */
export function editContext(
  project: string,
  main: string,
  sessionId: string,
  file: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): string | undefined {
  const kind = fileKind(file);
  const own = readExposures(main).filter(
    (exposure) => exposure.run === sessionId,
  );
  if (
    own.some(
      (exposure) =>
        exposure.channel === EDIT_CHANNEL && exposure.scope === kind,
    )
  )
    return undefined;
  const shown = new Set(
    own.flatMap((exposure) => [...exposure.served, ...exposure.withheld]),
  );
  const fresh = editRecords(project, file, asOf).filter(
    (standard) => !shown.has(standard.id),
  );
  if (fresh.length === 0) return undefined;
  const withheld = fresh
    .filter((standard) => heldOut(sessionId, standard.id))
    .map((standard) => standard.id);
  const served = withinBudget(
    fresh.filter((standard) => !heldOut(sessionId, standard.id)),
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
  return `Standards for editing ${file} (${served.length}):\n${served.map(editLine).join('\n')}`;
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
    const raw = readFileSync(0, 'utf8');
    const input = hookInput(['PreToolUse'], raw);
    const file = editedFile(
      input.project,
      JSON.parse(raw) as Record<string, unknown>,
    );
    if (file === undefined) return;
    const block = editContext(
      input.project,
      mainCheckout(input.project),
      input.sessionId,
      file,
    );
    if (block) emitContext(input.event, block);
  } catch {
    /* A missing brain is not a reason to interrupt an edit. */
  }
}

if (import.meta.main) main();
