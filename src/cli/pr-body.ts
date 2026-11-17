import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ADVISOR_ARM_PREFIX } from '../outcome/lane-advisor.ts';
import { EFFORT_PREFIX } from '../outcome/lane-effort.ts';
import { LANE_MARKER } from '../outcome/lane-marker.ts';
import { titleTaskId } from '../outcome/task-id.ts';
import { contractBase } from '../repo/contract.ts';
import { taskLookupRoot } from '../task/claims.ts';
import { isTaskId, type TaskRecord } from '../task/record.ts';
import { loadTaskIndex, repositoryRoot } from '../task/store.ts';

export const prBodyUsage =
  'krn pr body --task ID [--verified TEXT] [--agent TEXT] [--lane] [--assumptions TEXT] [--refs] [--base REF (default origin/<contract base>)] [--worktree PATH] [--out PATH]  print the PR body (Problem/Change/Verification/Task/Agent) from the task record and the commits since the base, both read from the worktree (default: the current one); the author only reviews it';

export { LANE_MARKER };

export interface BodyInput {
  task: TaskRecord;
  commits: string[];
  verified: string;
  agent: string;
  refs: boolean;
  lane?: boolean;
  /** The advisor arm of the lane (`fable` or `none`), written as a line next to the lane marker. */
  advisor?: string;
  /** The effort of each lane turn, comma separated, written as a line next to the lane marker. */
  effort?: string;
  /** Names and behaviours the task body left unstated, one per line; rendered as its own section when present. */
  assumptions?: string;
}

function bodyField(task: TaskRecord, name: string): string | undefined {
  for (const text of task.body) {
    const match = new RegExp(
      `^${name}:\\s*([^\\n]*(?:\\n(?![A-Z][a-z]+:)[^\\n]*)*)`,
      'mu',
    ).exec(text);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

const runnableProof = /^(?:node|npm|npx|krn|bin\/krn|git|\.\/\S+) /u;
const quotes = (text: string, mark: string) => text.split(mark).length - 1;

/**
 * A plan Proof span reads `command: verdict` (docs/program/plan.md). The verdict is split off at
 * the last `: ` outside quotes; a numeric verdict becomes a stdout comparison, any other verdict
 * (`pass`, prose) leaves the exit code as the check.
 */
export function proofShell(span: string): string {
  const cut = span.lastIndexOf(': ');
  if (cut < 0) return span;
  const command = span.slice(0, cut).trim();
  const verdict = span.slice(cut + 2).trim();
  if (
    command === '' ||
    quotes(command, "'") % 2 !== 0 ||
    quotes(command, '"') % 2 !== 0 ||
    /['"`$|;&]/u.test(verdict)
  )
    return span;
  return /^-?\d+(?:\.\d+)?$/u.test(verdict)
    ? `[ "$(${command})" = "${verdict}" ]`
    : command;
}
// `krn adopt <clone of x>` names a value the reader supplies; sh would fail on it (t-et62hcd); a bare `...` stands for arguments the same way.
const placeholder = /<[A-Za-z][^<>]*>|(?:^|\s)\.\.\.(?:\s|$)/u;

/** The runnable commands of a task's `Proof:` field: backtick spans that start with a known runner and name no `<placeholder>`. */
export function proofCommands(task: TaskRecord): string[] {
  const proof = bodyField(task, 'Proof') ?? '';
  return [...proof.matchAll(/`([^`\n]+)`/gu)]
    .map((match) => (match[1] ?? '').trim())
    .filter(
      (command) => runnableProof.test(command) && !placeholder.test(command),
    )
    .map(proofShell);
}

/** The Proof commands of the task a PR title names (`... (t-id)`), read from the worktree; none when the title or record is absent. */
export function proofOfTitle(cwd: string, title: string): string[] {
  const id = titleTaskId(title);
  if (id === undefined || !isTaskId(id)) return [];
  const root = repositoryRoot(cwd);
  const task = loadTaskIndex(taskLookupRoot(root, id)).get(id);
  return task === undefined ? [] : proofCommands(task);
}

/** The kind of the task a PR title names (`... (t-id)`), read from the worktree; none when the title, record or kind is absent. */
export function kindOfTitle(cwd: string, title: string): string | undefined {
  const id = titleTaskId(title);
  if (id === undefined || !isTaskId(id)) return undefined;
  const root = repositoryRoot(cwd);
  return loadTaskIndex(taskLookupRoot(root, id)).get(id)?.kind;
}

export function renderPrBody(input: BodyInput): string {
  const { task } = input;
  const problem = bodyField(task, 'Why') ?? task.title;
  const outcome = bodyField(task, 'Outcome') ?? task.title;
  const proof = bodyField(task, 'Proof');
  const change = input.commits.length
    ? input.commits.map((line) => `- ${line}`).join('\n')
    : `- ${outcome}`;
  const verified = input.verified || (proof ? `Planned proof: ${proof}` : '');
  const assumptions = (input.assumptions ?? '').trim();
  const assumed = assumptions
    ? `## Assumptions

${assumptions
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
  .join('\n')}

`
    : '';
  return `## Problem

${problem}

## Change

Outcome: ${outcome}

${change}

## Verification

${verified || 'TODO: commands and verdicts'}

${assumed}## Task

${input.refs ? 'Refs' : 'Ticket'}: ${task.id}

Agent: ${input.agent}
${input.lane ? `\n${LANE_MARKER}\n${ADVISOR_ARM_PREFIX}${input.advisor ?? 'none'}\n${input.effort === undefined ? '' : `${EFFORT_PREFIX}${input.effort}\n`}` : ''}
🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

function commitsSince(root: string, base: string): string[] {
  const result = spawnSync(
    'git',
    ['-C', root, 'log', '--reverse', '--format=%s', `${base}..HEAD`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const remote = spawnSync(
      'git',
      ['-C', root, 'remote', 'get-url', 'origin'],
      {
        encoding: 'utf8',
      },
    );
    throw new CliUsageError(
      remote.status !== 0 && base.startsWith('origin/')
        ? `${root} has no git remote origin, so ${base} does not exist: add one (git remote add origin <url>) or pass --base <ref>`
        : `git log ${base}..HEAD failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split('\n').filter(Boolean);
}

// A branch whose commits carry `Refs: <id>` and none `Ticket: <id>` leaves the
// task open, so the body must not claim the ticket.
function commitsLeaveTaskOpen(root: string, base: string, id: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', root, 'log', '--format=%B%x00', `${base}..HEAD`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return false;
  const bodies = result.stdout.split('\0');
  const has = (key: string) =>
    new RegExp(`^${key}:\\s*${id}\\s*$`, 'm').test(bodies.join('\n'));
  return has('Refs') && !has('Ticket');
}

export function prBodyCommand(args: string[]): string {
  let id: string | undefined;
  let verified = '';
  let agent = 'Claude Sonnet 5.5 in Claude Code';
  let refs = false;
  let lane = false;
  let assumptions = '';
  let base: string | undefined;
  let out: string | undefined;
  let worktree: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? '';
    if (flag === '--lane') {
      lane = true;
      continue;
    }
    if (flag === '--refs') {
      refs = true;
      continue;
    }
    if (
      ![
        '--task',
        '--verified',
        '--agent',
        '--assumptions',
        '--base',
        '--worktree',
        '--out',
      ].includes(flag)
    )
      throw new CliUsageError(`Unknown pr body flag: ${flag}\n${prBodyUsage}`);
    const value = flagValue(
      args,
      i++,
      () => new CliUsageError(`Missing value for ${flag}`),
    );
    if (flag === '--task') id = value;
    else if (flag === '--verified') verified = value;
    else if (flag === '--agent') agent = value;
    else if (flag === '--assumptions') assumptions = value;
    else if (flag === '--base') base = value;
    else if (flag === '--worktree') worktree = value;
    else out = value;
  }
  if (id === undefined || !isTaskId(id))
    throw new CliUsageError(`--task needs a task id\n${prBodyUsage}`);
  // The task may exist only in the branch the PR describes, so the record and
  // the commits both come from that worktree, not from the main checkout.
  const root = repositoryRoot(worktree);
  const task = loadTaskIndex(taskLookupRoot(root, id)).get(id);
  if (task === undefined)
    throw new CliUsageError(
      `Unknown task ${id} in ${root}; a task created in a slice worktree needs --worktree <path>`,
    );
  const range = base ?? `origin/${contractBase(root)}`;
  const text = renderPrBody({
    task,
    commits: commitsSince(root, range),
    verified,
    agent,
    refs: refs || commitsLeaveTaskOpen(root, range, id),
    lane,
    ...(process.env.KRN_LANE_ADVISOR === undefined
      ? {}
      : { advisor: process.env.KRN_LANE_ADVISOR }),
    ...(process.env.KRN_LANE_EFFORT === undefined
      ? {}
      : { effort: process.env.KRN_LANE_EFFORT }),
    assumptions,
  });
  if (out === undefined) return text;
  writeFileSync(out, text);
  return `${out}\n`;
}
