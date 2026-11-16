// The process entry of every hook event: `node src/dispatch/main.ts <event> [args]`, the same dispatcher as `krn hook`.
import { eventNames, runHook } from './dispatch.ts';

const [name, ...args] = process.argv.slice(2);
if (!(await runHook(name, args))) {
  process.stderr.write(`krn hook <${eventNames().join('|')}> [args]\n`);
  process.exitCode = 64;
}
