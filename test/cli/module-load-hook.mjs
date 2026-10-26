import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const logPath = process.env.KRN_MODULE_LOAD_LOG;
const watchedDirectories = [
  'evals',
  'flow',
  'foreman',
  'hosts',
  'ledger',
  'relay',
  'task',
  'trace',
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (logPath && result.url.startsWith('file:')) {
      const path = fileURLToPath(result.url);
      if (
        watchedDirectories.some((directory) =>
          path.includes(`/src/${directory}/`),
        )
      )
        appendFileSync(logPath, `${path}\n`);
    }
    return result;
  },
});
