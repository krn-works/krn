import { readFileSync } from 'node:fs';
import { run } from '../../src/successor/operator-inbox.ts';

// Thin entry: argv and stdin in, the command's output and exit code out.
process.exitCode = await run(
  process.argv.slice(2),
  process.cwd(),
  process.env,
  {
    stdin: () => readFileSync(0, 'utf8'),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
);
