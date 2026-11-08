import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// The worker sessions that scripts/live-worker.mjs runs against the real
// Codex app-server, recording each transcript, and that
// test/worker/codex-replay.test.ts replays from test/fixtures/codex-app-server.
// Both sides build the same repository and run the same steps, so the frames
// KRN writes during a replay are the recorded ones.

export type Step = {
  readonly command: 'start' | 'send' | 'stop';
  /** The brief of start or the message of send. */
  readonly text?: string;
  readonly flags?: readonly string[];
  readonly exit: number;
  /**
   * Keeps this step running while the next one runs; the next step starts
   * once an inbound frame contains every one of these strings.
   */
  readonly until?: readonly string[];
};

export type Scenario = {
  readonly name: string;
  readonly question: string;
  readonly steps: readonly Step[];
  /** A problem with the run's records, or undefined. */
  readonly check?: (run: string) => string | undefined;
};

export type Outcome = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type Played = {
  readonly outcomes: readonly Outcome[];
  readonly run: string;
  /** Every frame that crossed the pipe, in transcript form. */
  readonly log: string;
};

export const scenarios: readonly Scenario[] = [
  {
    name: 'compact',
    question:
      'Does a forced compaction end with its own item before the next turn starts, and does every turn report its token usage?',
    steps: [
      {
        command: 'start',
        text: 'Read a.txt. Return a complete worker report with its content in summary. Do not change files.',
        exit: 0,
      },
      {
        command: 'send',
        text: 'Without tools, return a complete worker report with the word count of that file in summary.',
        flags: ['--compact', 'always'],
        exit: 0,
      },
      { command: 'stop', exit: 0 },
    ],
    check: (run) => {
      const metrics = join(run, 'rounds/002/metrics.json');
      return existsSync(metrics) &&
        JSON.parse(readFileSync(metrics, 'utf8')).compacted === true
        ? undefined
        : 'round 2 did not compact';
    },
  },
  {
    name: 'failed-turn',
    question: 'How does a turn on a model the receiver does not know end?',
    steps: [
      {
        command: 'start',
        text: 'Return a complete worker report.',
        flags: ['--model', 'krn-replay-unknown-model'],
        exit: 75,
      },
      { command: 'stop', exit: 0 },
    ],
  },
  {
    name: 'interrupt',
    question:
      'What does turn/interrupt answer while a command runs, and how does the interrupted turn complete?',
    steps: [
      {
        command: 'start',
        text: 'Run `sleep 300` in the shell, then return a complete worker report.',
        exit: 75,
        until: ['"method":"item/started"', '"type":"commandExecution"'],
      },
      { command: 'stop', exit: 0 },
    ],
  },
];

const cli = resolve('src/cli/krn.mjs');
const tool = resolve('scripts/codex/app-server-replay.ts');

function launch(args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [cli, 'worker', ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise<Outcome>((done) =>
    child.on('close', (code) => done({ code, stdout, stderr })),
  );
}

/** Resolves once the log holds an inbound frame with every needle, or on abort. */
function inbound(
  log: string,
  needles: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const seen = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .some(
        (line) =>
          line.startsWith('< ') &&
          needles.every((needle) => line.includes(needle)),
      );
  return new Promise((done) => {
    const watcher = watch(log, () => {
      if (seen()) finish();
    });
    function finish() {
      watcher.close();
      signal.removeEventListener('abort', finish);
      done();
    }
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted || seen()) finish();
  });
}

/**
 * Runs a scenario's worker steps in a fresh repository under root, with
 * KRN_CODEX_BIN on the replay tool. env selects its mode: CODEX_KRN_TARGET
 * records the real app-server, CODEX_KRN_REPLAY plays a transcript.
 */
export async function play(
  scenario: Scenario,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Played> {
  const repo = join(root, 'repo');
  const run = join(repo, '.krn', 'worker');
  const log = join(root, `${scenario.name}.rpc`);
  mkdirSync(join(repo, 'spec'), { recursive: true });
  copyFileSync(
    resolve('spec/worker-scope.json'),
    join(repo, 'spec/worker-scope.json'),
  );
  writeFileSync(join(repo, 'a.txt'), 'alpha\n');
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=worker',
      '-c',
      'user.email=worker@example.invalid',
      'commit',
      '-qm',
      'base',
    ],
  ]) {
    const git = spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    if (git.status !== 0)
      throw new Error(`git ${args[0]} exited ${git.status}`);
  }
  writeFileSync(log, '');
  const stepEnv = { ...env, KRN_CODEX_BIN: tool, CODEX_KRN_LOG: log };
  const outcomes: Outcome[] = [];
  let held:
    | { readonly index: number; readonly outcome: Promise<Outcome> }
    | undefined;
  for (const [index, step] of scenario.steps.entries()) {
    const args: string[] = [step.command];
    if (step.text !== undefined) {
      const file = join(root, `step-${index + 1}.md`);
      writeFileSync(file, step.text);
      args.push(
        ...(step.command === 'start'
          ? ['--repo', repo, '--brief', file]
          : ['--message', file]),
      );
    }
    args.push(...(step.flags ?? []), '--run', run);
    const outcome = launch(args, stepEnv);
    if (step.until) {
      const ended = new AbortController();
      void outcome.then(() => ended.abort());
      await inbound(log, step.until, ended.signal);
      held = { index, outcome };
      continue;
    }
    outcomes[index] = await outcome;
    if (held) outcomes[held.index] = await held.outcome;
    held = undefined;
  }
  if (held) outcomes[held.index] = await held.outcome;
  return { outcomes, run, log };
}

/** What differs from the scenario's expected exits and records. */
export function problems(scenario: Scenario, played: Played): string[] {
  const found = scenario.steps.flatMap((step, index) => {
    const outcome = played.outcomes[index];
    return outcome?.code === step.exit
      ? []
      : [
          `${scenario.name} step ${index + 1} (${step.command}) exited ${outcome?.code}, expected ${step.exit}: ${outcome?.stderr.trim()}`,
        ];
  });
  const record = scenario.check?.(played.run);
  return record ? [...found, `${scenario.name}: ${record}`] : found;
}
