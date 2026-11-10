// FR-40 on Claude lanes (preregistration-lanes.md): one headless `claude -p` session per unit and
// arm (A: brief alone, B: the packet carrier of src/brain/worker-packet.ts prepended), scored by the
// frozen scorer through `krn eval score`. Evidence lands in the frozen layout under --root
// (<root>/fr40/runs/<runId>/{session,score}.json) so `report` here reads what `krn eval` writes.
// Completed runs are skipped, so an interrupted campaign resumes where it stopped.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fr40Packet } from '../../src/brain/cli.ts';
import { packetBrief } from '../../src/brain/worker-packet.ts';
import { fr40Manifest, loadManifest } from '../../src/evals/manifest.ts';
import { planExperiment } from '../../src/evals/plan.ts';
import { bonettPrice, mcnemarOneSided } from '../../src/evals/stats.ts';
import {
  campaignOrder,
  type PlannedRun,
  prepareSlot,
  runDirectory,
} from './run.ts';
import type { ConventionTask } from './tasks.ts';

export type LaneArm = 'A' | 'B';

export const LANE_MODEL = 'claude-sonnet-5-5';
/** Preregistered: $140 counted per session from recorded usage. */
export const CEILING_USD = 140;
/** Preregistered: 25 minutes a session. */
export const SESSION_CAP_MS = 25 * 60 * 1000;
/** Preregistered: an invalid session is rerun once; more than 14 of 266 stay invalid fails the run. */
export const INVALID_LIMIT = 14;
export const EARLY_STOP_UNITS = 20;
/** Dollars one in-flight session may still add when the ceiling guard decides to launch. */
const RESERVE_USD = 1;

/** The tools, permission mode and settings every session uses; hashed as the session config. */
export const LANE_ARGS = [
  '-p',
  '--model',
  LANE_MODEL,
  '--output-format',
  'json',
  '--tools',
  'Bash,Read,Edit,Write,Glob,Grep',
  '--permission-mode',
  'bypassPermissions',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--setting-sources',
  'user',
] as const;
export const LANE_ENV = {
  CLAUDE_CODE_SESSION_ATTENDED: '0',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
} as const;

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export function laneConfigSha256(): string {
  return sha256(JSON.stringify({ args: LANE_ARGS, env: LANE_ENV }));
}

export type LaneBrief = {
  /** The whole prompt of the session. */
  readonly prompt: string;
  /** What precedes the brief: empty for arm A, the carrier prefix for arm B. */
  readonly prefix: string;
};

/**
 * Arm A is the brief alone; arm B is `packetBrief` of the unit's arm-B packet over the same brief.
 * A B prompt without a prefix (an empty packet) is arm leakage in the other direction and throws.
 */
export function laneBrief(
  task: ConventionTask,
  arm: LaneArm,
  packetFor: (id: string) => ReturnType<typeof fr40Packet> = (id) =>
    fr40Packet(id, 'brain'),
): LaneBrief {
  const brief = `${task.prompt.trim()}\n`;
  if (arm === 'A') return { prompt: brief, prefix: '' };
  const prompt = packetBrief(packetFor(task.id), brief);
  const prefix = prompt.slice(0, prompt.length - brief.length);
  if (prefix === '') throw new Error(`${task.id}: arm B has no carrier prefix`);
  return { prompt, prefix };
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type SessionVerdict =
  | {
      readonly status: 'completed';
      readonly usage: Usage;
      readonly cost: number;
    }
  | {
      readonly status: 'cap';
      readonly usage: Usage | null;
      readonly cost: number;
    }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      readonly cost: number;
    };

const num = (value: unknown) => (typeof value === 'number' ? value : null);

/** Classify one `claude -p --output-format json` result. A timeout or turn limit is a cap, not invalid. */
export function classifySession(
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): SessionVerdict {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    /* handled below */
  }
  const record =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  const u = record?.usage as Record<string, unknown> | undefined;
  const usage =
    u &&
    num(u.input_tokens) !== null &&
    num(u.output_tokens) !== null &&
    num(u.cache_read_input_tokens) !== null &&
    num(u.cache_creation_input_tokens) !== null
      ? ({
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
        } as Usage)
      : null;
  const cost = num(record?.total_cost_usd) ?? 0;
  if (timedOut) return { status: 'cap', usage, cost };
  if (record?.subtype === 'error_max_turns')
    return { status: 'cap', usage, cost };
  if (usage === null || num(record?.total_cost_usd) === null)
    return { status: 'invalid', reason: 'no usage record', cost };
  if (
    exitCode !== 0 ||
    record?.is_error === true ||
    record?.subtype !== 'success'
  )
    return {
      status: 'invalid',
      reason: `exit ${exitCode} ${String(record?.subtype)}`,
      cost,
    };
  return { status: 'completed', usage, cost };
}

/** Input plus output over all turns, cache reads and writes included (FR-40's total_tokens). */
export const totalTokens = (usage: Usage) =>
  usage.input_tokens +
  usage.output_tokens +
  usage.cache_creation_input_tokens +
  usage.cache_read_input_tokens;

// ---- analysis -------------------------------------------------------------

export type Unit = {
  readonly task: string;
  readonly stratum: string;
  readonly a: 'pass' | 'fail';
  readonly b: 'pass' | 'fail';
  readonly tokensA: number | null;
  readonly tokensB: number | null;
};

export type Gap = {
  readonly units: number;
  readonly wins: number;
  readonly losses: number;
  readonly difference: number;
  readonly p: number;
  readonly lower: number;
  readonly upper: number;
};

export function gap(units: readonly Unit[], level = 0.9): Gap {
  const wins = units.filter((u) => u.b === 'pass' && u.a === 'fail').length;
  const losses = units.filter((u) => u.a === 'pass' && u.b === 'fail').length;
  const n = units.length;
  return {
    units: n,
    wins,
    losses,
    difference: n === 0 ? 0 : (wins - losses) / n,
    p: mcnemarOneSided(wins + losses, wins),
    ...bonettPrice(wins, losses, n, level),
  };
}

export function tokenRatio(units: readonly Unit[]): number | null {
  let a = 0;
  let b = 0;
  for (const u of units) {
    if (u.tokensA === null || u.tokensB === null) continue;
    a += u.tokensA;
    b += u.tokensB;
  }
  return a === 0 ? null : b / a;
}

export type Decision = 'STOP' | 'CONTINUE' | 'KEEP' | 'EPITAPH';

/**
 * Preregistered rule: after the first 20 units STOP (epitaph) if B-A <= 0, else continue; over all
 * units KEEP if B-A >= +15 pp, one-sided exact McNemar p < 0.05 and token ratio <= 1.25.
 */
export function decide(
  units: readonly Unit[],
  total: number,
  thresholds = { gap: 0.15, alpha: 0.05, tokens: 1.25 },
): Decision {
  const g = gap(units);
  if (units.length < total)
    return units.length >= EARLY_STOP_UNITS && g.difference <= 0
      ? 'STOP'
      : 'CONTINUE';
  const ratio = tokenRatio(units);
  return g.difference >= thresholds.gap - 1e-12 &&
    g.p < thresholds.alpha &&
    ratio !== null &&
    ratio <= thresholds.tokens
    ? 'KEEP'
    : 'EPITAPH';
}

// ---- running --------------------------------------------------------------

const experiment = fileURLToPath(new URL('.', import.meta.url));
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

type Options = {
  readonly root: string;
  readonly slots: string;
  readonly source: string;
  readonly jobs: number;
};

function spend(root: string): number {
  const file = join(root, 'spend.jsonl');
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce(
      (sum, line) => sum + (JSON.parse(line) as { cost: number }).cost,
      0,
    );
}

function execute(
  cwd: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn('claude', [...LANE_ARGS], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
    }, SESSION_CAP_MS);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      done({ stdout, exitCode, timedOut });
    });
    child.once('error', () => {
      clearTimeout(timer);
      done({ stdout, exitCode: 70, timedOut });
    });
    child.stdin.end(prompt);
  });
}

function scoreRun(
  runId: string,
  slot: string,
  root: string,
  base: string | undefined,
): number {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'eval',
      'score',
      '--experiment',
      experiment,
      '--root',
      root,
      '--run',
      runId,
      '--slot',
      slot,
      ...(base === undefined ? [] : ['--base', base]),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return result.status ?? 70;
}

const git = (repo: string, ...args: string[]) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout.trim();

let inFlight = 0;

async function runOne(
  run: PlannedRun,
  task: ConventionTask,
  options: Options,
): Promise<string> {
  const output = runDirectory(options.root, 'fr40', run.runId);
  if (existsSync(join(output, 'score.json'))) return 'done';
  const arm = run.arm as LaneArm;
  const { prompt, prefix } = laneBrief(task, arm);
  const prefixSha256 = prefix === '' ? null : sha256(prefix);
  const packetText = arm === 'B' ? prefix : '';
  if (arm === 'A' && /Repository conventions|\[r-[a-z-]+\]/u.test(prompt))
    throw new Error(`${run.task}: arm leakage, arm A shows packet text`);
  if (arm === 'B' && !prompt.startsWith(packetText))
    throw new Error(`${run.task}: arm B lacks the prefix`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (spend(options.root) + inFlight * RESERVE_USD >= CEILING_USD)
      return 'ceiling';
    await rm(output, { recursive: true, force: true });
    const slot = join(options.slots, `${run.runId}-${attempt}`);
    await rm(slot, { recursive: true, force: true });
    const base = await prepareSlot(options.source, slot, task);
    const config = join(slot, 'config');
    await mkdir(config, { recursive: true });
    await symlink(
      join(homedir(), '.claude', '.credentials.json'),
      join(config, '.credentials.json'),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'dumb',
      CLAUDE_CONFIG_DIR: config,
      ...LANE_ENV,
    };
    const startedAt = new Date().toISOString();
    inFlight += 1;
    const ran = await execute(join(slot, 'repo'), prompt, env).finally(() => {
      inFlight -= 1;
    });
    const verdict = classifySession(ran.stdout, ran.exitCode, ran.timedOut);
    appendFileSync(
      join(options.root, 'spend.jsonl'),
      `${JSON.stringify({ runId: run.runId, attempt, status: verdict.status, cost: verdict.cost })}\n`,
    );
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'claude.json'), ran.stdout);
    await writeFile(
      join(output, 'repo.patch'),
      `${git(join(slot, 'repo'), 'log', '-p', '--format=commit %H%n%B', `${base}..HEAD`)}\n--- status\n${git(join(slot, 'repo'), 'status', '--porcelain', '--untracked-files=all')}\n`,
    );
    const usage = verdict.status === 'invalid' ? null : verdict.usage;
    await writeFile(
      join(output, 'session.json'),
      `${JSON.stringify(
        {
          runId: run.runId,
          arm,
          harness: 'claude',
          model: LANE_MODEL,
          receiver: 'claude-code',
          configSha256: laneConfigSha256(),
          promptSha256: sha256(prompt),
          prefixSha256,
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: ran.exitCode,
          status: verdict.status,
          attempt,
          costUsd: verdict.cost,
          usage:
            usage === null
              ? { status: 'missing' }
              : {
                  status: 'complete',
                  ...usage,
                  total_tokens: totalTokens(usage),
                },
        },
        null,
        2,
      )}\n`,
    );
    let ok = verdict.status !== 'invalid';
    if (verdict.status === 'cap')
      await writeFile(
        join(output, 'score.json'),
        `${JSON.stringify({ runId: run.runId, task: run.task, arm, replica: run.replica, status: 'fail', exitCode: null, reason: 'session cap (timeout or turn limit): counted as a fail' }, null, 2)}\n`,
      );
    else if (ok)
      ok =
        scoreRun(
          run.runId,
          slot,
          options.root,
          base === task.base ? undefined : base,
        ) === 0;
    if (ok) {
      await rm(slot, { recursive: true, force: true });
      return verdict.status;
    }
    // Invalid: set the evidence aside; the first failure reruns, the second stays invalid.
    const invalid = join(options.root, 'fr40', 'invalid');
    await mkdir(invalid, { recursive: true });
    await rename(output, join(invalid, `${run.runId}-${attempt}`));
    await rm(slot, { recursive: true, force: true });
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'score.json'),
    `${JSON.stringify({ runId: run.runId, task: run.task, arm, replica: run.replica, status: 'error', exitCode: null, reason: 'invalid twice' }, null, 2)}\n`,
  );
  return 'invalid';
}

// ---- report ---------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type LaneReport = {
  readonly decision: Decision | 'FAILED';
  readonly units: Unit[];
  readonly gap: Gap;
  readonly gapWithoutCommitTitle: Gap;
  readonly ratio: number | null;
  readonly spent: number;
  readonly sessions: number;
  readonly invalid: number;
  readonly caps: number;
  readonly strata: Record<string, { A: number; B: number; units: number }>;
  readonly reasons: string[];
};

/** Read the evidence under root; `limit` restricts to the first n units of the campaign order. */
export async function laneReport(
  root: string,
  limit: number,
): Promise<LaneReport> {
  const manifest = fr40Manifest(await loadManifest(experiment));
  const tasks = JSON.parse(
    readFileSync(join(experiment, manifest.taskFile), 'utf8'),
  ) as ConventionTask[];
  const runs = planExperiment(manifest).runs.filter((r) => r.arm !== 'S');
  const order = [...new Set(campaignOrder(runs, tasks).map((r) => r.task))];
  const stratum = new Map(manifest.tasks.map((t) => [t.id, t.stratum]));
  const planned = order.slice(0, limit);
  const reasons: string[] = [];
  const units: Unit[] = [];
  const configs = new Set<string>();
  const prefixes = new Map<string, string>();
  let sessions = 0;
  let invalid = 0;
  let caps = 0;
  for (const id of planned) {
    const read = (arm: LaneArm) => {
      const run = runs.find((r) => r.task === id && r.arm === arm);
      if (!run) return null;
      const dir = runDirectory(root, 'fr40', run.runId);
      return {
        score: readJson(join(dir, 'score.json')),
        session: readJson(join(dir, 'session.json')),
      };
    };
    const a = read('A');
    const b = read('B');
    for (const [arm, r] of [
      ['A', a],
      ['B', b],
    ] as const) {
      if (!r?.score) continue;
      sessions += 1;
      const session = r.session;
      if (session?.status === 'cap') caps += 1;
      if (r.score.status === 'error') invalid += 1;
      if (typeof session?.configSha256 === 'string')
        configs.add(session.configSha256);
      if (session?.model !== LANE_MODEL)
        reasons.push(`${id} ${arm}: model drift`);
      if (arm === 'A' && session?.prefixSha256 != null)
        reasons.push(`${id} A: arm leakage`);
      if (arm === 'B' && session?.prefixSha256 == null)
        reasons.push(`${id} B: no prefix`);
      if (arm === 'B' && typeof session?.prefixSha256 === 'string')
        prefixes.set(id, session.prefixSha256);
    }
    const sa = a?.score?.status;
    const sb = b?.score?.status;
    if ((sa === 'pass' || sa === 'fail') && (sb === 'pass' || sb === 'fail')) {
      const tok = (r: typeof a) =>
        num(
          (r?.session?.usage as Record<string, unknown> | undefined)
            ?.total_tokens,
        );
      units.push({
        task: id,
        stratum: stratum.get(id) ?? '',
        a: sa,
        b: sb,
        tokensA: tok(a),
        tokensB: tok(b),
      });
    }
  }
  if (configs.size > 1)
    reasons.push(`config drift: ${[...configs].join(', ')}`);
  if (configs.size === 1 && !configs.has(laneConfigSha256()))
    reasons.push('config differs from the frozen lane config');
  const spent = spend(root);
  if (spent > CEILING_USD)
    reasons.push(`spend ${spent.toFixed(2)} exceeds ceiling`);
  const sessionsTotal = limit * 2;
  if (invalid > Math.floor(sessionsTotal * 0.05))
    reasons.push(`${invalid} invalid sessions exceed 5%`);
  if (units.length < planned.length)
    reasons.push(`only ${units.length} of ${planned.length} units scored`);
  const strata: LaneReport['strata'] = {};
  for (const u of units) {
    const s = strata[u.stratum] ?? { A: 0, B: 0, units: 0 };
    strata[u.stratum] = s;
    s.units += 1;
    if (u.a === 'pass') s.A += 1;
    if (u.b === 'pass') s.B += 1;
  }
  const decision =
    reasons.length > 0 ? 'FAILED' : decide(units, manifest.tasks.length);
  return {
    decision,
    units,
    gap: gap(units),
    gapWithoutCommitTitle: gap(
      units.filter((u) => u.stratum !== 'commit-title-id'),
    ),
    ratio: tokenRatio(units),
    spent,
    sessions,
    invalid,
    caps,
    strata,
    reasons,
  };
}

const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`;

export function formatLaneReport(r: LaneReport): string {
  const g = (x: Gap) =>
    `${x.units} units, ${x.wins} wins, ${x.losses} losses, ${pp(x.difference)}, p=${x.p.toFixed(4)}, 90% Bonett-Price [${pp(x.lower)}, ${pp(x.upper)}]`;
  return [
    `decision: ${r.decision}`,
    `B-A: ${g(r.gap)}`,
    `B-A without commit-title-id: ${g(r.gapWithoutCommitTitle)}`,
    `token ratio B/A: ${r.ratio === null ? 'n/a' : r.ratio.toFixed(3)}`,
    `sessions ${r.sessions}, invalid ${r.invalid}, caps ${r.caps}, spent $${r.spent.toFixed(2)}`,
    'stratum\tunits\tA\tB',
    ...Object.entries(r.strata).map(
      ([s, v]) => `${s}\t${v.units}\t${v.A}\t${v.B}`,
    ),
    ...r.reasons.map((x) => `failed: ${x}`),
    '',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
  const [command = ''] = argv;
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = flag('--root');
  if (!root || (command !== 'run' && command !== 'report')) {
    process.stderr.write(
      'usage: lanes.ts run|report --root <evidence dir> [--slots <dir>] [--source <repo>] [--jobs <n>] [--units <n>]\n',
    );
    process.exit(64);
  }
  const units = Number(flag('--units') ?? '133');
  if (command === 'report') {
    const report = await laneReport(resolve(root), units);
    const text = formatLaneReport(report);
    process.stdout.write(text);
    writeFileSync(join(resolve(root), `report-${units}.txt`), text);
    return;
  }
  const slots = flag('--slots');
  const source = flag('--source');
  if (!slots || !source) throw new Error('run needs --slots and --source');
  const options: Options = {
    root: resolve(root),
    slots: resolve(slots),
    source: resolve(source),
    jobs: Number(flag('--jobs') ?? '4'),
  };
  await mkdir(options.root, { recursive: true });
  await mkdir(options.slots, { recursive: true });
  const manifest = fr40Manifest(await loadManifest(experiment)); // verifies every input hash
  const tasks = JSON.parse(
    readFileSync(join(experiment, manifest.taskFile), 'utf8'),
  ) as ConventionTask[];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const runs = campaignOrder(
    planExperiment(manifest).runs.filter((r) => r.arm !== 'S'),
    tasks,
  );
  const wanted = new Set([...new Set(runs.map((r) => r.task))].slice(0, units));
  const queue = runs.filter((r) => wanted.has(r.task));
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < queue.length && !stopped) {
      const run = queue[next++];
      const task = run && byId.get(run.task);
      if (!run || !task) continue;
      const started = Date.now();
      const result = await runOne(run, task, options);
      if (result === 'ceiling') stopped = true;
      process.stdout.write(
        `${new Date().toISOString()} ${run.runId.slice(0, 12)} ${run.task} ${run.arm} ${result} ${Math.round((Date.now() - started) / 1000)}s spent=$${spend(options.root).toFixed(2)}\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
