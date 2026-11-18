// Launch composition.
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAgent, isClaudeSession, relayFlags } from '../harness/claude.ts';
import { SESSION_CLASS_VARIABLE } from '../memory/operator-inbox-store.ts';
import { appHelperGitConfig } from '../repo/git-config-env.ts';
import type { SuccessorLaunchOptions } from './options.ts';

// Launch composition: the App credential environment, the harness in use, the launcher prompt,
// the agent flags and the tab environment.

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
  const forwarded: Record<string, string> = {};
  for (const name of ['KRN_BW_SERVE', 'KRN_APP_ITEM', 'KRN_GITHUB_API']) {
    const value = env[name];
    if (value) forwarded[name] = value;
  }
  forwarded.KRN_APP_CACHE_DIR = env.KRN_APP_CACHE_DIR || cacheDirectory;
  return {
    ...forwarded,
    PATH: env.PATH ? `${wrapperDirectory}:${env.PATH}` : wrapperDirectory,
    // The launched pane does not inherit this process's environment, so the
    // unrelated inherited entries travel with the count that counts them.
    ...appHelperGitConfig(
      env,
      `!'${process.execPath}' '${helper}' git-credential`,
    ),
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

export type Harness = typeof claudeAgent | 'codex' | 'other';

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
          : basename(override) === claudeAgent
            ? claudeAgent
            : 'other',
    };
  const codex = Boolean(
    env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI,
  );
  const claude = isClaudeSession(env);
  if (codex && claude)
    return {
      error:
        'ambiguous harness: both Codex and Claude Code markers are set; set KRN_SUCCESSOR_AGENT',
    };
  if (codex) return { agent: 'codex', harness: 'codex' };
  if (claude) return { agent: claudeAgent, harness: claudeAgent };
  return {
    error:
      'unknown harness: no Codex or Claude Code marker in the environment; set KRN_SUCCESSOR_AGENT',
  };
}

// Operator 2026-11-06 (t-5av8etp): a relayed Claude lead never stops on permission prompts; other
// agents keep their own defaults. Operator 2026-11-01 (t-h7xt8m3): delivery-handoff passes the
// successor's model and effort; only Claude takes these flags.
export function agentFlags(
  harness: Harness,
  options: SuccessorLaunchOptions,
): string[] {
  return harness === claudeAgent ? relayFlags(options) : [];
}

// The first words every successor reads: retire the predecessor panes, then the caller's prompt.
export const LAUNCHER_PREFIX =
  'First run `node scripts/claude/successor-launch.ts --retire` from the repository root.';

// A prompt that already starts with the prefix (a relayed handoff quotes it) keeps one copy.
export function launcherPrompt(options: SuccessorLaunchOptions): string {
  const prompt = options.prompt.trimStart();
  return prompt.startsWith(LAUNCHER_PREFIX)
    ? prompt
    : `${LAUNCHER_PREFIX} ${options.prompt}`;
}

// A pane types its words into the shell, so the agent, name and prompt travel as tab environment
// and the shell expands them.
export function tabEnvironment(input: {
  options: SuccessorLaunchOptions;
  agent: string;
  prompt: string;
  appCredential: Record<string, string> | undefined;
  predecessor: { paneId: string; sessionId: string } | undefined;
}): Record<string, string> {
  const { options, agent, prompt, appCredential, predecessor } = input;
  return {
    KRN_SUCCESSOR_AGENT: agent,
    KRN_SUCCESSOR_NAME: options.name,
    KRN_SUCCESSOR_PROMPT: prompt,
    [SESSION_CLASS_VARIABLE]: options.sessionClass,
    ...appCredential,
    ...(predecessor
      ? {
          KRN_PREDECESSOR_PANE: predecessor.paneId,
          KRN_PREDECESSOR_SESSION: predecessor.sessionId,
        }
      : {}),
  };
}
