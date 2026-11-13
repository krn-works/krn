// `krn hook <name>`: the Claude Code hook entries `krn adopt` installs; each runs the product's own script.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CliUsageError } from './usage-error.ts';

const scripts: Readonly<Record<string, string>> = {
  stop: 'scripts/claude/worker-stop.ts',
};

/** Runs the hook script with this process's stdin, environment and exit status. */
export function hookCommand(args: string[], productRoot: string): void {
  const [name, ...rest] = args;
  const script = name === undefined ? undefined : scripts[name];
  if (script === undefined || rest.length > 0)
    throw new CliUsageError(
      `krn hook <${Object.keys(scripts).join('|')}>  run a Claude Code hook`,
    );
  const run = spawnSync(process.execPath, [join(productRoot, script)], {
    stdio: 'inherit',
  });
  process.exitCode = run.status ?? 2;
}
