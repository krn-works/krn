// Launcher options.
import { resolve } from 'node:path';
import {
  isSessionClass,
  SESSION_CLASSES,
  type SessionClass,
} from '../memory/operator-inbox-store.ts';

// The launcher's command line: option shape, effort levels and the argument parser.

export interface SuccessorLaunchOptions {
  name: string;
  prompt: string;
  cwd: string;
  sessionClass: SessionClass;
  model?: string;
  effort?: Effort;
  startSeconds?: number;
  // True keeps the operator's own credential; false (default) gives the
  // session the GitHub App credential.
  operatorToken: boolean;
  // True: no operator is watching; the launch runs `krn doctor --unattended` first and refuses on failure.
  unattended: boolean;
}

// The operator capped every KRN session: medium by default, high when medium is
// not enough, xhigh at most; max is refused.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

// A bounded wait in whole seconds, shared by the launch and retire modes.
export function waitSeconds(value: string | undefined): number | undefined {
  return value !== undefined &&
    /^(0|[1-9]\d*)$/u.test(value) &&
    Number(value) <= 600
    ? Number(value)
    : undefined;
}

export function parseArgs(
  args: string[],
  defaultCwd = process.cwd(),
): SuccessorLaunchOptions {
  let name: string | undefined;
  let prompt: string | undefined;
  let cwd = defaultCwd;
  let model: string | undefined;
  let effort: Effort | undefined;
  let startSeconds: number | undefined;
  let sessionClass: SessionClass = 'delivery';
  const seen = new Set<string>();
  const flags = new Set([
    '--name',
    '--prompt',
    '--cwd',
    '--model',
    '--effort',
    '--start-seconds',
    '--class',
  ]);
  const switches = new Set(['--operator-token', '--unattended']);
  let operatorToken = false;
  let unattended = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (switches.has(flag)) {
      if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
      seen.add(flag);
      if (flag === '--unattended') unattended = true;
      else operatorToken = true;
      continue;
    }
    if (!flags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);

    // A value may start with `--`; only a known flag marks a missing value.
    const value = args[index + 1];
    if (value === undefined || value === '' || flags.has(value))
      throw new Error(`expected a value after ${flag}`);
    index += 1;

    if (flag === '--name') name = value;
    else if (flag === '--prompt') prompt = value;
    else if (flag === '--model') model = value;
    else if (flag === '--class') {
      // `lane` belongs to `krn lane run`, not to a successor launch.
      const choices = SESSION_CLASSES.filter((name) => name !== 'lane');
      if (!isSessionClass(value) || value === 'lane')
        throw new Error(`--class must be one of ${choices.join(', ')}`);
      sessionClass = value;
    } else if (flag === '--effort') {
      if (value === 'max')
        throw new Error(
          '--effort max is refused: KRN sessions run at medium, high when medium is not enough, xhigh at most',
        );
      if (!isEffort(value))
        throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
      effort = value;
    } else if (flag === '--start-seconds') {
      startSeconds = waitSeconds(value);
      if (startSeconds === undefined)
        throw new Error('--start-seconds must be a whole number from 0 to 600');
    } else cwd = resolve(defaultCwd, value);
  }

  if (!name) throw new Error('required argument missing: --name');
  if (!prompt) throw new Error('required argument missing: --prompt');
  // The SessionStart hook injects the handoff; a prompt that names it makes the
  // successor read it again (t-qdzy8w7: 81% of sessions re-read it).
  if (/handoff\.md|\bread\b[^.]*\bhandoff\b/iu.test(prompt))
    throw new Error(
      '--prompt must not tell the successor to read the handoff: the SessionStart hook injects it; say "run its Verify command" instead',
    );
  return {
    name,
    prompt,
    cwd,
    sessionClass,
    operatorToken,
    unattended,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(startSeconds === undefined ? {} : { startSeconds }),
  };
}

// How long a launch waits for Herdr to show the successor's agent; a cold Claude start on a loaded host takes seconds.
export const START_SECONDS = 60;
