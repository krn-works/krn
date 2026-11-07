// Decide which CI jobs a change needs. Fail open: a push, an unreadable diff
// or any doubt runs everything. Prints `key=value` lines for GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TASK_RECORD = /^tasks\/[^/]+\.json$/u;

/**
 * @param {{event: string, files: string[] | undefined}} input
 * @returns {{test: boolean}}
 */
export function affectedJobs({ event, files }) {
  if (event !== 'pull_request' || !files || files.length === 0)
    return { test: true };
  if (files.some((file) => typeof file !== 'string' || file === ''))
    return { test: true };
  return { test: !files.every((file) => TASK_RECORD.test(file)) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let result = { test: true };
  try {
    const listing = process.argv[2]
      ? readFileSync(process.argv[2], 'utf8')
      : undefined;
    result = affectedJobs({
      event: process.env.EVENT ?? '',
      files: listing?.split('\n').filter(Boolean),
    });
  } catch (error) {
    process.stderr.write(`change detection failed open: ${error.message}\n`);
  }
  process.stdout.write(`test=${result.test}\n`);
}
