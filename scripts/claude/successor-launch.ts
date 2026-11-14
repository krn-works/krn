import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/successor/launch.ts';

// Usage: node scripts/claude/successor-launch.ts --name <label> --prompt <text>
//   [--cwd <dir>] [--class <session class>] [--model <id>] [--effort <level>]
//   [--start-seconds 0-600] [--operator-token]
// `--retire` closes the predecessor panes instead. The logic lives in src/successor; prove a change
// against the live Herdr with `node scripts/claude/successor-probe.ts`.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
