import { run } from '../../src/successor/handoff-requests.ts';

// Thin entry: argv in, the verdict and exit code out.
process.exitCode = run(process.argv.slice(2), process.cwd(), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
