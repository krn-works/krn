// `krn hook <event> [args]`: the Claude Code hook entries. Each event runs its routes in this process
// (src/dispatch/dispatch.ts, table in src/dispatch/table.ts); `krn hook stop --check|--related` forwards the flag to the Stop gate.
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { eventNames, runHook } from '../dispatch/dispatch.ts';

export async function hookCommand(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!(await runHook(name, rest)))
    throw new CliUsageError(
      `krn hook <${eventNames().join('|')}> [args]  run a Claude Code hook`,
    );
}
