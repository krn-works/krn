// The one session command every live replay arm runs: model, fallback, budget, permission mode, denied tools and
// setting sources are the same for A, B and C; a Codex model (src/harness/codex.ts) runs the same brief on `codex exec`. The arm owns only its settings file; what differs between arms is the
// checkout (KRN adoption, a static CLAUDE.md or nothing), never the claude arguments.
import { dirname, join } from 'node:path';
import { headlessArgs } from '../../src/harness/claude.ts';
import {
  codexAgent,
  codexExecArgs,
  isCodexModel,
} from '../../src/harness/codex.ts';
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

/** The binary of a session on `model`: `codex` (`KRN_EVAL_CODEX`) for a Codex model, else `claude` (`KRN_EVAL_CLAUDE`). */
export function sessionBinary(
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return isCodexModel(model ?? SESSION_MODEL)
    ? (env.KRN_EVAL_CODEX ?? codexAgent)
    : (env.KRN_EVAL_CLAUDE ?? 'claude');
}

/**
 * The words of one session command: `claude` followed by the shared arguments, or for a Codex model `codex exec` with
 * the same brief, web search off in place of the denied tools, and no fallback (escalation is a separate attempt).
 */
export function sessionArgv(s: SessionSpec): string[] {
  const model = s.model ?? SESSION_MODEL;
  if (isCodexModel(model))
    return [s.bin, ...codexExecArgs({ brief: s.prompt, model })];
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
