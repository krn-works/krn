import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/foreman/run.ts';
import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';

if (process.env.KRN_LIVE !== '1') {
  process.stderr.write('Set KRN_LIVE=1 to start the L1 live foreman run.\n');
  process.exit(2);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  const result = index < 0 ? undefined : process.argv[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

const jobId = argument('--job');
const issue = argument('--issue');
const revision = argument('--revision');
const prompt = argument('--prompt');
if (!isAbsolute(argument('--repo'))) throw new Error('--repo must be absolute');
const repo = realpathSync(resolve(argument('--repo')));
if (process.argv.includes('--worktree') && !isAbsolute(argument('--worktree')))
  throw new Error('--worktree must be absolute');
const requestedWorktree = process.argv.includes('--worktree')
  ? realpathSync(resolve(argument('--worktree')))
  : undefined;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId === '..')
  throw new Error('invalid job id');
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const worktree = requestedWorktree ?? undefined;
if (git(repo, ['rev-parse', '--show-toplevel']) !== repo)
  throw new Error('--repo must be the repository root');
const ignoredRuns = (root) =>
  spawnSync('git', [
    '-C',
    root,
    'check-ignore',
    '-q',
    '.krn/runs/foreman/probe.jsonl',
  ]);
if (ignoredRuns(repo).status !== 0)
  throw new Error('job repository must ignore .krn/runs');
let job;
if (worktree) {
  if (git(worktree, ['rev-parse', '--show-toplevel']) !== worktree)
    throw new Error('--worktree must be the job repository root');
  const registered = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => resolve(line.slice('worktree '.length)) === worktree);
  if (!registered) throw new Error('--worktree does not belong to --repo');
  job = { id: jobId, issue, worktree };
} else {
  const started = spawnSync(
    process.execPath,
    [cli, 'start', '--job', jobId, '--issue', issue],
    { cwd: repo, encoding: 'utf8' },
  );
  if (started.status !== 0)
    throw new Error(started.stderr || 'job worktree creation failed');
  job = JSON.parse(started.stdout);
}
const ignored = ignoredRuns(job.worktree);
if (ignored.status !== 0)
  throw new Error('job repository must ignore .krn/runs');

const host = new CodexHost(
  process.env.KRN_CODEX_BIN ? { executable: process.env.KRN_CODEX_BIN } : {},
);
let stopping = false;
const stop = async (code = 130) => {
  if (stopping) return;
  stopping = true;
  try {
    await host.cancelAll();
  } finally {
    process.exit(code);
  }
};
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
  const handler = () => void stop(130);
  process.once(signal, handler);
  return { signal, handler };
});
const wallTimeMs = Number(process.env.KRN_LIVE_WALL_TIME_MS ?? 20 * 60 * 1000);
if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs <= 0)
  throw new Error('invalid live wall-time limit');
const wallTimer = setTimeout(() => void stop(124), wallTimeMs);
const outcome = await runJob(job, {
  budget: {
    maxResets: 3,
    maxRepairs: 2,
    session: { timeoutMs: 15 * 60 * 1000 },
  },
  ledger: { readContract: async () => ({ revision }) },
  relay: {
    ...relay,
    project: (capsule, facts) =>
      `${relay.project(capsule, facts)}\nL1 task: ${prompt}`,
  },
  trace,
  hosts: { codex: host, cancelTree: (sessionId) => host.cancelTree(sessionId) },
  stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
});
clearTimeout(wallTimer);
for (const { signal, handler } of signals)
  process.removeListener(signal, handler);
process.stdout.write(`${JSON.stringify({ job, outcome })}\n`);
