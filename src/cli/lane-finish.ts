import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { shipCommand } from '../ci/ship.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { repositoryRoot } from '../task/store.ts';
import { gitWith } from './lane-run/git.ts';
import { cliShipRuntime } from './pr.ts';
import { prBodyCommand } from './pr-body.ts';

/** Where a lane writes what its pull request body needs, inside its own worktree. */
export const LANE_NOTES_PATH = join('.krn', 'tmp', 'lane-notes.json');

export const laneNotesSchema = z
  .object({
    task: z.string().optional(),
    assumptions: z.string().optional(),
    weakensTests: z.string().optional(),
    verified: z.string().optional(),
  })
  .strict();
type LaneNotes = z.infer<typeof laneNotesSchema>;

function readNotes(worktree: string): LaneNotes {
  const file = join(worktree, LANE_NOTES_PATH);
  if (!existsSync(file)) return {};
  try {
    return laneNotesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new CliUsageError(
      `${file} is not valid lane notes (${error instanceof Error ? error.message : String(error)}); write {"assumptions","weakensTests","verified"} strings or delete the file`,
    );
  }
}

const gitText = gitWith((message) => new CliUsageError(message));

/** The trailer (`Ticket` before `Refs`) of the HEAD commit that names a task id. */
function trailerOf(
  worktree: string,
): { key: 'Ticket' | 'Refs'; id: string } | undefined {
  for (const key of ['Ticket', 'Refs'] as const) {
    const id = gitText(worktree, [
      'log',
      '-1',
      `--format=%(trailers:key=${key},valueonly,unfold)`,
    ])
      .split('\n')
      .map((line) => line.trim())
      .find((line) => isTaskId(line));
    if (id !== undefined) return { key, id };
  }
  return undefined;
}

export const laneFinishUsage =
  'krn lane finish SLUG [--root DIR] [--repo OWNER/REPO] [--force]  ship the pushed lane branch SLUG from its worktree: the title is the HEAD commit subject, the task and Ticket/Refs come from its trailer, and assumptions, Weakens-tests and verification come from .krn/tmp/lane-notes.json in the worktree when present; builds the body like `krn pr body --lane` and ships like `krn pr ship`';

export async function finishLane(
  rest: string[],
  runtime: Parameters<typeof shipCommand>[1] = {},
): Promise<string> {
  let slug: string | undefined;
  let root: string | undefined;
  let repo: string | undefined;
  let force = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--force') force = true;
    else if (arg === '--root' || arg === '--repo') {
      const value = flagValue(
        rest,
        index++,
        () => new CliUsageError(`${arg} requires a value`),
      );
      if (arg === '--root') root = value;
      else repo = value;
    } else if (arg.startsWith('--') || slug !== undefined)
      throw new CliUsageError(laneFinishUsage);
    else slug = arg;
  }
  if (slug === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(slug))
    throw new CliUsageError(
      `krn lane finish needs a lane slug\n${laneFinishUsage}`,
    );
  const main = mainCheckoutRoot(repositoryRoot(root ?? process.cwd()));
  const path = join(main, '.krn', 'worktrees', slug);
  if (!existsSync(path))
    throw new CliUsageError(
      `lane ${slug} has no worktree at ${path}; run git worktree list for the live lanes`,
    );
  const worktree = realpathSync(path);
  const notes = readNotes(worktree);
  const title = gitText(worktree, ['log', '-1', '--format=%s']);
  const trailer = trailerOf(worktree);
  const task = trailer?.id ?? notes.task;
  if (task === undefined || !isTaskId(task))
    throw new CliUsageError(
      `the HEAD commit of ${slug} has no Ticket or Refs trailer naming a task and the notes name none: amend the commit or set "task" in ${LANE_NOTES_PATH}`,
    );
  const tmp = join(worktree, '.krn', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const bodyFile = join(tmp, 'finish-body.md');
  const bodyArgs = ['--task', task, '--worktree', worktree, '--lane'];
  if (trailer?.key !== 'Ticket') bodyArgs.push('--refs');
  if (notes.verified) bodyArgs.push('--verified', notes.verified);
  if (notes.assumptions) bodyArgs.push('--assumptions', notes.assumptions);
  prBodyCommand([...bodyArgs, '--out', bodyFile]);
  if (notes.weakensTests)
    appendFileSync(bodyFile, `\nWeakens-tests: ${notes.weakensTests.trim()}\n`);
  const shipArgs = [
    '--title',
    title,
    '--body-file',
    bodyFile,
    '--worktree',
    worktree,
  ];
  if (repo !== undefined) shipArgs.push('--repo', repo);
  if (force) shipArgs.push('--force');
  return shipCommand(shipArgs, { ...cliShipRuntime, cwd: main, ...runtime });
}
