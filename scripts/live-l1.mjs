import { spawnSync } from 'node:child_process';
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

const jobId = argument('--job');
const issue = argument('--issue');
const revision = argument('--revision');
const prompt = argument('--prompt');
const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const started = spawnSync(
  process.execPath,
  [cli, 'start', '--job', jobId, '--issue', issue],
  { encoding: 'utf8' },
);
if (started.status !== 0)
  throw new Error(started.stderr || 'job worktree creation failed');
const job = JSON.parse(started.stdout);
const host = new CodexHost();
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
process.stdout.write(`${JSON.stringify({ job, outcome })}\n`);
