// The one session command every live replay arm runs: model, fallback, budget, permission mode, denied tools and
// setting sources are the same for A, B and C; a Codex model (src/harness/codex.ts) runs the same brief on `codex exec`. The arm owns only its settings file; what differs between arms is the
// checkout (KRN adoption, a static CLAUDE.md or nothing), never the claude arguments.
import { dirname, join } from 'node:path';
import { headlessArgs } from '../../src/harness/claude.ts';
import {
  codexAgent,
  codexExecArgs,
  codexResumeArgs,
  isCodexModel,
} from '../../src/harness/codex.ts';
import { shellWords } from '../../src/repo/shell-text.ts';
import type { ArmId } from './arms.ts';
import { DENIED_TOOLS } from './live.ts';

export const SESSION_MODEL = 'sonnet';
/** The per-attempt dollar cap every arm meets: Claude through `--max-budget-usd`, Codex through the driver's poll. */
export const SESSION_BUDGET_USD = 5;
/** The per-attempt wall-time cap every arm meets, the gate's re-prompt included. */
export const SESSION_MS = 30 * 60_000;

export interface SessionSpec {
  bin: string;
  prompt: string;
  /** The arm's settings file: the only argument that names the arm. */
  settings: string;
  model?: string;
  budgetUsd?: number;
  /** The session a re-prompt resumes: Claude's session_id or Codex's thread_id. */
  resume?: string;
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
 * the same brief and web search off in place of the denied tools. Every arm streams its full event log (Claude
 * stream-json) and runs without a fallback model: escalation is a separate attempt, never part of the measured one.
 * With `resume` the command continues that session with `prompt` as the next user turn.
 */
export function sessionArgv(s: SessionSpec): string[] {
  const model = s.model ?? SESSION_MODEL;
  if (isCodexModel(model))
    return [
      s.bin,
      ...(s.resume === undefined
        ? codexExecArgs({ brief: s.prompt, model })
        : codexResumeArgs({ brief: s.prompt, model, id: s.resume })),
    ];
  const shared = headlessArgs({
    brief: s.prompt,
    settings: s.settings,
    model,
    fallbackModel: model,
    budgetUsd: s.budgetUsd ?? SESSION_BUDGET_USD,
    permissionMode: 'bypassPermissions',
  });
  const words: string[] = [];
  for (let i = 0; i < shared.length; i++) {
    const w = shared[i] as string;
    if (w === '--fallback-model') {
      i++;
      continue;
    }
    if (w === '--output-format') {
      words.push(w, 'stream-json', '--verbose');
      i++;
      continue;
    }
    words.push(w);
  }
  return [
    s.bin,
    ...words,
    ...(s.resume === undefined ? [] : ['--resume', s.resume]),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
  ];
}

/** The shell command of one session. */
export const sessionCommand = (s: SessionSpec): string =>
  shellWords(sessionArgv(s));
