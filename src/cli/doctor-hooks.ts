// `krn doctor --hooks`: runs the real hook entry on tool-call payloads and reports the dispatch cost, from
// the dispatcher's entry to its exit, as CPU time: wall time on a host running parallel lanes measures the
// load, not the hook (Node's own start is the host's, not the dispatcher's). Wall time is printed beside it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from '../harness/claude.ts';

/** Tool-call dispatch budget in milliseconds. */
export const budget = { p50: 60, p95: 150 };

const samples = 24;

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ] ?? Number.NaN
  );
}

export interface HookTimes {
  cpu: number[];
  wall: number[];
}

/** Dispatch CPU and wall times of the timing-log lines of tool-call events. */
export function toolCallTimes(log: string): HookTimes {
  const times: HookTimes = { cpu: [], wall: [] };
  for (const line of log.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as {
      event?: string;
      ms?: number;
      cpu?: number;
    };
    if (
      (row.event === 'pre-tool' || row.event === 'post-tool') &&
      typeof row.ms === 'number' &&
      typeof row.cpu === 'number'
    ) {
      times.wall.push(row.ms);
      times.cpu.push(row.cpu);
    }
  }
  return times;
}

export function hooksReport(times: HookTimes): {
  text: string;
  exitCode: number;
} {
  const p50 = percentile(times.cpu, 0.5);
  const p95 = percentile(times.cpu, 0.95);
  const within = p50 <= budget.p50 && p95 <= budget.p95;
  return {
    text: `hooks: tool-call p50 ${p50.toFixed(0)} ms (<= ${budget.p50}), p95 ${p95.toFixed(0)} ms (<= ${budget.p95}) dispatch cpu; wall p50 ${percentile(times.wall, 0.5).toFixed(0)} ms, p95 ${percentile(times.wall, 0.95).toFixed(0)} ms; ${times.cpu.length} runs ${within ? 'PASS' : 'FAIL'}\n`,
    exitCode: within ? 0 : 1,
  };
}

/** The events of the settings file's hooks whose command runs the dispatcher entry of `route`. */
export function wiredEvents(settings: string, route: string): string[] {
  const hooks = (
    JSON.parse(settings) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
    }
  ).hooks;
  return Object.entries(hooks ?? {})
    .filter(([, groups]) =>
      groups.some((group) =>
        group.hooks?.some((hook) =>
          new RegExp(`main\\.ts"? ${route}$`, 'u').test(
            hook.command?.trimEnd() ?? '',
          ),
        ),
      ),
    )
    .map(([event]) => event);
}

/** One line naming whether PostModelSwitch runs the model-switch route in the project's settings. */
export function modelSwitchReport(productRoot: string): {
  text: string;
  exitCode: number;
} {
  let wired: string[] = [];
  try {
    wired = wiredEvents(
      readFileSync(projectPath(productRoot, 'settings.json'), 'utf8'),
      'model-switch',
    );
  } catch {
    /* An unreadable settings file is reported as not wired. */
  }
  const ok = wired.includes('PostModelSwitch');
  return {
    text: `hooks: PostModelSwitch ${ok ? 'wired' : 'NOT wired'} (model-switch log)\n`,
    exitCode: ok ? 0 : 1,
  };
}

/** Runs the entry on Bash tool calls (the event with the most routes), pre and post, and reports. */
export function measureHooks(productRoot: string): {
  text: string;
  exitCode: number;
} {
  const work = mkdtempSync(join(productRoot, '.krn', 'tmp-doctor-hooks-'));
  const log = join(work, 'timing.jsonl');
  const cache = join(productRoot, '.krn', 'cache', 'node');
  mkdirSync(cache, { recursive: true });
  try {
    for (let run = 0; run <= samples; run++) {
      const event = run % 2 === 0 ? 'pre-tool' : 'post-tool';
      const spawned = spawnSync(
        process.execPath,
        [join(productRoot, 'src', 'dispatch', 'main.ts'), event],
        {
          cwd: productRoot,
          input: JSON.stringify({
            session_id: 'doctor-hooks',
            transcript_path: join(work, 'transcript.jsonl'),
            hook_event_name:
              event === 'pre-tool' ? 'PreToolUse' : 'PostToolUse',
            cwd: productRoot,
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
          }),
          encoding: 'utf8',
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: productRoot,
            KRN_HOOK_TIMING_LOG: run === 0 ? join(work, 'warmup.jsonl') : log,
            NODE_COMPILE_CACHE: cache,
          },
        },
      );
      if (spawned.status !== 0)
        return {
          text: `hooks: ${event} exited ${spawned.status}: ${spawned.stderr.trim()}\n`,
          exitCode: 1,
        };
    }
    const timing = hooksReport(toolCallTimes(readFileSync(log, 'utf8')));
    const wired = modelSwitchReport(productRoot);
    return {
      text: timing.text + wired.text,
      exitCode: timing.exitCode || wired.exitCode,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
