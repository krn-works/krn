// The headless session driver: spawns one `claude -p` session in its own process group, kills the group when the
// session ends or its time limit passes, and reads the result. `krn lane run` and the replay arm-C rows both run
// sessions through it. Asynchronous: an in-process egress proxy (evals/units/egress.ts) must keep serving while the
// session runs.
import { spawn } from 'node:child_process';
import {
  forgetSessionGroup,
  recordSessionGroup,
} from '../../src/cli/lane-run/cut-session.ts';
import { parseSessionResult, type SessionResult } from './session-result.ts';

/** Kill every process the session left in its own process group (a Bash child can outlive claude). */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* The group is already gone. */
  }
}

export interface HeadlessSession {
  /** The program to spawn: claude itself, or a wrapper (bwrap) whose argv ends in the claude command. */
  command: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** The claude binary the session names, for the not-found detail. */
  claude: string;
  /** A file that holds the session's process group while it runs; a run cut before the session ends leaves it. */
  groupFile?: string;
  /** Text written to the session's stdin; none closes it empty. */
  stdin?: string;
  /** Reads a session that ran to its end; the default reads a `claude -p` JSON result. */
  parse?: (stdout: string, stderr: string) => SessionResult;
  /**
   * A dollar cap the driver enforces for a harness without one of its own (Codex): every `everyMs` it reads the spend
   * so far and kills the session at `usd`, which then ends capped like a Claude session at `--max-budget-usd`.
   */
  budget?: { usd: number; spent: () => number | undefined; everyMs?: number };
  /**
   * The wall clock the time limit is measured on (default Date.now). Node timers run on a monotonic clock that stops
   * while the host sleeps; the driver also checks this clock every `tickMs`, so a session that outlived its limit across
   * a host suspend is killed as soon as the host wakes.
   */
  now?: () => number;
  tickMs?: number;
}

/** What the driver saw: the parsed result, and whether the session never started. */
export interface DrivenSession {
  result: SessionResult;
  notStarted: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Whether the arm's session ran: it succeeded or used its whole time or budget. A usage-limit or crash result is no
 * evidence about the arm. Every replay arm decides through this one rule.
 */
export const sessionRan = (s: DrivenSession): boolean =>
  !s.notStarted && (s.timedOut || s.result.ok || s.result.capped === true);

const maxOutput = 64 * 1024 * 1024;

/** Runs one headless session to its end and reads its result. */
export function driveSession(s: HeadlessSession): Promise<DrivenSession> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let capped = false;
    let error: NodeJS.ErrnoException | undefined;
    const child = spawn(s.command, s.argv, {
      cwd: s.cwd,
      env: s.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the timeout kills the session's children with it.
      detached: true,
    });
    if (s.groupFile !== undefined && child.pid !== undefined)
      recordSessionGroup(s.groupFile, child.pid);
    const now = s.now ?? Date.now;
    const deadline = now() + s.timeoutMs;
    let closed = false;
    let drain: NodeJS.Timeout | undefined;
    // SIGKILL to the whole group: a session (or its child) that ignores SIGTERM still ends. A descendant that left the
    // group and holds the output pipes open would keep 'close' from firing, so the pipes are cut a moment later.
    const kill = () => {
      killGroup(child.pid);
      drain ??= setTimeout(() => {
        if (closed) return;
        child.stdout.destroy();
        child.stderr.destroy();
      }, 2_000);
    };
    const timeUp = () => {
      if (timedOut || capped) return;
      timedOut = true;
      kill();
    };
    const timer = setTimeout(timeUp, s.timeoutMs);
    const tick = setInterval(() => {
      if (now() >= deadline) timeUp();
    }, s.tickMs ?? 1_000);
    const poll =
      s.budget === undefined
        ? undefined
        : setInterval(() => {
            const spent = s.budget?.spent();
            if (
              !timedOut &&
              !capped &&
              spent !== undefined &&
              spent >= (s.budget?.usd ?? Infinity)
            ) {
              capped = true;
              kill();
            }
          }, s.budget.everyMs ?? 10_000);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d;
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxOutput) stderr += d;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(s.stdin ?? '');
    child.on('error', (e) => {
      error = e;
    });
    child.on('close', () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(tick);
      if (drain) clearTimeout(drain);
      if (poll) clearInterval(poll);
      killGroup(child.pid);
      if (s.groupFile !== undefined) forgetSessionGroup(s.groupFile);
      const result = resultOf(s, { stdout, stderr, timedOut, error });
      resolve({
        result: capped
          ? {
              ...result,
              ok: false,
              capped: true,
              detail: `session killed at its $${s.budget?.usd} budget`,
            }
          : result,
        notStarted: error !== undefined && !timedOut,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function resultOf(
  s: HeadlessSession,
  run: {
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error: NodeJS.ErrnoException | undefined;
  },
): SessionResult {
  if (run.timedOut) {
    // A reader that sees spend outside the result (a Codex rollout) still charges a killed session.
    const seen = s.parse?.(run.stdout, run.stderr);
    return {
      ok: false,
      detail: `session timeout after ${Math.round(s.timeoutMs / 1000)}s (capped below the App token lifetime)`,
      cost: seen?.cost,
      ...(seen?.tokens === undefined ? {} : { tokens: seen.tokens }),
      ...(seen?.model === undefined ? {} : { model: seen.model }),
    };
  }
  if (run.error !== undefined)
    return {
      ok: false,
      detail:
        run.error.code === 'ENOENT'
          ? `session did not run: ${s.claude} not found (put claude on PATH or set KRN_LANE_CLAUDE)`
          : `session did not run: ${run.error.message}`,
      cost: undefined,
    };
  return (s.parse ?? parseSessionResult)(run.stdout, run.stderr);
}
