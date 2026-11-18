import { spawnSync } from 'node:child_process';
import {
  APP_NOT_INSTALLED_EXIT,
  AppNotInstalledError,
  isRepositoryNotFound,
  originUrl,
  repoSlug,
} from '../adopt/verify.ts';
import { describeBwServe, vaultStatus } from '../ci/bw-serve-state.ts';
import { skillsMissingPermission } from './doctor-skills.ts';
import { tokenHelper } from './lane-run/environment.ts';

/** The mint failed: no App token, so nothing can ship. */
export const exitMintFailed = 69;
/** The vault session ends inside the window, or no vault session could be read. */
export const exitVaultShort = 75;
export const exitUsage = 64;
/** A repository skill declares allowed-tools or hooks and has no Skill(name) allow entry. */
export const exitSkillPermission = 1;
/** The App token mints but the repository named by --root is not visible to the App. */
export const exitAppNotInstalled = APP_NOT_INSTALLED_EXIT;

const describeUnit = 'bw-serve.service';

function unitRun(probe: Probe, env: NodeJS.ProcessEnv) {
  return (command: string, args: string[]) => probe(command, args, env).stdout;
}

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
    if (arg === '--root') {
      index++;
      continue;
    }
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
      text: 'usage: krn doctor --unattended [--window-hours N] [--root <repo>]  (N a positive number)\n',
      exitCode: exitUsage,
    };
  const rootFlag = args.indexOf('--root');
  const skillRoot =
    (rootFlag < 0 ? undefined : args[rootFlag + 1]) ?? process.cwd();
  const missing = skillsMissingPermission(skillRoot);
  if (missing.length > 0)
    return {
      text: `FAIL skills: ${missing.map((name) => `Skill(${name})`).join(', ')} missing from the project settings permissions.allow; an unattended run stalls on the prompt. Remedy: add each entry to permissions.allow, then rerun krn doctor --unattended.\n`,
      exitCode: exitSkillPermission,
    };
  const sessionEnv = { ...env, KRN_SESSION_CLASS: undefined };
  const mint = probe(process.execPath, [tokenHelper, 'token'], sessionEnv);
  if (mint.status !== 0) {
    const reason = mint.stderr.trim().split('\n')[0] || 'no reason given';
    const why = reason.includes(describeUnit)
      ? ''
      : ` (${describeBwServe(unitRun(probe, sessionEnv))})`;
    return {
      text: `FAIL mint: no App token (${reason})${why}. Remedy: the operator runs bw-up in an interactive shell to unlock the vault and start bw serve, then rerun krn doctor --unattended.\n`,
      exitCode: exitMintFailed,
    };
  }
  const rootIndex = args.indexOf('--root');
  const root = rootIndex < 0 ? undefined : args[rootIndex + 1];
  if (root !== undefined) {
    const slug = repoSlug(originUrl(root));
    if (slug !== undefined) {
      // The default token reaches only the product repository: the root is read with a token
      // scoped to it, as a lane on that repository mints it, or every outside repository is a 404.
      const scoped = probe(process.execPath, [tokenHelper, 'token'], {
        ...sessionEnv,
        KRN_APP_REPOSITORY: slug,
      });
      if (scoped.status !== 0 && /is not installed on/u.test(scoped.stderr))
        return {
          text: `FAIL app: ${new AppNotInstalledError(slug).message}\n`,
          exitCode: exitAppNotInstalled,
        };
      if (scoped.status !== 0)
        return {
          text: `FAIL mint: no App token for ${slug} (${scoped.stderr.trim().split('\n')[0] || 'no reason given'}).\n`,
          exitCode: exitMintFailed,
        };
      // The PATH gh may be the App wrapper, which mints its own token for KRN_APP_REPOSITORY.
      const seen = probe('gh', ['api', `repos/${slug}`, '--silent'], {
        ...sessionEnv,
        KRN_APP_REPOSITORY: slug,
        GH_TOKEN: scoped.stdout.trim(),
      });
      if (isRepositoryNotFound(seen.status, seen.stderr))
        return {
          text: `FAIL app: ${new AppNotInstalledError(slug).message}\n`,
          exitCode: exitAppNotInstalled,
        };
    }
  }
  const base = (env.KRN_BW_SERVE || 'http://localhost:8087').replace(
    /\/+$/u,
    '',
  );
  const status = probe(
    'curl',
    ['-sS', '--max-time', '5', `${base}/status`],
    env,
  );
  const vault = vaultStatus(status.stdout);
  if (vault !== 'unlocked')
    return {
      text: `FAIL vault: bw serve at ${base} reports ${vault ?? 'no status'}, not unlocked, so the App token cannot be minted again (a cached token hides it). ${describeBwServe(unitRun(probe, env))}. Remedy: the operator runs bw-up in an interactive shell, then rerun krn doctor --unattended.\n`,
      exitCode: exitVaultShort,
    };
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
