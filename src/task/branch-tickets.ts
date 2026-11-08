import { spawnSync } from 'node:child_process';
import {
  isTaskId,
  type TaskId,
  type TaskRecord,
  TaskUsageError,
} from './record.ts';

/**
 * A `Ticket: <id>` trailer marks the branch that delivers the task, so that
 * branch must close it before it merges; work that leaves the task open
 * carries `Refs: <id>` instead. Returns one finding per ticket whose task is
 * open or missing in `index`, naming the commits in `base..head` that carry it.
 */
export function branchTicketFindings(
  root: string,
  index: ReadonlyMap<TaskId, TaskRecord>,
  base: string,
  head: string,
): string[] {
  const commitsByTicket = new Map<string, string[]>();
  for (const { commit, tickets } of ticketTrailers(root, base, head))
    for (const ticket of tickets) {
      const commits = commitsByTicket.get(ticket) ?? [];
      if (!commits.includes(commit)) commits.push(commit);
      commitsByTicket.set(ticket, commits);
    }
  const findings: string[] = [];
  for (const [ticket, commits] of commitsByTicket) {
    const carried = `Ticket: ${ticket} (${commits.join(', ')})`;
    const task = isTaskId(ticket) ? index.get(ticket) : undefined;
    if (task === undefined) findings.push(`${carried} names no task`);
    else if (task.status === 'open')
      findings.push(
        `${carried}: the task is open on this branch; close it with \`krn task close ${ticket} --as done --note TEXT\`, or use Refs: ${ticket} for work that leaves it open`,
      );
  }
  return findings;
}

function ticketTrailers(
  root: string,
  base: string,
  head: string,
): Array<{ commit: string; tickets: string[] }> {
  const range = `${commitOf(root, base, '--base')}..${commitOf(root, head, '--head')}`;
  const log = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'log.showSignature=false',
      'log',
      '--no-color',
      '--reverse',
      '--format=%h%x1f%(trailers:key=Ticket,valueonly,unfold,separator=%x1f)%x1e',
      range,
      '--',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (log.status !== 0)
    throw new TaskUsageError(`unable to read commits in ${range}`);
  return log.stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [commit = '', ...values] = record.split('\x1f');
      return {
        commit,
        tickets: values
          .flatMap((value) => value.split(/[\s,]+/u))
          .filter((ticket) => ticket !== ''),
      };
    });
}

function commitOf(root: string, revision: string, option: string): string {
  if (revision === '' || revision.startsWith('-'))
    throw new TaskUsageError(`${option} must name a commit`);
  const parsed = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
    { encoding: 'utf8' },
  );
  if (parsed.status !== 0)
    throw new TaskUsageError(
      `${option} ${revision} is not a commit here; fetch it first (a CI checkout needs fetch-depth: 0)`,
    );
  return parsed.stdout.trim();
}
