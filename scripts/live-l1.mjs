import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/foreman/run.ts';
import { CodexHost } from '../src/hosts/codex.ts';
import { createLedger } from '../src/ledger/index.ts';
import {
  loadLiveContract,
  withLiveSubmissionGate,
} from '../src/ledger/live.ts';
import { createPaperclipCliTransport } from '../src/ledger/paperclip-cli.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';

let cancelPaperclip = async () => {};
let host;
const abortController = new AbortController();
let stopSignal;
let stopPromise;
const stop = async (signal = 'SIGTERM', code = 130) => {
  if (stopPromise) return stopPromise;
  stopSignal = signal;
  abortController.abort(signal);
  stopPromise = (async () => {
    const pending = [cancelPaperclip()];
    if (host) pending.push(host.cancelAll());
    await Promise.allSettled(pending);
    process.exitCode = code;
  })();
  return stopPromise;
};
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
  const handler = () => void stop(signal, 130);
  process.once(signal, handler);
  return { signal, handler };
});

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

function optionalArgument(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = process.argv[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const abort = () => child.kill('SIGTERM');
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (status) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({ status, stdout, stderr });
    });
  });
}

async function git(root, args) {
  const result = await command('git', ['-C', root, ...args], {
    signal: abortController.signal,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function hasWorktree(root, path) {
  return (await git(root, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => resolve(line.slice('worktree '.length)) === path);
}

const jobId = argument('--job');
const issue = argument('--issue');
const revision = optionalArgument('--revision');
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
const existingJobWorktree = resolve(repo, '.krn', 'worktrees', jobId);
const worktree =
  requestedWorktree ??
  ((await hasWorktree(repo, existingJobWorktree))
    ? existingJobWorktree
    : undefined);
if ((await git(repo, ['rev-parse', '--show-toplevel'])) !== repo)
  throw new Error('--repo must be the repository root');
const origin = await git(repo, ['remote', 'get-url', 'origin']);
const session = process.env.KRN_SESSION ?? '';
const useHttp = process.argv.includes('--http');
let paperclipTransport;
const paperclip = useHttp
  ? createLedger({
      apiUrl: process.env.KRN_PAPERCLIP_API_URL ?? '',
      token: process.env.KRN_PAPERCLIP_TOKEN ?? '',
      session: session ?? '',
    })
  : (() => {
      paperclipTransport = createPaperclipCliTransport();
      cancelPaperclip = () => paperclipTransport.cancelAll();
      return createLedger({
        session: session ?? '',
        transport: paperclipTransport,
      });
    })();
let contract;
let board;
try {
  ({ contract, board } = await loadLiveContract(paperclip, issue, {
    origin,
    ...(revision === undefined ? {} : { revision }),
  }));
} catch (error) {
  if (abortController.signal.aborted) {
    await stopPromise;
    process.exit(stopSignal === 'wall-timeout' ? 124 : 130);
  }
  throw error;
}
const liveLedger = withLiveSubmissionGate(
  { ...paperclip, readContract: async () => contract },
  process.argv.includes('--submit'),
);
const ignoredTrace = (root) =>
  command(
    'git',
    [
      '-C',
      root,
      'check-ignore',
      '-q',
      `.krn/runs/foreman/${jobId}/trace.jsonl`,
    ],
    { signal: abortController.signal },
  );
if ((await ignoredTrace(repo)).status !== 0)
  throw new Error(
    `job repository must ignore .krn/runs/foreman/${jobId}/trace.jsonl`,
  );
let job;
if (worktree) {
  if ((await git(worktree, ['rev-parse', '--show-toplevel'])) !== worktree)
    throw new Error('--worktree must be the job repository root');
  if (!(await hasWorktree(repo, worktree)))
    throw new Error('--worktree does not belong to --repo');
  job = { id: jobId, issue, worktree, repoRoot: repo };
} else {
  const started = await command(
    process.execPath,
    [cli, 'start', '--job', jobId, '--issue', issue],
    { cwd: repo, signal: abortController.signal },
  );
  if (started.status !== 0)
    throw new Error(started.stderr || 'job worktree creation failed');
  job = JSON.parse(started.stdout);
}
const ignored = await ignoredTrace(job.worktree);
if (ignored.status !== 0)
  throw new Error(
    `job repository must ignore .krn/runs/foreman/${jobId}/trace.jsonl`,
  );

host = new CodexHost(
  process.env.KRN_CODEX_BIN ? { executable: process.env.KRN_CODEX_BIN } : {},
);
const wallTimeMs = Number(process.env.KRN_LIVE_WALL_TIME_MS ?? 20 * 60 * 1000);
if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs <= 0)
  throw new Error('invalid live wall-time limit');
const wallTimer = setTimeout(() => void stop('wall-timeout', 124), wallTimeMs);
const outcome = await runJob(job, {
  budget: {
    maxResets: 3,
    maxRepairs: 2,
    session: { timeoutMs: 15 * 60 * 1000 },
  },
  ledger: liveLedger,
  signal: abortController.signal,
  relay: {
    ...relay,
    project: (capsule, facts, taskContract) =>
      relay.project(capsule, facts, taskContract),
  },
  trace,
  hosts: {
    codex: host,
    cancelTree: (sessionId) => host.cancelTree(sessionId),
    sessionScopeActive: (jobId, sessionId, registration) =>
      host.sessionScopeActive(jobId, sessionId, registration),
  },
  stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
});
clearTimeout(wallTimer);
for (const { signal, handler } of signals)
  process.removeListener(signal, handler);
const teardownFailure =
  outcome.kind === 'stop' &&
  outcome.reasons.some((reason) => reason.startsWith('teardown_unconfirmed:'));
if (teardownFailure) {
  await trace.teardownUnconfirmed(
    job,
    outcome.kind === 'stop'
      ? outcome.reasons.join('; ')
      : 'teardown unconfirmed',
  );
  process.exitCode = 1;
} else if (abortController.signal.aborted) {
  await trace.stopped(job, stopSignal ?? 'aborted');
  process.exitCode = stopSignal === 'wall-timeout' ? 124 : 130;
}
process.stdout.write(`${JSON.stringify({ job, board, outcome })}\n`);
