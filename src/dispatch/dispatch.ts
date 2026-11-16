// `krn hook <event>`: one process per event. Reads the payload once, loads only the routes of the table
// whose tool matches, runs them in order with their output captured, merges what they said into one
// hook output and appends one timing line. A refusal (exit 2) ends the event; a route that fails to
// load or run refuses when it is fail-closed and is otherwise skipped.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { provideHookStdin } from '../harness/claude.ts';
import {
  type EventName,
  events,
  legacyRoutes,
  type Route,
  serves,
} from './table.ts';

export interface HookResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RouteTiming {
  name: string;
  ms: number;
  error?: string;
}

const sizeLimit = 512 * 1024;

/** Where timings go: KRN_HOOK_TIMING_LOG, else .krn/runs/hook/timing.jsonl of an existing .krn directory. */
export function timingLogPath(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.KRN_HOOK_TIMING_LOG) return env.KRN_HOOK_TIMING_LOG;
  return existsSync(join(project, '.krn'))
    ? join(project, '.krn', 'runs', 'hook', 'timing.jsonl')
    : undefined;
}

function record(path: string, line: object): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > sizeLimit)
      renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    /* A timing log must never fail a hook. */
  }
}

/** Runs `run` with stdout, stderr and the exit code captured instead of written. */
async function captured(run: () => void | Promise<void>): Promise<HookResult> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
    return {
      stdout: out.join(''),
      stderr: err.join(''),
      code: Number(process.exitCode ?? 0),
    };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.exitCode = exitCode;
  }
}

/** One hook output from the routes' outputs: hookSpecificOutput objects merge, additionalContext joins. */
export function mergeOutputs(outputs: string[]): string {
  const merged: Record<string, unknown> = {};
  let context: string[] = [];
  const raw: string[] = [];
  for (const output of outputs) {
    if (output.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      raw.push(output);
      continue;
    }
    const specific = (
      parsed as { hookSpecificOutput?: Record<string, unknown> }
    ).hookSpecificOutput;
    if (typeof specific !== 'object' || specific === null) {
      raw.push(output);
      continue;
    }
    const { additionalContext, ...rest } = specific;
    if (typeof additionalContext === 'string') context.push(additionalContext);
    merged.hookSpecificOutput = {
      ...(merged.hookSpecificOutput as object | undefined),
      ...rest,
    };
  }
  if (merged.hookSpecificOutput !== undefined) {
    context = context.filter(Boolean);
    if (context.length > 0)
      (merged.hookSpecificOutput as Record<string, unknown>).additionalContext =
        context.join('\n\n');
    raw.unshift(JSON.stringify(merged));
  }
  return raw.join('');
}

/** Runs the routes of `routes` that serve `payload` and returns the merged result. */
export async function runRoutes(
  routes: readonly Route[],
  raw: string,
  args: string[] = [],
): Promise<{ result: HookResult; timings: RouteTiming[] }> {
  let tool: unknown;
  try {
    tool = (JSON.parse(raw) as { tool_name?: unknown } | null)?.tool_name;
  } catch {
    tool = undefined;
  }
  const outputs: string[] = [];
  const errors: string[] = [];
  const timings: RouteTiming[] = [];
  const argv = process.argv;
  provideHookStdin(raw);
  try {
    for (const route of routes) {
      if (!serves(route, tool)) continue;
      const started = performance.now();
      let outcome: HookResult | undefined;
      let failure: string | undefined;
      try {
        const module = await route.load();
        process.argv = [argv[0] ?? 'node', route.name, ...args];
        outcome = await captured(module.main);
      } catch (error) {
        failure = (error as Error).message;
      } finally {
        process.argv = argv;
      }
      const timing: RouteTiming = {
        name: route.name,
        ms: Math.round((performance.now() - started) * 10) / 10,
      };
      if (failure !== undefined) timing.error = failure;
      timings.push(timing);
      if (failure !== undefined) {
        if (route.failClosed === true) {
          errors.push(`krn hook ${route.name} failed: ${failure}`);
          return {
            result: { stdout: '', stderr: `${errors.join('\n')}\n`, code: 2 },
            timings,
          };
        }
        continue;
      }
      if (outcome === undefined) continue;
      if (outcome.stderr) errors.push(outcome.stderr.replace(/\n$/u, ''));
      if (outcome.code !== 0)
        return {
          result: {
            stdout: '',
            stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
            code: outcome.code,
          },
          timings,
        };
      outputs.push(outcome.stdout);
    }
  } finally {
    provideHookStdin(undefined);
  }
  return {
    result: {
      stdout: mergeOutputs(outputs),
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
      code: 0,
    },
    timings,
  };
}

/** The payload on stdin; a mode flag such as `stop --check` has none, and a closed stdin is an empty payload. */
function readPayload(args: string[]): string {
  if (args.length > 0) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function eventNames(): string[] {
  return [...Object.keys(events), ...Object.keys(legacyRoutes)];
}

/**
 * Serves `krn hook <name> [args]` from this process: stdin in, hook output on stdout and stderr, exit code
 * in process.exitCode. Returns false when `name` is neither an event nor an older route name.
 */
export async function runHook(
  name: string | undefined,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const event =
    name !== undefined && name in events ? (name as EventName) : undefined;
  const routes: readonly Route[] | undefined =
    event !== undefined
      ? events[event].routes
      : name !== undefined && name in legacyRoutes
        ? [legacyRoutes[name] as Route]
        : undefined;
  if (name === undefined || routes === undefined) return false;
  const raw = readPayload(args);
  const { result, timings } = await runRoutes(routes, raw, args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
  const cpuUsed = process.cpuUsage(cpuStarted);
  const project = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const path = timingLogPath(project, env);
  if (path !== undefined) {
    let tool: unknown;
    try {
      tool = (JSON.parse(raw) as { tool_name?: unknown } | null)?.tool_name;
    } catch {
      tool = undefined;
    }
    record(path, {
      at: new Date().toISOString(),
      event: name,
      ...(typeof tool === 'string' ? { tool } : {}),
      ms: Math.round((performance.now() - started) * 10) / 10,
      cpu: Math.round((cpuUsed.user + cpuUsed.system) / 100) / 10,
      code: result.code,
      routes: timings,
    });
  }
  return true;
}
