// PostModelSwitch hook (`krn hook model-switch`): a session that moves to another model (a safety-classifier
// fallback stays on the weaker model) appends one line, `<time> <from> -> <to>`, to the lane's run log
// .krn/runs/<lane>/model-switches.log, so an unattended lane never finishes on a weaker model unnoticed.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hookInput, hookStdin } from '../harness/claude.ts';

function modelOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' && /^[\w.[\]:/-]+$/u.test(value)
    ? value
    : 'unknown';
}

/** The run log of the lane that owns the session: KRN_LANE, else the session id. */
export function modelSwitchLog(
  project: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const owner = /^[\w.-]+$/u.test(env.KRN_LANE ?? '')
    ? (env.KRN_LANE as string)
    : sessionId;
  return join(project, '.krn', 'runs', owner, 'model-switches.log');
}

/** Appends the switch of `raw` to the lane run log and returns the line written. */
export function recordModelSwitch(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string {
  const input = hookInput(['PostModelSwitch'], raw, env);
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const line = `${now.toISOString()} ${modelOf(payload, 'from_model')} -> ${modelOf(payload, 'to_model')}\n`;
  const log = modelSwitchLog(input.project, input.sessionId, env);
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, line);
  return line;
}

export function main(): void {
  try {
    recordModelSwitch(hookStdin());
  } catch {
    /* A logging failure never interrupts a session. */
  }
}
