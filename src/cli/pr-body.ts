import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isTaskId, type TaskRecord } from '../task/record.ts';
import { loadTaskIndex, repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const prBodyUsage =
  'krn pr body --task ID [--verified TEXT] [--agent TEXT] [--refs] [--base REF] [--worktree PATH] [--out PATH]  print the PR body (Problem/Change/Verification/Task/Agent) from the task record and the commits since the base, both read from the worktree (default: the current one); the author only reviews it';

export interface BodyInput {
  task: TaskRecord;
  commits: string[];
  verified: string;
  agent: string;
  refs: boolean;
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

export function renderPrBody(input: BodyInput): string {
  const { task } = input;
  const problem = bodyField(task, 'Why') ?? task.title;
  const outcome = bodyField(task, 'Outcome') ?? task.title;
  const proof = bodyField(task, 'Proof');
  const change = input.commits.length
    ? input.commits.map((line) => `- ${line}`).join('\n')
    : `- ${outcome}`;
  const verified = input.verified || (proof ? `Planned proof: ${proof}` : '');
  return `## Problem

${problem}

## Change

Outcome: ${outcome}

${change}

## Verification

${verified || 'TODO: commands and verdicts'}

## Task

${input.refs ? 'Refs' : 'Ticket'}: ${task.id}

Agent: ${input.agent}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

function commitsSince(root: string, base: string): string[] {
  const result = spawnSync(
    'git',
    ['-C', root, 'log', '--reverse', '--format=%s', `${base}..HEAD`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new CliUsageError(
      `git log ${base}..HEAD failed: ${result.stderr.trim()}`,
    );
  return result.stdout.split('\n').filter(Boolean);
}

export function prBodyCommand(args: string[]): string {
  let id: string | undefined;
  let verified = '';
  let agent = 'Claude Sonnet 5.5 in Claude Code';
  let refs = false;
  let base = 'origin/main';
  let out: string | undefined;
  let worktree: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? '';
    if (flag === '--refs') {
      refs = true;
      continue;
    }
    if (
      ![
        '--task',
        '--verified',
        '--agent',
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
    else if (flag === '--base') base = value;
    else if (flag === '--worktree') worktree = value;
    else out = value;
  }
  if (id === undefined || !isTaskId(id))
    throw new CliUsageError(`--task needs a task id\n${prBodyUsage}`);
  // The task may exist only in the branch the PR describes, so the record and
  // the commits both come from that worktree, not from the main checkout.
  const root = repositoryRoot(worktree);
  const task = loadTaskIndex(root).get(id);
  if (task === undefined) throw new CliUsageError(`Unknown task ${id}`);
  const text = renderPrBody({
    task,
    commits: commitsSince(root, base),
    verified,
    agent,
    refs,
  });
  if (out === undefined) return text;
  writeFileSync(out, text);
  return `${out}\n`;
}
