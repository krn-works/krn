import { spawnSync } from 'node:child_process';
import { logsCommand } from '../../ci/logs.ts';
import { shipCommand } from '../../ci/ship.ts';
import { tokenHelper, tokenMinimumRemainingSeconds } from './environment.ts';

export interface LaneVerdict {
  line: string;
  exitCode: number;
  /** sha256 of the brain packet the session prompt carried; null when it carried none or no session prompt was built. */
  packet?: string | null;
}

/** The steps a task run takes outside its own logic; tests replace the ones that reach GitHub. */
export interface LaneRunSteps {
  start(args: string[]): Promise<{ path: string; slug: string }>;
  ship(args: string[]): Promise<string>;
  /** Mint the GitHub App token (warming its cache) before the session starts; a string is the failure. */
  mint(env: NodeJS.ProcessEnv): Promise<string | undefined>;
  /** `krn ci logs --run RUN` output, read when a rerun follows a red Check. */
  ciLogs?(run: string, cwd: string): Promise<string>;
}

/** Why a token helper run failed (its first stderr line, else why it could not start), or undefined when it succeeded. */
export function mintFailure(result: {
  status: number | null;
  stderr?: string | null | undefined;
  error?: Error | undefined;
}): string | undefined {
  if (result.status === 0) return undefined;
  return (
    result.stderr?.trim().split('\n')[0] ||
    result.error?.message ||
    `token helper exited with status ${result.status}`
  );
}

export const defaultSteps: Required<LaneRunSteps> = {
  ciLogs: (run, cwd) => logsCommand(['--run', run], { cwd }),
  start: async (args) => (await import('../lane.ts')).startLane(args),
  ship: (args) => shipCommand(args),
  mint: async (env) => {
    const result = spawnSync(process.execPath, [tokenHelper, 'token'], {
      encoding: 'utf8',
      // The mint runs outside the sandbox, so it may reach the vault; the lane class would make it cache-only.
      env: {
        ...env,
        KRN_SESSION_CLASS: undefined as string | undefined,
        KRN_APP_REUSE_MARGIN_SECONDS: String(tokenMinimumRemainingSeconds),
      },
      timeout: 30000,
    });
    return mintFailure(result);
  },
};
