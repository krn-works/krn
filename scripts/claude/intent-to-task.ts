import { run } from '../../src/successor/intent-to-task.ts';

// Thin entry: argv in, the measurement and exit code out.
process.exitCode = run(process.argv.slice(2), process.cwd(), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
