import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = [
  'test/verdict/sandbox.test.ts',
  'test/hosts/codex-registration.test.ts',
  'test/flow/review-parallel.test.ts',
  'test/live-smoke-signal.test.ts',
  'test/task/claims.test.ts',
  'test/task/task.test.ts',
];

// These are the synchronization patterns removed from the affected tests,
// including embedded fixture programs. Socket deadlines remain permitted.
const patterns = [
  ['fixed timer wait', /(?<![.\w])setTimeout\s*\(/u],
  ['fixed delay wait', /\bawait\s+(?:delay|sleep)\s*\(/u],
  ['sleep command wait', /(?:\/usr\/bin\/sleep|\bsleep\s+\d)/u],
  ['duration-ordered judges', /\bdelaysMs\b/u],
  ['elapsed-time assertion', /(?:Date|performance)\.now\(\)\s*-\s*\w+/u],
  ['shared task scratch', /\.krn\/runs\/claude-claim-lock\/scratch/u],
] as const;

for (const file of files) {
  test(`${file} waits for conditions instead of fixed delays or elapsed time`, () => {
    const revision = process.env.KRN_TIMING_WAITS_REVISION;
    const source = revision
      ? execFileSync('git', ['show', `${revision}:${file}`], {
          cwd: root,
          encoding: 'utf8',
        })
      : readFileSync(join(root, file), 'utf8');
    for (const [name, pattern] of patterns)
      assert.equal(pattern.test(source), false, `${file}: ${name}`);
  });
}
