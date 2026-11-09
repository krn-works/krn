import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `krn state` is the one command Product does not own yet (t-3yss2y9): it runs
// the installed legacy release's implementation, named explicitly, so the PATH
// `krn` can be this CLI. Unknown commands are never forwarded (KRN-06).
export function stateEntry(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KRN_STATE_ENTRY ||
    join(homedir(), '.codex', 'krn', 'current', 'scripts', 'krn.mjs')
  );
}

export function forwardState(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const entry = stateEntry(env);
  if (!existsSync(entry)) {
    process.stderr.write(
      `krn: \`state\` runs the installed legacy release, but ${entry} is missing; set KRN_STATE_ENTRY to its scripts/krn.mjs.\n`,
    );
    return 69;
  }
  const result = spawnSync(process.execPath, [entry, 'state', ...args], {
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    process.stderr.write(`krn: state: ${result.error.message}\n`);
    return 70;
  }
  return result.status ?? 70;
}
