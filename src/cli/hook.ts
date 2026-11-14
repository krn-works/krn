// `krn hook <name> [args]`: the Claude Code hook entries `krn adopt` installs; each runs the product's own
// hook module under src/hook/ with the remaining arguments (`krn hook stop --check|--related`).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CliUsageError } from './usage-error.ts';

const scripts: Readonly<Record<string, string>> = {
  stop: 'src/hook/stop.ts',
  scope: 'src/hook/scope.ts',
  stash: 'src/hook/stash.ts',
};

/** Runs the hook script with this process's stdin, environment and exit status. */
export function hookCommand(args: string[], productRoot: string): void {
  const [name, ...rest] = args;
  const script = name === undefined ? undefined : scripts[name];
  if (script === undefined)
    throw new CliUsageError(
      `krn hook <${Object.keys(scripts).join('|')}> [args]  run a Claude Code hook`,
    );
  const run = spawnSync(
    process.execPath,
    [join(productRoot, script), ...rest],
    {
      stdio: 'inherit',
    },
  );
  process.exitCode = run.status ?? 2;
}
