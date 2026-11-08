import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capture } from '../receivers/capture.ts';

// KRN-12: codex 0.167.0 `sandbox` running a failing observer
// (test/fixtures/codex-cli-0.167.0). The stand-in replays its merged output and
// exit code, so the log and exit code KRN records are the receiver's own.
const observer = capture('fixtures/codex-cli-0.167.0', 'sandbox-observer');

test('acceptance records the captured codex sandbox output and exit code verbatim', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-acceptance-capture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(repo, 'check.test.mjs'), '');
  const output = join(root, 'output.log');
  writeFileSync(output, observer.streams.output ?? Buffer.alloc(0));
  const codex = join(root, 'codex');
  writeFileSync(
    codex,
    `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nif (process.argv[2] !== 'sandbox') process.exit(64);\nprocess.stdout.write(readFileSync(${JSON.stringify(output)}));\nprocess.exit(${observer.exitCode});\n`,
    { mode: 0o755 },
  );
  process.env.KRN_CODEX_BIN = codex;
  const { runAcceptance } = await import('../../src/worker/acceptance.ts');
  const round = join(run, 'round-1');
  mkdirSync(round);
  const [result] = await runAcceptance(
    repo,
    run,
    round,
    [],
    ['check.test.mjs'],
    codex,
  );
  assert.equal(result?.kind, 'observer');
  assert.equal(result?.exit_code, 1);
  assert.equal(result?.timed_out, false);
  assert.deepEqual(
    readFileSync(join(round, result?.log ?? '')),
    observer.streams.output,
  );
});
