import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ADVISOR_ARM_PREFIX } from '../outcome/lane-advisor.ts';
import { EFFORT_PREFIX } from '../outcome/lane-effort.ts';
import { LANE_MARKER } from '../outcome/lane-marker.ts';
import { titleTaskId } from '../outcome/task-id.ts';
import { contractBase, contractTracker } from '../repo/contract.ts';
import { taskLookupRoot } from '../task/claims.ts';
import { isTaskId, type TaskRecord } from '../task/record.ts';
import { loadTaskIndex, repositoryRoot } from '../task/store.ts';

export const prBodyUsage =
  'krn pr body [--task ID] [--why TEXT] [--verified TEXT] [--agent TEXT] [--lane] [--assumptions TEXT] [--refs] [--base REF (default origin/<contract base>)] [--worktree PATH] [--out PATH]  print the PR body (Why/What changed/Verified/Task/Agent) from the task record and the commits since the base, both read from the worktree (default: the current one); in a repository without a task tracker --task may be omitted: Why comes from --why and the body has no Task section; the author only reviews it';

export { LANE_MARKER };

export interface BodyInput {
  /** The task the PR delivers; absent in a repository without a task tracker. */
  task?: TaskRecord;
  /** Why the change is needed, when no task record says it. */
  why?: string;
  commits: string[];
  verified: string;
  /** The model that ran the work; empty when unknown, and the body then has no Agent line. */
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
// A Proof often quotes a git command as an input to refuse (t-zvgxegd: `git commit -m "Update stuff"`); only read-only git runs.
const readOnlyGit =
  /^git (?:log|diff|show|status|grep|ls-files|ls-tree|rev-parse|rev-list|cat-file|merge-base|check-ignore|blame)\b/u;
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
      (command) =>
        runnableProof.test(command) &&
        !placeholder.test(command) &&
        (!command.startsWith('git ') || readOnlyGit.test(command)),
    )
    .map(proofShell);
}

/** The Proof commands of the task a PR title names (`... (t-id)`), read from the worktree; none when the title or record is absent. */
export function proofOfTitle(cwd: string, title: string): string[] {
  const id = titleTaskId(title);
  if (id === undefined || !isTaskId(id)) return [];
  const root = repositoryRoot(cwd);
  const task = loadTaskIndex(taskLookupRoot(root, id)).get(id);
  return task === undefined || !delivers(task) ? [] : proofCommands(task);
}

/**
 * False for a task the PR closes without delivering it (duplicate, dropped, superseded): its
 * Proof and its defect regression test belong to the task that did the work, so a closing PR
 * that carries only the record must not have to run or add them.
 */
function delivers(task: TaskRecord): boolean {
  return (
    task.status !== 'closed' ||
    task.resolution === null ||
    task.resolution.kind === 'done'
  );
}

/** The kind of the task a PR title names (`... (t-id)`), read from the worktree; none when the title, record or kind is absent. */
export function kindOfTitle(cwd: string, title: string): string | undefined {
  const id = titleTaskId(title);
  if (id === undefined || !isTaskId(id)) return undefined;
  const root = repositoryRoot(cwd);
  const task = loadTaskIndex(taskLookupRoot(root, id)).get(id);
  return task === undefined || !delivers(task) ? undefined : task.kind;
}

export function renderPrBody(input: BodyInput): string {
  const { task } = input;
  const problem =
    input.why?.trim() ||
    (task && (bodyField(task, 'Why') ?? task.title)) ||
    'TODO: why this change is needed';
  const outcome = task && (bodyField(task, 'Outcome') ?? task.title);
  const proof = task && bodyField(task, 'Proof');
  const change = input.commits.length
    ? input.commits.map((line) => `- ${line}`).join('\n')
    : `- ${outcome ?? 'TODO: what changed'}`;
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
  const tracked = task
    ? `## Task

${input.refs ? 'Refs' : 'Ticket'}: ${task.id}

`
    : '';
  return `## Why

${problem}

## What changed

${outcome === undefined ? '' : `Outcome: ${outcome}\n\n`}${change}

## Verified

${verified || 'TODO: command: verdict'}

${assumed}${tracked}${input.agent === '' ? '' : `Agent: ${input.agent}\n`}${input.lane ? `\n${LANE_MARKER}\n${ADVISOR_ARM_PREFIX}${input.advisor ?? 'none'}\n${input.effort === undefined ? '' : `${EFFORT_PREFIX}${input.effort}\n`}` : ''}
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

/**
 * Prints the body, or writes it to --out. A call that fails (a wrong flag, a stray argument such
 * as the id after the boolean `--refs`) writes nothing and removes the file --out names, so a
 * caller that ships the file afterwards cannot publish a stale or empty body.
 */
export function prBodyCommand(args: string[]): string {
  try {
    return composePrBody(args);
  } catch (error) {
    const named = args.lastIndexOf('--out');
    const stale = named >= 0 ? args[named + 1] : undefined;
    if (stale !== undefined) rmSync(stale, { force: true });
    throw error;
  }
}

function composePrBody(args: string[]): string {
  let id: string | undefined;
  let why = '';
  const verifiedValues: string[] = [];
  // The running model is never guessed: --agent, else the session's own declaration, else no Agent line.
  let agent = process.env.KRN_AGENT_MODEL ?? process.env.ANTHROPIC_MODEL ?? '';
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
        '--why',
        '--verified',
        '--agent',
        '--assumptions',
        '--base',
        '--worktree',
        '--out',
      ].includes(flag)
    )
      throw new CliUsageError(
        `Unknown pr body flag: ${flag}${args[i - 1] === '--refs' ? ' (--refs takes no value; name the task with --task)' : ''}\n${prBodyUsage}`,
      );
    const value = flagValue(
      args,
      i++,
      () => new CliUsageError(`Missing value for ${flag}`),
    );
    if (flag === '--task') id = value;
    else if (flag === '--why') why = value;
    else if (flag === '--verified') verifiedValues.push(value);
    else if (flag === '--agent') agent = value;
    else if (flag === '--assumptions') assumptions = value;
    else if (flag === '--base') base = value;
    else if (flag === '--worktree') worktree = value;
    else out = value;
  }
  // The task may exist only in the branch the PR describes, so the record and
  // the commits both come from that worktree, not from the main checkout.
  const root = repositoryRoot(worktree);
  if (id === undefined && contractTracker(root) === 'krn')
    throw new CliUsageError(`--task needs a task id\n${prBodyUsage}`);
  if (id !== undefined && !isTaskId(id))
    throw new CliUsageError(`--task needs a task id\n${prBodyUsage}`);
  const task =
    id === undefined
      ? undefined
      : loadTaskIndex(taskLookupRoot(root, id)).get(id);
  if (id !== undefined && task === undefined)
    throw new CliUsageError(
      `Unknown task ${id} in ${root}; a task created in a slice worktree needs --worktree <path>`,
    );
  const range = base ?? `origin/${contractBase(root)}`;
  const text = renderPrBody({
    ...(task === undefined ? {} : { task }),
    why,
    commits: commitsSince(root, range),
    verified:
      verifiedValues.length > 1
        ? verifiedValues.map((line) => `- ${line}`).join('\n')
        : (verifiedValues[0] ?? ''),
    agent,
    refs: refs || (id !== undefined && commitsLeaveTaskOpen(root, range, id)),
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
