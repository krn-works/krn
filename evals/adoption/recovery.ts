// Interrupted-batch recovery eval. Usage: node evals/adoption/recovery.ts [--live] [--window-hours N]
// Offline (default): a scratch outside repository with two tasks, a bare origin and a GitHub stand-in
// at the gh boundary; the real drain, lane run and ship deliver it, killed once at each point, then rerun.
// Oracle: merges per task counted from the stand-in's PR state and the origin's main history.
// --live: two seeded tasks in an authorized outside repository, the real drain cut once at (d); see recovery-live.ts.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a batch is cut: (a) mid worker session, (b) after the task closed in the worktree before the push, (c) after the PR opened before the merge, (d) after the merge before cleanup, claim release and main sync. */
export const killPoints = ['a', 'b', 'c', 'd'] as const;
export type KillPoint = (typeof killPoints)[number];

export const recoveryTasks = ['t-rcvaaa1', 't-rcvbbb2'] as const;

const sessionCapture = fileURLToPath(
  new URL(
    '../../test/fixtures/claude/headless-session-result.json',
    import.meta.url,
  ),
);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The GitHub stand-in: one PR table in a JSON file, squash merges written into the bare origin.
 * It never deduplicates: a second PR or a second merge for a task is recorded, so the oracle can see it.
 */
const fakeGh = String.raw`#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const env = process.env;
const statePath = env.RECOVERY_STATE;
const origin = env.RECOVERY_ORIGIN;
const repo = 'owner/scratch';
const load = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { prs: [] });
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const git = (...args) => {
  const r = spawnSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'github', GIT_AUTHOR_EMAIL: 'github@example.invalid', GIT_COMMITTER_NAME: 'github', GIT_COMMITTER_EMAIL: 'github@example.invalid' } });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  return r.stdout.trim();
};
const tip = (branch) => { const r = spawnSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '-q', 'refs/heads/' + branch], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const kill = (point) => {
  if (env.RECOVERY_KILL !== point || fs.existsSync(env.RECOVERY_KILLED)) return;
  fs.writeFileSync(env.RECOVERY_KILLED, point + '\n');
  process.kill(-Number(env.RECOVERY_PGID), 'SIGKILL');
};
let args = process.argv.slice(2);
let jq;
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--jq')) { jq = flag('--jq'); const i = args.indexOf('--jq'); args = [...args.slice(0, i), ...args.slice(i + 2)]; }
const out = (value) => {
  const text = JSON.stringify(value);
  if (jq === undefined) { process.stdout.write(text + '\n'); return; }
  const r = spawnSync('jq', ['-r', jq], { input: text, encoding: 'utf8' });
  process.stdout.write(r.stdout); process.exit(r.status ?? 1);
};
const fields = (pr, list) => Object.fromEntries((list ?? '').split(',').filter(Boolean).map((f) => [f, f === 'headRefOid' ? (pr.state === 'OPEN' ? tip(pr.head) || pr.headRefOid : pr.headRefOid) : f === 'mergeCommit' ? (pr.mergeCommit ? { oid: pr.mergeCommit } : null) : f === 'statusCheckRollup' ? [{ name: 'Check', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T00:00:00Z' }] : f === 'mergeable' ? 'MERGEABLE' : f === 'autoMergeRequest' ? null : pr[f]]));
const state = load();
const [noun, verb] = args;
const byNumber = (n) => state.prs.find((pr) => pr.number === Number(n));
if (noun === 'repo' && verb === 'view') { process.stdout.write(repo + '\n'); }
else if (noun === 'pr' && verb === 'list') {
  const head = flag('--head'); const base = flag('--base'); const want = (flag('--state') ?? 'open').toUpperCase();
  out(state.prs.filter((pr) => (head === undefined || pr.head === head) && (base === undefined || pr.base === base) && pr.state === want).reverse().map((pr) => fields(pr, flag('--json'))));
} else if (noun === 'pr' && verb === 'create') {
  const head = flag('--head');
  const number = state.prs.length + 1;
  state.prs.push({ number, head, base: flag('--base'), title: flag('--title'), body: fs.readFileSync(flag('--body-file'), 'utf8'), state: 'OPEN', headRefOid: tip(head), mergeCommit: null });
  save(state);
  process.stdout.write('https://github.com/' + repo + '/pull/' + number + '\n');
} else if (noun === 'pr' && verb === 'edit') {
  const pr = byNumber(args[2]); pr.title = flag('--title') ?? pr.title; save(state);
} else if (noun === 'pr' && verb === 'view') {
  out(fields(byNumber(args[2]), flag('--json')));
} else if (noun === 'pr' && verb === 'merge') {
  const pr = byNumber(args[2]);
  kill('c');
  const head = tip(pr.head);
  if (flag('--match-head-commit') !== head) { process.stderr.write('Head branch was modified\n'); process.exit(1); }
  const main = git('rev-parse', 'refs/heads/' + pr.base);
  const commit = git('commit-tree', head + '^{tree}', '-p', main, '-m', pr.title + ' (#' + pr.number + ')');
  git('update-ref', 'refs/heads/' + pr.base, commit, main);
  Object.assign(pr, { state: 'MERGED', headRefOid: head, mergeCommit: commit });
  save(state);
  kill('d');
} else if (noun === 'api' && /check-runs/.test(verb)) {
  out({ check_runs: [{ name: 'Check', app: { id: 15368 }, started_at: '2026-01-01T00:00:00Z', status: 'completed', conclusion: 'success', details_url: 'https://github.com/' + repo + '/actions/runs/1' }] });
} else if (noun === 'run' && verb === 'list') { out([]); }
else { process.stderr.write('gh stand-in: unhandled ' + args.join(' ') + '\n'); process.exit(2); }
`;

/** Kills the drain's process group; node, since the kill builtin of dash (CI's /bin/sh) refuses `--` and negative pids. */
const killGroup = `node -e "process.kill(-Number(process.env.RECOVERY_PGID), 'SIGKILL')"`;

/** A pre-push hook that cuts the batch at (b): the task is closed and committed, the branch not pushed. */
const prePush = `#!/bin/sh
if [ "$RECOVERY_KILL" = b ] && [ ! -e "$RECOVERY_KILLED" ]; then
  echo b > "$RECOVERY_KILLED"
  ${killGroup}
fi
exit 0
`;

/** The worker: writes the task's file, closes the task, commits with its Ticket; at (a) it dies halfway. */
function fakeClaude(): string {
  const close = `node -e "const fs = require('node:fs'); const f = 'tasks/' + process.env.KRN_TASK + '.json'; const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.status = 'closed'; t.resolution = { kind: 'done', ref: null, note: 'written' }; fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\\n');"`;
  return [
    '#!/bin/sh',
    'set -e',
    'mkdir -p notes',
    'printf "half\\n" > "notes/$KRN_TASK.txt"',
    `if [ "$RECOVERY_KILL" = a ] && [ ! -e "$RECOVERY_KILLED" ]; then echo a > "$RECOVERY_KILLED"; ${killGroup}; sleep 5; fi`,
    'printf "done $KRN_TASK\\n" > "notes/$KRN_TASK.txt"',
    close,
    'git add notes tasks',
    'git commit -q -m "feat(notes): note for the task ($KRN_TASK)" -m "Ticket: $KRN_TASK"',
    `cat '${sessionCapture}'`,
    '',
  ].join('\n');
}

export interface Scratch {
  base: string;
  origin: string;
  repo: string;
  bin: string;
  state: string;
  killed: string;
}

/** A scratch outside repository: bare origin, main checkout with a krn contract and two open tasks, the stand-ins. */
export function scratchRepository(parent = tmpdir()): Scratch {
  mkdirSync(parent, { recursive: true });
  const base = realpathSync(mkdtempSync(join(parent, 'krn-recovery-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'recovery eval');
  git(repo, 'config', 'user.email', 'recovery@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  const tasks = Object.fromEntries(
    recoveryTasks.map((id, index) => [
      `tasks/${id}.json`,
      json({
        id,
        status: 'open',
        resolution: null,
        created: '2026-11-18',
        priority: 2,
        title: `Note ${index + 1}`,
        after: [],
        body: [`Outcome: notes/${id}.txt names the task.`],
      }),
    ]),
  );
  write(repo, {
    '.gitignore': '.krn\nnode_modules\n',
    'krn.json': json({ base: 'main', tracker: 'krn', test: 'node --test' }),
    'note.test.mjs':
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('holds', () => assert.ok(true));\n",
    ...tasks,
  });
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  write(bin, { gh: fakeGh, claude: fakeClaude() });
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'claude'), 0o755);
  const hook = join(repo, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, prePush);
  chmodSync(hook, 0o755);
  return {
    base,
    origin,
    repo,
    bin,
    state: join(base, 'github.json'),
    killed: join(base, 'killed'),
  };
}

/** One drain of the batch in its own process group, so a kill point can end every process of it at once. */
export function runDrain(
  scratch: Scratch,
  kill: KillPoint | undefined,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${scratch.bin}:${process.env.PATH ?? ''}`,
    KRN_LANE_CLAUDE: join(scratch.bin, 'claude'),
    RECOVERY_STATE: scratch.state,
    RECOVERY_ORIGIN: scratch.origin,
    RECOVERY_KILLED: scratch.killed,
    RECOVERY_KILL: kill ?? '',
  };
  for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
    delete env[name];
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--drain', '--root', scratch.repo],
      {
        cwd: scratch.repo,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}

/** Merges per task, read from GitHub's PR table and the origin's main history, never from drain output. */
export function mergesPerTask(
  scratch: Scratch,
): Record<string, { prs: number; commits: number }> {
  const prs: { title: string; state: string }[] = existsSync(scratch.state)
    ? JSON.parse(readFileSync(scratch.state, 'utf8')).prs
    : [];
  const subjects = git(scratch.origin, 'log', '--format=%s', 'main').split(
    '\n',
  );
  return Object.fromEntries(
    recoveryTasks.map((id) => [
      id,
      {
        prs: prs.filter(
          (pr) => pr.state === 'MERGED' && pr.title.includes(`(${id})`),
        ).length,
        commits: subjects.filter((subject) => subject.includes(`(${id})`))
          .length,
      },
    ]),
  );
}

export interface ScenarioResult {
  point: KillPoint | 'none';
  pass: boolean;
  detail: string;
}

/** Cut the batch once at `point`, rerun the drain until it reports nothing left, then count merges. */
export async function recoveryScenario(
  point: KillPoint | undefined,
  parent?: string,
): Promise<ScenarioResult> {
  const scratch = scratchRepository(parent);
  const label = point ?? 'none';
  try {
    const runs: string[] = [];
    const first = await runDrain(scratch, point);
    runs.push(first.output);
    if (point !== undefined) {
      const fired = existsSync(scratch.killed);
      if (first.signal !== 'SIGKILL' || !fired)
        return {
          point: label,
          pass: false,
          detail: `the kill at ${point} did not fire (signal ${first.signal}, exit ${first.code}): ${first.output.slice(-600)}`,
        };
      // At (d) the cut must land between the remote merge and the local receipt: merged on the
      // origin while the main checkout still lists the task open.
      const [cut] = recoveryTasks;
      if (
        point === 'd' &&
        (mergesPerTask(scratch)[cut]?.prs !== 1 ||
          !readFileSync(
            join(scratch.repo, 'tasks', `${cut}.json`),
            'utf8',
          ).includes('"open"'))
      )
        return {
          point: label,
          pass: false,
          detail: `the kill at d did not land after the merge of ${cut} and before its receipt`,
        };
    }
    for (let rerun = 0; rerun < 3; rerun += 1) {
      const counts = mergesPerTask(scratch);
      if (Object.values(counts).every((count) => count.prs >= 1)) break;
      const next = await runDrain(scratch, undefined);
      runs.push(next.output);
    }
    const counts = mergesPerTask(scratch);
    const pass = Object.values(counts).every(
      (count) => count.prs === 1 && count.commits === 1,
    );
    const tally = Object.entries(counts)
      .map(([id, count]) => `${id} prs=${count.prs} commits=${count.commits}`)
      .join(', ');
    return {
      point: label,
      pass,
      detail: pass ? tally : `${tally}\n${runs.join('\n---\n').slice(-3000)}`,
    };
  } finally {
    rmSync(scratch.base, { recursive: true, force: true });
  }
}

/** The child: the real drain over the real lane run and ship, with only the App mint and ship's poll pause replaced. */
async function drainChild(root: string): Promise<number> {
  process.env.RECOVERY_PGID = String(process.pid);
  for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
    delete process.env[name];
  const { drainReady, defaultDrainSeams } = await import(
    '../../src/cli/lane-run/drain.ts'
  );
  const { laneRunCommand } = await import('../../src/cli/lane-run.ts');
  const { startLane } = await import('../../src/cli/lane.ts');
  const { shipCommand } = await import('../../src/ci/ship.ts');
  const { cliShipRuntime } = await import('../../src/cli/pr.ts');
  const result = await drainReady(
    { max: recoveryTasks.length, passthrough: ['--root', root], root },
    {
      ...defaultDrainSeams,
      runTask: (id, args) =>
        laneRunCommand(['--task', id, ...args], {
          start: startLane,
          mint: async () => undefined,
          ship: (shipArgs) =>
            shipCommand(shipArgs, {
              ...cliShipRuntime,
              sleep: async () => undefined,
            }),
        }),
    },
    (line) => process.stdout.write(`${line}\n`),
  );
  return result.exitCode;
}

/** The live gate: the batch doctor of the target repository; a refusal is the blocker, never a PASS. */
export function liveGate(doctor: () => { text: string; exitCode: number }): {
  exitCode: number;
  line: string;
} {
  const report = doctor();
  return report.exitCode === 0
    ? { exitCode: 0, line: 'live: doctor --unattended PASS' }
    : {
        exitCode: report.exitCode,
        line: `BLOCKED live: doctor --unattended exit ${report.exitCode}: ${report.text.trim()}`,
      };
}

/** The pilot clone the operator authorized for PRs (never a push to its default branch). */
export const pilotRoot = '/mnt/storage/tmp/krn/pilot/lead';

/** The GitHub repository of the pilot clone; its App token and PR list are scoped to it. */
export const pilotRepository = 'krn-works/seo-audit-harness';

async function main(argv: string[]): Promise<number> {
  const at = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes('--drain'))
    return drainChild(at('--root') ?? process.cwd());
  if (argv.includes('--live-drain')) {
    const { liveDrainChild } = await import('./recovery-live.ts');
    return liveDrainChild(
      at('--root') ?? pilotRoot,
      at('--window-hours') ?? '2',
      (at('--tasks') ?? '').split(',').filter(Boolean),
    );
  }
  if (argv.includes('--live')) {
    const { unattendedReport } = await import(
      '../../src/cli/doctor-unattended.ts'
    );
    const root = at('--root') ?? pilotRoot;
    const windowHours = at('--window-hours') ?? '2';
    const gate = liveGate(() =>
      unattendedReport([
        '--unattended',
        '--window-hours',
        windowHours,
        '--root',
        root,
      ]),
    );
    process.stdout.write(`${gate.line}\n`);
    if (gate.exitCode !== 0) return gate.exitCode;
    const { liveRecovery, livePaths } = await import('./recovery-live.ts');
    return liveRecovery(
      livePaths(root, at('--repo') ?? pilotRepository),
      windowHours,
      (line) => process.stdout.write(`${line}\n`),
    );
  }
  let failed = 0;
  for (const point of [undefined, ...killPoints]) {
    const result = await recoveryScenario(point);
    process.stdout.write(
      `${result.pass ? 'PASS' : 'FAIL'} kill=${result.point}: ${result.detail}\n`,
    );
    if (!result.pass) failed += 1;
  }
  process.stdout.write(
    failed === 0
      ? `PASS offline recovery: one merge per task at every kill point\n`
      : `FAIL offline recovery: ${failed} scenario(s)\n`,
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exit(70);
    },
  );
