// The live half of the interrupted-batch recovery eval: two trivial tasks seeded in an authorized
// outside repository, the real drain (real App mint, real worker sessions, real ship and GitHub),
// cut once at (d), after the merge and before cleanup, claim release and main sync, then rerun.
// Oracle: merged PRs per task read from GitHub, never from drain output; acceptance: the
// repository's own CI conclusion on each merge commit.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  defaultDoctor,
  defaultDrainSeams,
  drainReady,
} from '../../src/cli/lane-run/drain.ts';
import { loadTaskIndex } from '../../src/task/store.ts';

const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));

/** One merged PR as `gh pr list --json number,title,headRefName,mergeCommit` prints it. */
export const mergedPull = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});
export type MergedPull = z.infer<typeof mergedPull>;

/**
 * The merged PRs that delivered a task: titled `... (<id>)`, minus the PR that only shipped the
 * task record (`krn task publish` pushes a `task-records-*` branch whose title names the id too).
 */
export function deliveries(
  pulls: readonly MergedPull[],
  id: string,
): MergedPull[] {
  return pulls.filter(
    (pull) =>
      pull.title.includes(`(${id})`) &&
      !pull.headRefName.startsWith('task-records-'),
  );
}

/** The latest `ci / Check` run of a commit, as the check-runs API lists it; undefined while none exists. */
export function checkConclusion(
  runs: readonly { name: string; status: string; conclusion: string | null }[],
): string | undefined {
  const check = runs.find((run) => run.name === 'ci / Check');
  if (check === undefined || check.status !== 'completed') return undefined;
  return check.conclusion ?? 'none';
}

/**
 * A pass-through `gh` placed first on the drain's PATH: it runs the next `gh` on PATH and, armed with
 * RECOVERY_KILL=d, after the first `gh pr merge` that exits 0 and whose PR then reads MERGED, it
 * marks the cut and kills the drain's process group, before ship records the merge.
 */
export const killShim = String.raw`#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const env = process.env;
const self = path.dirname(fs.realpathSync(process.argv[1]));
const PATH = (env.PATH ?? '').split(':').filter((dir) => dir !== '' && fs.existsSync(dir) && fs.realpathSync(dir) !== self).join(':');
const real = { ...env, PATH };
const args = process.argv.slice(2);
const result = spawnSync('gh', args, { stdio: 'inherit', env: real });
const code = result.status ?? 1;
const armed = env.RECOVERY_KILL === 'd' && env.RECOVERY_KILLED && !fs.existsSync(env.RECOVERY_KILLED);
if (code === 0 && armed && args[0] === 'pr' && args[1] === 'merge') {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = spawnSync('gh', ['pr', 'view', args[2], '--json', 'state', '--jq', '.state'], { encoding: 'utf8', env: real });
    if (view.stdout.trim() === 'MERGED') break;
    spawnSync('sleep', ['2']);
  }
  fs.writeFileSync(env.RECOVERY_KILLED, 'd ' + args[2] + '\n');
  process.kill(-Number(env.RECOVERY_PGID), 'SIGKILL');
}
process.exit(code);
`;

export interface LiveState {
  /** The seeded task ids, kept so a second `--live` reuses them instead of seeding (and spending) again. */
  tasks: string[];
}

export interface LivePaths {
  root: string;
  repository: string;
  dir: string;
  state: string;
  killed: string;
  bin: string;
}

export function livePaths(root: string, repository: string): LivePaths {
  const dir = join(root, '.krn', 'runs', 'recovery-live');
  return {
    root,
    repository,
    dir,
    state: join(dir, 'state.json'),
    killed: join(dir, 'killed'),
    bin: join(dir, 'bin'),
  };
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const seedBody = (index: number) =>
  [
    `Outcome: docs/notes/ holds one new Markdown file named after this task id (for example docs/notes/t-abc1234.md) whose single line reads "Recovery note ${index}: <task id>".`,
    'Why: a trivial delivery the KRN interrupted-batch recovery check drives through the real drain; change nothing else.',
    '',
  ].join('\n');

/** Seed two trivial task records in the outside repository and ship them through one PR (`krn task publish`). */
export function seedTasks(
  paths: LivePaths,
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): string[] {
  const ids: string[] = [];
  for (const index of [1, 2]) {
    const created = run(
      krn,
      [
        'task',
        'create',
        '--title',
        `Add recovery note ${index}`,
        '--kind',
        'chore',
        '--area',
        'docs',
        '--priority',
        '0',
        '--body-file',
        '-',
        '--json',
      ],
      paths.root,
      env,
      seedBody(index),
    );
    if (created.code !== 0)
      throw new Error(
        `krn task create exit ${created.code}: ${created.stderr}`,
      );
    const id = z
      .object({ id: z.string() })
      .parse(JSON.parse(created.stdout)).id;
    ids.push(id);
    say(`live: seeded ${id}`);
  }
  const published = run(krn, ['task', 'publish'], paths.root, env);
  say(
    `live: krn task publish exit ${published.code}: ${published.stdout.trim().split('\n').at(-1) ?? ''}`,
  );
  if (published.code !== 0)
    throw new Error(
      `krn task publish exit ${published.code}: ${published.stdout}${published.stderr}`,
    );
  return ids;
}

/** One drain of the seeded tasks in its own process group, logged to `<dir>/drain-<n>.log`. */
export function liveDrain(
  paths: LivePaths,
  env: NodeJS.ProcessEnv,
  tasks: readonly string[],
  windowHours: string,
  kill: boolean,
  log: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${paths.bin}:${env.PATH ?? ''}`,
    RECOVERY_KILLED: paths.killed,
    RECOVERY_KILL: kill ? 'd' : '',
  };
  for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
    delete childEnv[name];
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./recovery.ts', import.meta.url)),
        '--live-drain',
        '--root',
        paths.root,
        '--window-hours',
        windowHours,
        '--tasks',
        tasks.join(','),
      ],
      {
        cwd: paths.root,
        env: childEnv,
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
    child.on('close', (code, signal) => {
      writeFileSync(log, output);
      resolve({ code, signal });
    });
  });
}

/** The live drain child: the real drain, lane run and ship; only the queue is narrowed to the seeded tasks. */
export async function liveDrainChild(
  root: string,
  windowHours: string,
  tasks: readonly string[],
): Promise<number> {
  process.env.RECOVERY_PGID = String(process.pid);
  const result = await drainReady(
    { max: tasks.length, passthrough: ['--root', root], root, windowHours },
    {
      ...defaultDrainSeams,
      doctor: await defaultDoctor(windowHours, root),
      // The outside repository has other ready tasks; the batch is the seeded pair only.
      nextReady: async (at, skip, actor) => {
        const others = [...loadTaskIndex(at).keys()].filter(
          (id) => !tasks.includes(id),
        );
        return defaultDrainSeams.nextReady(
          at,
          new Set([...skip, ...others]),
          actor,
        );
      },
    },
    (line) => process.stdout.write(`${line}\n`),
  );
  return result.exitCode;
}

function mergedPulls(paths: LivePaths, env: NodeJS.ProcessEnv): MergedPull[] {
  const listed = run(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      paths.repository,
      '--state',
      'merged',
      '--limit',
      '200',
      '--json',
      'number,title,headRefName,mergeCommit',
    ],
    paths.root,
    env,
  );
  if (listed.code !== 0)
    throw new Error(`gh pr list exit ${listed.code}: ${listed.stderr}`);
  return z.array(mergedPull).parse(JSON.parse(listed.stdout));
}

async function acceptance(
  paths: LivePaths,
  env: NodeJS.ProcessEnv,
  sha: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = run(
      'gh',
      [
        'api',
        `repos/${paths.repository}/commits/${sha}/check-runs`,
        '--jq',
        '[.check_runs[] | {name, status, conclusion}]',
      ],
      paths.root,
      env,
    );
    const conclusion =
      listed.code === 0
        ? checkConclusion(JSON.parse(listed.stdout || '[]'))
        : undefined;
    if (conclusion !== undefined) return conclusion;
    if (Date.now() > deadline) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

/** Seed (once), drain cut at (d), rerun, then count merges per task on GitHub and read CI on each merge. */
export async function liveRecovery(
  paths: LivePaths,
  windowHours: string,
  say: (line: string) => void,
): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KRN_APP_REPOSITORY: paths.repository,
  };
  mkdirSync(paths.bin, { recursive: true });
  writeFileSync(join(paths.bin, 'gh'), killShim);
  chmodSync(join(paths.bin, 'gh'), 0o755);
  const state: LiveState = existsSync(paths.state)
    ? JSON.parse(readFileSync(paths.state, 'utf8'))
    : { tasks: seedTasks(paths, env, say) };
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  say(`live: batch ${state.tasks.join(', ')}`);
  const counts = () => {
    const pulls = mergedPulls(paths, env);
    return new Map(state.tasks.map((id) => [id, deliveries(pulls, id)]));
  };
  if (!existsSync(paths.killed)) {
    const first = await liveDrain(
      paths,
      env,
      state.tasks,
      windowHours,
      true,
      join(paths.dir, 'drain-cut.log'),
    );
    if (!existsSync(paths.killed)) {
      say(
        `FAIL live: the cut at d did not fire (exit ${first.code}, signal ${first.signal}); see ${join(paths.dir, 'drain-cut.log')}`,
      );
      return 1;
    }
    const cut = readFileSync(paths.killed, 'utf8').trim();
    const merged = [...counts()].filter(([, pulls]) => pulls.length > 0);
    const [cutTask] = merged.map(([id]) => id);
    const record =
      cutTask === undefined
        ? ''
        : readFileSync(join(paths.root, 'tasks', `${cutTask}.json`), 'utf8');
    if (merged.length !== 1 || !record.includes('"open"')) {
      say(
        `FAIL live: the cut (${cut}) did not land after one merge and before its receipt: merged ${merged.map(([id]) => id).join(', ') || 'none'}`,
      );
      return 1;
    }
    say(
      `live: cut at ${cut}: ${cutTask} merged on GitHub, its record still open in the checkout`,
    );
  }
  for (let rerun = 1; rerun <= 2; rerun += 1) {
    if ([...counts().values()].every((pulls) => pulls.length >= 1)) break;
    const next = await liveDrain(
      paths,
      env,
      state.tasks,
      windowHours,
      false,
      join(paths.dir, `drain-rerun-${rerun}.log`),
    );
    say(`live: rerun ${rerun} exit ${next.code}`);
  }
  let failed = 0;
  for (const [id, pulls] of counts()) {
    const sha = pulls[0]?.mergeCommit?.oid;
    const ci =
      pulls.length === 1 && sha !== undefined
        ? await acceptance(paths, env, sha, 30 * 60_000)
        : 'not read';
    const pass = pulls.length === 1 && ci === 'success';
    if (!pass) failed += 1;
    say(
      `${pass ? 'PASS' : 'FAIL'} live ${id}: merged PRs ${pulls.map((pull) => `#${pull.number}`).join(', ') || 'none'} (${pulls.length}), merge ${sha?.slice(0, 7) ?? '-'} ci / Check ${ci}`,
    );
  }
  const record = (id: string) =>
    readFileSync(join(paths.root, 'tasks', `${id}.json`), 'utf8');
  const unrecorded = state.tasks.filter(
    (id) => !record(id).includes('"closed"'),
  );
  if (unrecorded.length > 0) {
    failed += 1;
    say(`FAIL live: the checkout still lists open: ${unrecorded.join(', ')}`);
  }
  say(
    failed === 0
      ? 'PASS live recovery: one merge per task, each merge green'
      : `FAIL live recovery: ${failed} check(s)`,
  );
  return failed === 0 ? 0 : 1;
}
