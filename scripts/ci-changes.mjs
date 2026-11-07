// Decide which CI jobs a change needs. Fail open: a push, an unreadable diff
// or any doubt runs everything. Prints `key=value` lines for GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectIsolationTestFiles } from './isolation-gate.mjs';
import { TEST_FILE_GLOB } from './test-suite.mjs';

const TASK_RECORD = /^tasks\/[^/]+\.json$/u;
// Paths whose change cannot affect sandbox or systemd-scope behaviour.
const DOCUMENT = /^(?:docs\/.+|[^/]+)\.md$/u;
const AGENT_INSTRUCTIONS = /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u;
const TEST_FILE = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;

/**
 * @param {{event: string, files: string[] | undefined, isolationFiles: string[]}} input
 * @returns {{test: boolean, isolation: boolean}}
 */
export function affectedJobs({ event, files, isolationFiles }) {
  const all = { test: true, isolation: true };
  if (event !== 'pull_request' || !files || files.length === 0) return all;
  if (files.some((file) => typeof file !== 'string' || file === '')) return all;
  const test = !files.every((file) => TASK_RECORD.test(file));
  const isolationSet = new Set(isolationFiles);
  const isolation = !files.every(
    (file) =>
      TASK_RECORD.test(file) ||
      (DOCUMENT.test(file) && !AGENT_INSTRUCTIONS.test(file)) ||
      (TEST_FILE.test(file) && !isolationSet.has(file)),
  );
  return { test, isolation: test && isolation };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let result = { test: true, isolation: true };
  try {
    const event = process.env.EVENT ?? '';
    const listing = process.argv[2]
      ? readFileSync(process.argv[2], 'utf8')
      : undefined;
    const files = listing?.split('\n').filter(Boolean);
    const isolationFiles = selectIsolationTestFiles(
      process.cwd(),
      TEST_FILE_GLOB,
    );
    if (isolationFiles.length === 0)
      throw new Error('no isolation test files found');
    result = affectedJobs({ event, files, isolationFiles });
  } catch (error) {
    process.stderr.write(`change detection failed open: ${error.message}\n`);
  }
  process.stdout.write(`test=${result.test}\nisolation=${result.isolation}\n`);
}
