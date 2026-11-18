// A live replay row for an arm that runs through the session driver (arms B and C): the unit's base checkout is
// prepared by the arm, one headless session runs in the same bubblewrap sandbox and egress proxy as arm A, and the
// unit's hidden test grades the result into a row.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { outsideGit } from '../../src/cli/outside-git.ts';
import {
  CODEX_HOSTS,
  codexSessionEnv,
  isCodexModel,
  parseCodexResult,
  rolloutFiles,
} from '../../src/harness/codex.ts';
import { shellWord } from '../../src/repo/shell-text.ts';
import { withSessionSlot } from '../session-slot.ts';
import { SESSION_HOSTS, startEgress } from '../units/egress.ts';
import { requireSandbox, sandboxArgv } from '../units/sandbox.ts';
import {
  forceRemove,
  gradeWorktree,
  INSTALL_SECONDS,
  refuseScratchInRepository,
  toolchainEnv,
} from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';
import type { Arm } from './arms.ts';
import {
  attemptVerdict,
  gateRefusal,
  type Harness,
  type StreamFacts,
  streamFacts,
} from './attempt.ts';
import {
  isolatedEnv,
  type LiveUnit,
  promptOf,
  sessionWritable,
} from './live.ts';
import { baseCheckout } from './recording.ts';
import type { Row } from './rows.ts';
import { type DrivenSession, driveSession, sessionRan } from './session.ts';
import {
  SESSION_BUDGET_USD,
  SESSION_MODEL,
  SESSION_MS,
  sessionBinary,
  sessionCommand,
  settingsPath,
} from './session-args.ts';

/** One session turn of an attempt: the first prompt, or the gate's re-prompt resuming the session it names. */
export interface SessionTurn {
  prompt: string;
  resume?: string;
  /** Wall time and dollars the attempt has left for this turn. */
  ms: number;
  usd: number;
}

export interface ArmOptions {
  sources: string;
  scratch: string;
  harness: string;
  env?: NodeJS.ProcessEnv;
  sessionMs?: number;
  model?: string | undefined;
  budgetUsd?: number;
  /** Runs the session; the default is the sandboxed driver. Tests pass a recorded one. */
  session?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
    turn?: SessionTurn,
  ) => Promise<DrivenSession>;
  /** Resolves the unit's toolchain before any session; the exit code, 0 when it resolved. Default: the sandboxed install. */
  preflight?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
  ) => Promise<number>;
}

/** Commits the arm's checkout preparation, so the session's change is the only uncommitted work. */
export function commitPreparation(wt: string, message: string): void {
  outsideGit(wt, ['add', '-A']);
  outsideGit(wt, [
    '-c',
    'user.name=krn-eval',
    '-c',
    'user.email=krn-eval@localhost',
    'commit',
    '-qm',
    message,
  ]);
}

/** The cache a unit's preflight install fills and its sessions build against, shared with the grade's pins. */
const sessionCache = (env: NodeJS.ProcessEnv): string =>
  join(dirname(env.CLAUDE_CONFIG_DIR ?? env.TMPDIR ?? tmpdir()), 'cache');

/** The session environment with the toolchain pins and caches the grade uses (screening.ts toolchainEnv). */
export function withToolchain(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cache = sessionCache(env);
  mkdirSync(cache, { recursive: true });
  return { ...env, ...toolchainEnv(cache) };
}

/**
 * Resolves the unit's toolchain the way its session will see it: the unit's install command inside the session's
 * sandbox and environment, through the grade's egress. A non-zero exit screens the unit out before any session.
 */
export async function sandboxedPreflight(
  unit: Unit,
  wt: string,
  env: NodeJS.ProcessEnv,
  log: string,
): Promise<number> {
  const sessionEnv = withToolchain(env);
  const egress = await startEgress(tmpdir());
  appendFileSync(log, `\n$ preflight: ${unit.install}\n`);
  const fd = openSync(log, 'a');
  try {
    return await new Promise<number>((resolve) => {
      const p = spawn(
        'bwrap',
        sandboxArgv(
          `timeout ${INSTALL_SECONDS} sh -c ${shellWord(unit.install)}`,
          {
            cwd: wt,
            writable: [...sessionWritable(wt, sessionEnv), sessionCache(env)],
            egress: egress.socket,
            env: sessionEnv,
          },
        ),
        { cwd: wt, env: sessionEnv, stdio: ['ignore', fd, fd] },
      );
      p.on('error', () => resolve(127));
      p.on('close', (c) => resolve(c ?? 1));
    });
  } finally {
    closeSync(fd);
    await egress.close();
  }
}

/** The sandboxed session of an arm: the shared session command, the unit's task as the brief. */
export async function sandboxedSession(
  arm: Arm,
  wt: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  o: Pick<ArmOptions, 'sessionMs' | 'model' | 'budgetUsd'> & {
    resume?: string;
  },
): Promise<DrivenSession> {
  const bin = sessionBinary(o.model, env);
  const settings = settingsPath(arm.id, env, wt);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, '{}\n');
  const budgetUsd = o.budgetUsd ?? SESSION_BUDGET_USD;
  const cmd = sessionCommand({
    bin,
    prompt,
    settings,
    budgetUsd,
    ...(o.model === undefined ? {} : { model: o.model }),
    ...(o.resume === undefined ? {} : { resume: o.resume }),
  });
  // A Codex session gets a private home holding only the host's ChatGPT login (refused when it would bill an API key),
  // the ChatGPT hosts on top of the shared egress list, and its result read from its own rollouts.
  const codex = isCodexModel(o.model ?? SESSION_MODEL)
    ? codexSessionEnv(
        join(dirname(settings), `codex-${basename(wt)}`),
        env,
        process.env,
      )
    : undefined;
  const sessionEnv = withToolchain(codex?.env ?? env);
  const egress = await startEgress(
    tmpdir(),
    codex ? [...SESSION_HOSTS, ...CODEX_HOSTS] : SESSION_HOSTS,
  );
  const home = sessionEnv.CODEX_HOME;
  const codexResult = (stdout: string, stderr: string) =>
    parseCodexResult(
      stdout,
      stderr,
      rolloutFiles(home as string).map((f) => readFileSync(f, 'utf8')),
    );
  try {
    return await driveSession({
      command: 'bwrap',
      argv: sandboxArgv(cmd, {
        cwd: wt,
        writable: [
          ...sessionWritable(wt, sessionEnv),
          dirname(settings),
          sessionCache(env),
          ...(codex?.writable ?? []),
        ],
        ...(isAbsolute(bin) ? { readable: [dirname(bin)] } : {}),
        egress: egress.socket,
        env: sessionEnv,
      }),
      cwd: wt,
      env: sessionEnv,
      timeoutMs: o.sessionMs ?? SESSION_MS,
      claude: bin,
      // Codex has no dollar cap of its own: the driver reads its rollouts and kills it at the Claude arm's cap.
      ...(codex && home
        ? {
            parse: codexResult,
            budget: { usd: budgetUsd, spent: () => codexResult('', '').cost },
          }
        : {}),
    });
  } finally {
    await egress.close();
  }
}

/** What one gated attempt yields for its row: its spend, realized model and the facts its streams show. */
export interface AttemptFields {
  cost: number | null;
  model: string | null;
  durationMs: number;
  toolCalls: number;
  testsRun: number;
  stopReason: string;
  reprompted: boolean;
}

/**
 * One attempt under the verify-before-end gate (attempt.ts) every arm meets: the session runs; when it ended by itself
 * without a passing last test run, it is resumed once with the refusal, inside the attempt's remaining time and dollars.
 * Codex reports cumulative spend from its rollouts; Claude reports each run's own, so its turns add up.
 */
export async function gatedAttempt(
  harness: Harness,
  prompt: string,
  caps: { ms: number; usd: number },
  run: (turn: SessionTurn) => Promise<DrivenSession>,
  now: () => number = Date.now,
): Promise<{ session: DrivenSession; ran: boolean; fields: AttemptFields }> {
  const t0 = now();
  const first = await run({ prompt, ms: caps.ms, usd: caps.usd });
  const facts = [streamFacts(harness, first.stdout)];
  const sessions = [first];
  const refusal = gateRefusal(facts[0] as StreamFacts);
  const id = facts[0]?.sessionId;
  const spent = first.result.cost ?? 0;
  const left = { ms: caps.ms - (now() - t0), usd: caps.usd - spent };
  if (
    first.result.ok &&
    refusal !== undefined &&
    id !== undefined &&
    left.ms > 0 &&
    left.usd > 0
  ) {
    const second = await run({ prompt: refusal, resume: id, ...left });
    sessions.push(second);
    facts.push(streamFacts(harness, second.stdout));
  }
  const last = sessions.at(-1) as DrivenSession;
  const lastFacts = facts.at(-1) as StreamFacts;
  const costs = sessions.map((s) => s.result.cost);
  const cost =
    harness === 'codex'
      ? (costs.findLast((c) => c !== undefined) ?? null)
      : costs.every((c) => c === undefined)
        ? null
        : costs.reduce<number>((a, c) => a + (c ?? 0), 0);
  // The attempt ran when its first session ran: a re-prompt that hit a usage limit does not erase the first session.
  const ran = sessionRan(first);
  return {
    session: last,
    ran,
    fields: {
      cost,
      model:
        [...new Set(sessions.flatMap((s) => s.result.model ?? []))]
          .sort()
          .join(',') || null,
      durationMs: now() - t0,
      toolCalls: facts.reduce((a, f) => a + f.toolCalls, 0),
      testsRun: facts.reduce((a, f) => a + f.tests.length, 0),
      stopReason: last.timedOut
        ? 'timeout'
        : last.result.capped
          ? 'budget'
          : lastFacts.stopReason,
      reprompted: sessions.length > 1,
    },
  };
}

/** Whether the checkout holds any change against its last commit (ignored build output aside). */
export const changedTree = (wt: string): boolean =>
  outsideGit(wt, ['status', '--porcelain']).trim() !== '';

/**
 * The whole live attempt of `arm` on a prepared checkout, shared by every arm: the toolchain preflight (a unit whose
 * toolchain does not resolve is screened out, never run), the gated session inside a host-wide slot, and the grade of
 * the change by the unit's hidden test. `beforeGrade` sees the checkout between session and grade (patch recording).
 */
export async function liveAttempt(
  arm: Arm,
  { unit, dir }: LiveUnit,
  wt: string,
  env: NodeJS.ProcessEnv,
  log: string,
  o: ArmOptions & { beforeGrade?: (wt: string) => void },
): Promise<{
  pass: boolean | null;
  grade?: { install: number; test: number };
  row: Omit<Row, 'unit' | 'arm' | 'rep' | 'harness' | 'pass'>;
}> {
  const slotEnv = o.env ?? process.env;
  const preflight =
    o.preflight ??
    (o.session === undefined
      ? (w: string, e: NodeJS.ProcessEnv, l: string) =>
          sandboxedPreflight(unit, w, e, l)
      : undefined);
  if (preflight !== undefined) {
    const code = await preflight(wt, env, log);
    // The preflight's own install output (node_modules, .venv) is ignored; anything else it left is not the session's.
    outsideGit(wt, ['checkout', '-q', '--', '.']);
    if (code !== 0)
      return {
        pass: null,
        row: {
          cost: null,
          model: null,
          verdict: 'screened',
          screenedOut: `toolchain install exit ${code}`,
        },
      };
  }
  const harness: Harness = isCodexModel(o.model ?? SESSION_MODEL)
    ? 'codex'
    : 'claude';
  const run =
    o.session === undefined
      ? (w: string, e: NodeJS.ProcessEnv, _l: string, t?: SessionTurn) =>
          sandboxedSession(arm, w, t?.prompt ?? promptOf(unit), e, {
            ...o,
            ...(t === undefined
              ? {}
              : {
                  sessionMs: t.ms,
                  budgetUsd: t.usd,
                  ...(t.resume === undefined ? {} : { resume: t.resume }),
                }),
          })
      : o.session;
  const a = await withSessionSlot(
    () =>
      gatedAttempt(
        harness,
        promptOf(unit),
        {
          ms: o.sessionMs ?? SESSION_MS,
          usd: o.budgetUsd ?? SESSION_BUDGET_USD,
        },
        async (t) => {
          const s = await run(wt, env, log, t);
          appendFileSync(log, `${s.stdout}\n${s.stderr}\n`);
          return s;
        },
      ),
    slotEnv,
  );
  const changed = a.ran && changedTree(wt);
  // The grade sees the session's source change on a fresh install: ignored leftovers of the session's own installs
  // or builds (node_modules, .venv, dist) are not part of a change and can break the grading install.
  if (a.ran) outsideGit(wt, ['clean', '-fdXq']);
  if (a.ran) o.beforeGrade?.(wt);
  const g = a.ran
    ? await gradeWorktree(wt, unit, dir, log, o.scratch)
    : undefined;
  const pass = g ? g.install === 0 && g.test === 0 : undefined;
  const verdict = attemptVerdict({
    ran: a.ran,
    testsRun: a.fields.testsRun,
    changed,
    pass,
  });
  return {
    // A no-attempt is reported apart, never as a plain fail.
    pass: verdict === 'no-attempt' ? null : (pass ?? null),
    ...(g ? { grade: g } : {}),
    row: { ...a.fields, verdict },
  };
}

/**
 * One session of `arm` on a checkout `prepare` has set up, and its grade; the session holds a slot, the grade does not.
 * `prepare` runs inside the checkout's lifetime and may return a note the caller keeps (token counts).
 */
export async function armRow<Note>(
  arm: Arm,
  { unit, dir }: LiveUnit,
  o: ArmOptions,
  rep: number,
  prepare: (wt: string, log: string) => Note,
): Promise<{ row: Row; note: Note }> {
  const env = isolatedEnv(o.scratch, o.env ?? process.env);
  const log = join(o.scratch, `${unit.id}-${arm.id}-${rep}.log`);
  if (o.session === undefined) requireSandbox();
  refuseScratchInRepository(o.scratch);
  const wt = baseCheckout(o.sources, unit, o.scratch);
  try {
    const note = prepare(wt, log);
    const a = await liveAttempt(arm, { unit, dir }, wt, env, log, o);
    return {
      row: {
        unit: unit.id,
        arm: arm.id,
        rep,
        pass: a.pass,
        harness: o.harness,
        ...a.row,
      },
      note,
    };
  } finally {
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}
