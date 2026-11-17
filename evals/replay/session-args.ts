// The one session command every live replay arm runs: model, fallback, budget, permission mode, denied tools and
// setting sources are the same for A, B and C. The arm owns only its settings file; what differs between arms is the
// checkout (KRN adoption, a static CLAUDE.md or nothing), never the claude arguments.
import { dirname, join } from 'node:path';
import { headlessArgs } from '../../src/harness/claude.ts';
import { shellWords } from '../../src/repo/shell-text.ts';
import type { ArmId } from './arms.ts';
import { DENIED_TOOLS } from './live.ts';

export const SESSION_MODEL = 'sonnet';
export const SESSION_BUDGET_USD = 5;

export interface SessionSpec {
  bin: string;
  prompt: string;
  /** The arm's settings file: the only argument that names the arm. */
  settings: string;
  model?: string;
  budgetUsd?: number;
}

/** The arm's settings file, kept beside the private Claude config; empty, so the checkout's own project settings decide. */
export function settingsPath(arm: ArmId, env: NodeJS.ProcessEnv, wt: string) {
  return join(
    dirname(env.CLAUDE_CONFIG_DIR ?? wt),
    `arm-${arm.toLowerCase()}.json`,
  );
}

/** The words of one session command: `claude` followed by the shared arguments. */
export function sessionArgv(s: SessionSpec): string[] {
  const model = s.model ?? SESSION_MODEL;
  return [
    s.bin,
    ...headlessArgs({
      brief: s.prompt,
      settings: s.settings,
      model,
      fallbackModel: model === 'sonnet' ? 'opus' : 'sonnet',
      budgetUsd: s.budgetUsd ?? SESSION_BUDGET_USD,
      permissionMode: 'bypassPermissions',
    }),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
  ];
}

/** The shell command of one session. */
export const sessionCommand = (s: SessionSpec): string =>
  shellWords(sessionArgv(s));
