// The headless session driver: spawns one `claude -p` session in its own process group, kills the group when the
// session ends or its time limit passes, and reads the result. `krn lane run` and the replay arm-C rows both run
// sessions through it. Asynchronous: an in-process egress proxy (evals/units/egress.ts) must keep serving while the
// session runs.
import { spawn } from 'node:child_process';
import {
  parseSessionResult,
  type SessionResult,
} from '../../src/cli/lane-run/result.ts';

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
  /** Text written to the session's stdin; none closes it empty. */
  stdin?: string;
}

/** What the driver saw: the parsed result, and whether the session never started. */
export interface DrivenSession {
  result: SessionResult;
  notStarted: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const maxOutput = 64 * 1024 * 1024;

/** Runs one headless session to its end and reads its result. */
export function driveSession(s: HeadlessSession): Promise<DrivenSession> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: NodeJS.ErrnoException | undefined;
    const child = spawn(s.command, s.argv, {
      cwd: s.cwd,
      env: s.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the timeout kills the session's children with it.
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, s.timeoutMs);
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
      clearTimeout(timer);
      killGroup(child.pid);
      resolve({
        result: resultOf(s, { stdout, stderr, timedOut, error }),
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
  if (run.timedOut)
    return {
      ok: false,
      detail: `session timeout after ${Math.round(s.timeoutMs / 1000)}s (capped below the App token lifetime)`,
      cost: undefined,
    };
  if (run.error !== undefined)
    return {
      ok: false,
      detail:
        run.error.code === 'ENOENT'
          ? `session did not run: ${s.claude} not found (put claude on PATH or set KRN_LANE_CLAUDE)`
          : `session did not run: ${run.error.message}`,
      cost: undefined,
    };
  return parseSessionResult(run.stdout, run.stderr);
}
