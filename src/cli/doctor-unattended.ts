import { spawnSync } from 'node:child_process';
import { tokenHelper } from './lane-run/environment.ts';

/** The mint failed: no App token, so nothing can ship. */
export const exitMintFailed = 69;
/** The vault session ends inside the window, or no vault session could be read. */
export const exitVaultShort = 75;
export const exitUsage = 64;

/** bw serve locks the vault after this long; an unattended run outliving it loses the App token. */
const defaultSessionLimitHours = 10;
const defaultWindowHours = 8;

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command and returns its result; tests replace it. */
export type Probe = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ProbeResult;

export const spawnProbe: Probe = (command, args, env) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
};

export interface UnattendedReport {
  text: string;
  exitCode: number;
}

function parseWindowHours(args: string[]): number | undefined {
  let hours = defaultWindowHours;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--unattended') continue;
    const value = arg === '--window-hours' ? args[++index] : undefined;
    const number = Number(value);
    if (value === undefined || !(number > 0) || !Number.isFinite(number))
      return undefined;
    hours = number;
  }
  return hours;
}

/** Seconds the process listening on the bw serve port has run (the vault session starts with it), or undefined when none listens. */
export function serveElapsedSeconds(
  probe: Probe,
  env: NodeJS.ProcessEnv,
): number | undefined {
  const port = /:(\d+)\/?$/u.exec(env.KRN_BW_SERVE ?? '')?.[1] ?? '8087';
  const listen = probe('ss', ['-H', '-ltnp', `sport = :${port}`], env);
  const pid = /pid=(\d+)/u.exec(listen.stdout)?.[1];
  if (listen.status !== 0 || !pid) return undefined;
  const age = probe('ps', ['-o', 'etimes=', '-p', pid], env);
  const seconds = Number(age.stdout.trim());
  return age.status === 0 && Number.isInteger(seconds) ? seconds : undefined;
}

/**
 * `krn doctor --unattended [--window-hours N]`: exit 0 only when an App installation token mints
 * and the vault session outlives the window. The token is minted by the token helper and
 * discarded: its output is never read into the report.
 */
export function unattendedReport(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  probe: Probe = spawnProbe,
): UnattendedReport {
  const window = parseWindowHours(args);
  if (window === undefined)
    return {
      text: 'usage: krn doctor --unattended [--window-hours N]  (N a positive number)\n',
      exitCode: exitUsage,
    };
  const sessionEnv = { ...env, KRN_SESSION_CLASS: undefined };
  const mint = probe(process.execPath, [tokenHelper, 'token'], sessionEnv);
  if (mint.status !== 0) {
    const reason = mint.stderr.trim().split('\n')[0] || 'no reason given';
    return {
      text: `FAIL mint: no App token (${reason}). Remedy: run bw-up to unlock the vault and start bw serve, then rerun krn doctor --unattended.\n`,
      exitCode: exitMintFailed,
    };
  }
  const limit = Number(env.KRN_BW_SESSION_HOURS) || defaultSessionLimitHours;
  const elapsed = serveElapsedSeconds(probe, env);
  if (elapsed === undefined)
    return {
      text: 'FAIL vault: no bw serve listening, so the session age is unknown. Remedy: run bw-up, then rerun krn doctor --unattended.\n',
      exitCode: exitVaultShort,
    };
  const remaining = limit - elapsed / 3600;
  const left = remaining.toFixed(1);
  if (remaining < window)
    return {
      text: `FAIL vault: session has ${left}h left, the window needs ${window}h. Remedy: restart bw serve with bw-up for a fresh ${limit}h session, then rerun krn doctor --unattended.\n`,
      exitCode: exitVaultShort,
    };
  return {
    text: `PASS unattended: App token minted, vault session has ${left}h left for a ${window}h window\n`,
    exitCode: 0,
  };
}
