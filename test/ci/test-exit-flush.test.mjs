import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { testCeilingArguments } from '../../scripts/lib/test-timeout.ts';

// A test file as the runner starts it: a child with NODE_TEST_CONTEXT whose
// serialized events go down a stdout pipe the parent reads. Under
// --test-force-exit the child used to exit before its last events (the final
// results and its own test:summary) reached the pipe; with the ceiling flags
// as the suite passes them the whole stream arrives.
function runChild(file, flags) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, file], {
      env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      resolve({
        summary: output.includes('test:summary'),
        lastTest: output.includes('case 299'),
      });
    });
  });
}

test('a force-exited test file delivers its last results and summary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'krn-exit-flush-'));
  try {
    const file = join(directory, 'many.test.mjs');
    writeFileSync(
      file,
      "import test from 'node:test';\nfor (let i = 0; i < 300; i += 1) test(`case ${i}`, () => {});\n",
    );
    const flags = testCeilingArguments({});
    const runs = await Promise.all(
      Array.from({ length: 12 }, () => runChild(file, flags)),
    );
    assert.deepEqual(
      runs.filter((run) => !run.summary || !run.lastTest),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
