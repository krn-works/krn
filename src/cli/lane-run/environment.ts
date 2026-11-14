import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Operator credentials that never reach a lane session; only the cached App token does, and the sandbox blocks localhost so bw serve is out of reach. */
export const OPERATOR_CREDENTIAL_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GNOME_KEYRING_CONTROL',
] as const;

export const defaultSessionTimeoutMs = 45 * 60 * 1000;

/**
 * An App token lives about an hour and the sandboxed session cannot refresh it, so the
 * launcher mints one with at least this much life left and no session outlasts that.
 */
export const tokenMinimumRemainingSeconds = 50 * 60;

/** The longest a claude session may run: KRN_LANE_TIMEOUT_MS, else 45 minutes; never past the token minimum. */
export function sessionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KRN_LANE_TIMEOUT_MS);
  const wanted =
    Number.isInteger(value) && value > 0 ? value : defaultSessionTimeoutMs;
  return Math.min(wanted, defaultSessionTimeoutMs);
}

export const tokenHelper = fileURLToPath(
  new URL('../../../scripts/github-app-token.ts', import.meta.url),
);
export const fastCheck = fileURLToPath(
  new URL('../../../scripts/fast-check.ts', import.meta.url),
);
export const wrapperDirectory = fileURLToPath(
  new URL('../../../scripts/app-bin', import.meta.url),
);
export const productSandboxSettings = fileURLToPath(
  new URL('../../../.claude/settings.sandbox.json', import.meta.url),
);

/**
 * The lane sandbox settings: the repository's own file when it ships one, else the copy that
 * travels with KRN, so an adopted repository runs lanes without adding the file.
 */
export function laneSandboxSettings(worktree: string): string {
  const own = join(worktree, '.claude', 'settings.sandbox.json');
  return existsSync(own) ? own : productSandboxSettings;
}

/**
 * The session environment: the operator's credentials removed, the `gh` wrapper first on PATH,
 * and git config that empties the inherited github.com credential helpers before installing
 * the App token helper.
 */
export function sessionEnvironment(
  env: NodeJS.ProcessEnv,
  cacheDirectory: string,
  identity: { task?: string; lane: string; repository?: string },
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const name of OPERATOR_CREDENTIAL_VARIABLES) delete scrubbed[name];
  const existing = Number(scrubbed.GIT_CONFIG_COUNT);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...scrubbed,
    KRN_SESSION_CLASS: 'lane',
    // The worker hooks tell a lane from the lead by its task (or, for a goal lane, its slug), never by its name.
    KRN_LANE: identity.lane,
    ...(identity.task === undefined ? {} : { KRN_TASK: identity.task }),
    KRN_APP_CACHE_DIR: scrubbed.KRN_APP_CACHE_DIR || cacheDirectory,
    // The minted token and the git helper serve the lane's own origin, not the product default.
    ...(identity.repository === undefined
      ? {}
      : { KRN_APP_REPOSITORY: identity.repository }),
    PATH: scrubbed.PATH
      ? `${wrapperDirectory}:${scrubbed.PATH}`
      : wrapperDirectory,
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: key,
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: key,
    [`GIT_CONFIG_VALUE_${start + 1}`]: `!'${process.execPath}' '${tokenHelper}' git-credential`,
  };
}

/** The model a session falls back to when its own is overloaded. */
export function fallbackModel(model: string): string {
  return model === 'haiku' ? 'sonnet' : 'haiku';
}

/** The model a lane session runs on unless `--model` says otherwise (operator model policy). */
export const defaultLaneModel = 'sonnet';
