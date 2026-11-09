import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { gateAdmissionPolicyFromBase } from '../deliver/admission-policy.ts';
import {
  GateStopped,
  GateTimeout,
  type Pull,
  pullSchema,
  waitForGate,
} from '../deliver/gate-wait.ts';
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
/** Exit code when the merged PR's pinned Product refresh failed its smoke. */
export const releaseRefreshExit = 78;
class ReleaseRefreshFailed extends Error {}
const releaseScript = fileURLToPath(
  new URL('../../scripts/product-release.sh', import.meta.url),
);
export const waitUsage =
  'Usage: krn ci wait --repo <owner/repo> --pr <n> --head <sha> --base <sha> [--timeout-seconds <n>] [--start-timeout-seconds <n>] [--merge-timeout-seconds <n>]; with auto-merge on, waits for the merge, refreshes the pinned Product entry and ends with one `verdict:` line (merged <sha>, closed unmerged, open: blocked, or not merging); exits 0 success, 64 usage, 74 failed gate, 75 timeout, 76 conflict, 77 head moved, 78 refresh failed (previous commit kept), 69 never started';

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
    mergeTimeoutMs: number;
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
        'merge-timeout-seconds': { type: 'string' },
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
        mergeTimeoutMs: z.number().positive().finite(),
      })
      .parse({
        ...values,
        timeoutMs: Number(values['timeout-seconds'] ?? 1800) * 1000,
        startTimeoutMs: Number(values['start-timeout-seconds'] ?? 300) * 1000,
        mergeTimeoutMs: Number(values['merge-timeout-seconds'] ?? 600) * 1000,
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
    const gh = runtime.gh ?? ((args) => github(args, cwd, runner, wait));
    const now = runtime.now ?? Date.now;
    let last: Pull | undefined;
    await waitForGate({
      ...options,
      policy,
      gh,
      sleep: wait,
      now,
      pollMs: 10000,
      onPull: (pull) => {
        last = pull;
      },
    });
    const lines = [`gate: success ${options.head}`];
    if (last?.merged === true || (last?.auto_merge ?? null) !== null)
      lines.push(
        ...(await refreshAfterMerge({
          ...options,
          gh,
          sleep: wait,
          now,
          refresh: () => runner('bash', [releaseScript], cwd),
        })),
      );
    else
      lines.push(
        `verdict: not merging: auto-merge is not enabled on PR #${options.pr} (mergeable_state ${last?.mergeable_state ?? 'unknown'}); run gh pr merge ${options.pr} --auto --squash`,
      );
    return lines.join('\n');
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        exitCode:
          error instanceof ReleaseRefreshFailed
            ? releaseRefreshExit
            : error instanceof GateStopped
              ? stopExitCodes[error.reason]
              : error instanceof GateTimeout
                ? 75
                : 74,
      },
    );
  }
}

/**
 * Waits for an auto-merging PR to merge, then refreshes the pinned Product
 * entry, so `krn task` stays fresh without a manual step after each merge.
 */
async function refreshAfterMerge(options: {
  repo: string;
  pr: number;
  mergeTimeoutMs: number;
  gh: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  refresh: () => { code: number; stdout: string; stderr: string };
}): Promise<string[]> {
  const deadline = options.now() + options.mergeTimeoutMs;
  for (;;) {
    const pull = pullSchema.parse(
      JSON.parse(
        await options.gh(['api', `repos/${options.repo}/pulls/${options.pr}`]),
      ),
    );
    if (pull.merged === true) {
      const result = options.refresh();
      if (result.code !== 0)
        throw new ReleaseRefreshFailed(
          `merged: ${pull.merge_commit_sha ?? 'unknown'}\nrelease: refresh failed (exit ${result.code})\n${result.stderr.trim()}`,
        );
      return [
        `merged: ${pull.merge_commit_sha ?? 'unknown'}`,
        ...result.stdout
          .trim()
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => `release: ${line}`),
        `verdict: merged ${pull.merge_commit_sha ?? 'unknown'}`,
      ];
    }
    if (pull.state === 'closed')
      return [
        'merge: PR closed without merging',
        `verdict: closed unmerged PR #${options.pr}`,
      ];
    if (options.now() >= deadline)
      return [
        `merge: not observed within ${Math.floor(options.mergeTimeoutMs / 1000)}s; after it merges run scripts/product-release.sh`,
        `verdict: open: auto-merge enabled but PR #${options.pr} is ${pull.mergeable_state} (review or another required rule blocks it)`,
      ];
    await options.sleep(10000);
  }
}
