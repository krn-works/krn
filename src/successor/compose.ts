// Launch composition.
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_CLASS_VARIABLE } from '../memory/operator-inbox-store.ts';
import type { SuccessorLaunchOptions } from './options.ts';

// Launch composition: the App credential environment, the harness in use, the launcher prompt,
// the agent flags and the `herdr tab create` arguments.

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const TOKEN_HELPER = join(REPOSITORY_ROOT, 'scripts', 'github-app-token.ts');
const WRAPPER_DIRECTORY = join(REPOSITORY_ROOT, 'scripts', 'app-bin');
// A sandboxed session cannot see /run/user, so the minted token's cache lives
// in an ignored repository directory the sandbox can read.
export const APP_CACHE_DIRECTORY = join(
  REPOSITORY_ROOT,
  '.krn',
  'tmp',
  'app-cache',
);
export const EXIT_UNAVAILABLE = 69;

/**
 * The environment that gives a launched session the App credential: the `gh`
 * wrapper first on PATH, and git config that first empties the inherited
 * github.com credential helpers, then installs the token helper.
 */
export function appCredentialEnvironment(
  env: NodeJS.ProcessEnv,
  helper = TOKEN_HELPER,
  wrapperDirectory = WRAPPER_DIRECTORY,
  cacheDirectory = APP_CACHE_DIRECTORY,
): Record<string, string> {
  const existing = Number(env.GIT_CONFIG_COUNT);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const key = 'credential.https://github.com.helper';
  const forwarded: Record<string, string> = {};
  for (const name of ['KRN_BW_SERVE', 'KRN_APP_ITEM', 'KRN_GITHUB_API']) {
    const value = env[name];
    if (value) forwarded[name] = value;
  }
  // The launched pane does not inherit this process's environment, so the
  // entries below `start` travel with the count that counts them.
  for (let index = 0; index < start; index += 1) {
    for (const name of [
      `GIT_CONFIG_KEY_${index}`,
      `GIT_CONFIG_VALUE_${index}`,
    ]) {
      const value = env[name];
      if (value !== undefined) forwarded[name] = value;
    }
  }
  forwarded.KRN_APP_CACHE_DIR = env.KRN_APP_CACHE_DIR || cacheDirectory;
  return {
    ...forwarded,
    PATH: env.PATH ? `${wrapperDirectory}:${env.PATH}` : wrapperDirectory,
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: key,
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: key,
    [`GIT_CONFIG_VALUE_${start + 1}`]: `!'${process.execPath}' '${helper}' git-credential`,
  };
}

// One mint proves the credential before a session depends on it; the token
// itself is discarded here.
export function checkAppCredential(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(process.execPath, [TOKEN_HELPER, 'token'], {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  if (result.status === 0) return undefined;
  return (
    result.stderr?.trim().split('\n')[0] ||
    result.error?.message ||
    `token helper exited with status ${result.status}`
  );
}

export type Harness = 'claude' | 'codex' | 'other';

/**
 * The harness the lead is running in, read from the runtime environment.
 * KRN_SUCCESSOR_AGENT is an explicit operator override; otherwise the
 * variables each harness exports to its child processes decide. An unknown
 * or ambiguous environment returns an error instead of a guess.
 */
export function detectHarness(
  env: NodeJS.ProcessEnv,
): { agent: string; harness: Harness } | { error: string } {
  const override = env.KRN_SUCCESSOR_AGENT;
  if (override)
    return {
      agent: override,
      harness:
        basename(override) === 'codex'
          ? 'codex'
          : basename(override) === 'claude'
            ? 'claude'
            : 'other',
    };
  const codex = Boolean(
    env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI,
  );
  const claude = env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_SESSION_ID);
  if (codex && claude)
    return {
      error:
        'ambiguous harness: both Codex and Claude Code markers are set; set KRN_SUCCESSOR_AGENT',
    };
  if (codex) return { agent: 'codex', harness: 'codex' };
  if (claude) return { agent: 'claude', harness: 'claude' };
  return {
    error:
      'unknown harness: no Codex or Claude Code marker in the environment; set KRN_SUCCESSOR_AGENT',
  };
}

// Operator 2026-11-06 (t-5av8etp): a relayed Claude lead never stops on permission prompts; other
// agents keep their own defaults. Operator 2026-11-01 (t-h7xt8m3): krn-handoff passes the
// successor's model and effort; only Claude takes these flags.
export function agentFlags(
  harness: Harness,
  options: SuccessorLaunchOptions,
): string[] {
  return harness === 'claude'
    ? [
        '--permission-mode',
        'bypassPermissions',
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['--effort', options.effort] : []),
      ]
    : [];
}

// The first words every successor reads: retire the predecessor panes, then the caller's prompt.
export function launcherPrompt(options: SuccessorLaunchOptions): string {
  return `First run \`node scripts/claude/successor-launch.ts --retire\` from the repository root. ${options.prompt}`;
}

// `herdr pane run` types its words into the pane's shell, so the agent, name and prompt travel as
// tab environment and the shell expands them.
export function tabCreateArgs(input: {
  options: SuccessorLaunchOptions;
  agent: string;
  prompt: string;
  workspaceId: string | undefined;
  appCredential: Record<string, string> | undefined;
  predecessor: { paneId: string; sessionId: string } | undefined;
}): string[] {
  const { options, agent, prompt, workspaceId, appCredential, predecessor } =
    input;
  const createArgs = ['tab', 'create'];
  if (workspaceId) createArgs.push('--workspace', workspaceId);
  createArgs.push(
    '--cwd',
    options.cwd,
    '--label',
    options.name,
    '--env',
    `KRN_SUCCESSOR_AGENT=${agent}`,
    '--env',
    `KRN_SUCCESSOR_NAME=${options.name}`,
    '--env',
    `KRN_SUCCESSOR_PROMPT=${prompt}`,
    '--env',
    `${SESSION_CLASS_VARIABLE}=${options.sessionClass}`,
  );
  for (const [name, value] of Object.entries(appCredential ?? {}))
    createArgs.push('--env', `${name}=${value}`);
  if (predecessor)
    createArgs.push(
      '--env',
      `KRN_PREDECESSOR_PANE=${predecessor.paneId}`,
      '--env',
      `KRN_PREDECESSOR_SESSION=${predecessor.sessionId}`,
    );
  createArgs.push('--no-focus');
  return createArgs;
}
