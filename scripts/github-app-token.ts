import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT_UNAVAILABLE, main, Unavailable } from '../src/ci/app-token.ts';

// Mints a GitHub App installation token (logic: src/ci/app-token.ts); this file wires argv, stdin and exit codes.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      process.env,
      () => {
        try {
          return readFileSync(0, 'utf8');
        } catch {
          return '';
        }
      },
      (text) => process.stdout.write(text),
    );
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    process.stderr.write(`github-app-token: ${error.message}\n`);
    process.exitCode = EXIT_UNAVAILABLE;
  }
}
