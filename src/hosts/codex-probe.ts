// Asks a Codex app-server for its version and config validity without
// starting it. Evidence: test/fixtures/codex-app-server-startup/.
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { workerEnvironment } from './codex.ts';

const startupConfigSchema = z.object({ appServerVersion: z.string().max(64) });
const failureSchema = z.object({
  error: z.object({ message: z.string() }),
});

/**
 * Runs `codex app-server --print-startup-config` with the worker's approval
 * and sandbox overrides and returns the app-server version or why it refused.
 * Codex 0.167.0 answers in tens of milliseconds and writes no file.
 */
export function probeCodexAppServer(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv = workerEnvironment(),
): { readonly version: string } | { readonly error: string } {
  const probe = spawnSync(
    executable,
    [
      'app-server',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="workspace-write"',
      '--print-startup-config',
    ],
    { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 },
  );
  if (probe.error) return { error: probe.error.message };
  const json = (() => {
    try {
      return JSON.parse(probe.stdout) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (probe.status === 0) {
    const parsed = startupConfigSchema.safeParse(json);
    if (parsed.success) return { version: parsed.data.appServerVersion };
  }
  const failure = failureSchema.safeParse(json);
  const detail = failure.success
    ? failure.data.error.message
    : (probe.stderr || probe.stdout).trim();
  return {
    error: `exit ${probe.status ?? probe.signal}: ${detail.replaceAll('\n', ' ').trim().slice(0, 2000)}`,
  };
}
