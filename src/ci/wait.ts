import { parseArgs } from 'node:util';
import { z } from 'zod';
import { gateAdmissionPolicyFromBase } from '../deliver/admission-policy.ts';
import { GateStopped, GateTimeout, waitForGate } from '../deliver/gate-wait.ts';
import {
  checked,
  github,
  type Runner,
  run,
  sleep,
} from '../deliver/transport.ts';

/** Exit codes for a wait that stopped before its gate concluded. */
export const stopExitCodes = {
  conflict: 76,
  'head-moved': 77,
  'never-started': 69,
} as const;
export const waitUsage =
  'Usage: krn ci wait --repo <owner/repo> --pr <n> --head <sha> --base <sha> [--timeout-seconds <n>] [--start-timeout-seconds <n>]; exits 0 success, 64 usage, 74 failed gate, 75 timeout, 76 conflict, 77 head moved, 69 never started';

export async function waitCommand(
  args: string[],
  runtime: {
    cwd?: string;
    run?: Runner;
    gh?: (args: string[]) => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<string> {
  let options: {
    repo: string;
    pr: number;
    head: string;
    base: string;
    timeoutMs: number;
    startTimeoutMs: number;
  };
  try {
    const flags = args.filter((_, index) => index % 2 === 0);
    if (new Set(flags).size !== flags.length)
      throw new Error('repeated option');
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        'timeout-seconds': { type: 'string' },
        'start-timeout-seconds': { type: 'string' },
      },
    });
    const sha = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
    options = z
      .object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
        pr: z.coerce.number().int().positive().safe(),
        head: sha,
        base: sha,
        timeoutMs: z.number().positive().finite(),
        startTimeoutMs: z.number().positive().finite(),
      })
      .parse({
        ...values,
        timeoutMs: Number(values['timeout-seconds'] ?? 1800) * 1000,
        startTimeoutMs: Number(values['start-timeout-seconds'] ?? 300) * 1000,
      });
  } catch {
    throw Object.assign(new Error(waitUsage), { exitCode: 64 });
  }
  try {
    const cwd = runtime.cwd ?? process.cwd();
    const runner = runtime.run ?? run;
    const wait = runtime.sleep ?? sleep;
    const policy = gateAdmissionPolicyFromBase(options.base, (args) =>
      checked(runner('git', args, cwd)),
    );
    await waitForGate({
      ...options,
      policy,
      gh: runtime.gh ?? ((args) => github(args, cwd, runner, wait)),
      sleep: wait,
      now: runtime.now ?? Date.now,
      pollMs: 10000,
    });
    return `gate: success ${options.head}`;
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        exitCode:
          error instanceof GateStopped
            ? stopExitCodes[error.reason]
            : error instanceof GateTimeout
              ? 75
              : 74,
      },
    );
  }
}
