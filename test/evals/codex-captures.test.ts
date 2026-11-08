import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionUsage } from '../../src/evals/usage.ts';
import {
  codexCapture,
  codexCaptures,
  codexProvenance,
  codexStream,
} from './session-fixture.ts';

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const run = (exitCode: number) => ({
  exitCode,
  timedOut: false,
  launchError: false,
});
const missing = { status: 'missing', total_tokens: null };

function account(stream: Buffer | string): SessionUsage {
  const accounting = new SessionUsage();
  accounting.push(Buffer.from(stream));
  accounting.finish();
  return accounting;
}

const lines = (bytes: Buffer) =>
  bytes.toString('utf8').split('\n').filter(Boolean);

function warnings(bytes: Buffer): string[] {
  return lines(bytes).flatMap((line) => {
    const event: unknown = JSON.parse(line);
    if (typeof event !== 'object' || event === null) return [];
    if (!('type' in event) || event.type !== 'item.completed') return [];
    if (!('item' in event)) return [];
    const item = event.item;
    return typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      item.type === 'error' &&
      'message' in item &&
      typeof item.message === 'string'
      ? [item.message]
      : [];
  });
}

test('codex 0.167.0 captures are verbatim: provenance pins every file by sha256', async () => {
  const provenance = await codexProvenance();
  assert.equal(provenance.receiver, 'codex-cli 0.167.0');
  const listed = ['provenance.json'];
  for (const capture of provenance.captures)
    for (const { file, sha256: digest } of [capture.stdout, capture.stderr]) {
      listed.push(file);
      assert.equal(
        sha256(await readFile(join(codexCaptures, file))),
        digest,
        file,
      );
    }
  assert.deepEqual((await readdir(codexCaptures)).sort(), listed.sort());
});

test('codex turn.failed carries no usage, so a failed session has no token summary', async () => {
  const capture = await codexCapture('turn-failed');
  const failed = lines(capture.stdout).find((line) =>
    line.startsWith('{"type":"turn.failed"'),
  );
  assert.deepEqual(Object.keys(JSON.parse(failed ?? '{}')), ['type', 'error']);
  const accounting = account(capture.stdout);
  assert.equal(accounting.failed, true);
  assert.equal(accounting.toolCalled, false);
  assert.deepEqual(accounting.calls, [
    { index: 1, kind: 'turn.failed', usage: null },
  ]);
  assert.deepEqual(accounting.summary(false), missing);
  assert.equal(accounting.status(run(capture.exitCode)), 'harness_error');
});

test('codex reports an ignored setting as an item.completed error item and the session rejects its config', async () => {
  const capture = await codexCapture('config-ignored');
  const accounting = account(capture.stdout);
  assert.equal(accounting.configRejected, true);
  assert.equal(capture.exitCode, 0);
  assert.equal(accounting.status(run(capture.exitCode)), 'harness_error');
  assert.deepEqual(accounting.summary(false), {
    status: 'complete',
    input_tokens: 10_827,
    output_tokens: 5,
    cached_input_tokens: 9_088,
    reasoning_output_tokens: 0,
    total_tokens: 10_832,
  });
  // Other Codex warnings share the item shape and must not reject the config.
  for (const name of ['turn-failed', 'retry-failed']) {
    const other = (await codexCapture(name)).stdout;
    assert.ok(warnings(other).length > 0, name);
    assert.equal(account(other).configRejected, false, name);
  }
  // The same summary as a top-level error is not the receiver's form.
  const [message] = warnings(capture.stdout);
  const relabelled = `${JSON.stringify({ type: 'error', message })}\n${codexStream}`;
  assert.equal(account(relabelled).configRejected, false);
});

test('codex session whose agent never got a turn is a harness error', async () => {
  for (const name of ['mask-exit-70', 'startup-failed']) {
    const capture = await codexCapture(name);
    assert.equal(capture.stdout.length, 0, name);
    assert.notEqual(capture.exitCode, 0, name);
    const accounting = account(capture.stdout);
    assert.equal(accounting.turnStarted, false, name);
    assert.equal(
      accounting.status(run(capture.exitCode)),
      'harness_error',
      name,
    );
    assert.deepEqual(accounting.summary(false), missing, name);
  }
});

test('codex retries are diagnostics: only turn.failed or a non-zero exit fails a session', async () => {
  const retried = await codexCapture('retry-failed');
  const stream = lines(retried.stdout);
  const retry = stream.find((line) =>
    line.startsWith('{"type":"error","message":"Reconnecting... '),
  );
  assert.ok(retry);
  const accounting = account(retried.stdout);
  assert.equal(accounting.failed, true);
  assert.equal(accounting.status(run(retried.exitCode)), 'harness_error');
  // exec exits 0 when a retried request recovers (lib.rs in provenance.json).
  const completed = lines((await codexCapture('config-ignored')).stdout);
  const recovered = account(
    `${[...stream.slice(0, 2), retry, ...completed.slice(-2)].join('\n')}\n`,
  );
  assert.equal(recovered.failed, false);
  assert.equal(recovered.status(run(0)), 'completed');
  assert.equal(recovered.summary(false).total_tokens, 10_832);
});

test('codex usage is accountable only for a lone completed turn', async () => {
  const completed = lines((await codexCapture('config-ignored')).stdout);
  const started = completed.find((line) => line === '{"type":"turn.started"}');
  const finished = completed.at(-1);
  assert.ok(started && finished?.startsWith('{"type":"turn.completed"'));
  const twice = account(
    `${[started, finished, started, finished].join('\n')}\n`,
  );
  assert.equal(twice.status(run(0)), 'completed');
  assert.deepEqual(twice.summary(false), missing);
});
