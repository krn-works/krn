import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  codexStream,
  fixture,
  hash,
  refused,
  tree,
} from './session-fixture.ts';

test('eval session resolves a planned arm, preserves raw bytes and accounts Codex subsets', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    await f.scenario();
    const protectedBefore = [
      await tree(f.experiment),
      await tree(f.home),
      await tree(f.neighbour),
    ];
    const observed = f.invoke(f.args());
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'completed');
    assert.equal(record.exitCode, 0);
    assert.equal(record.runId, f.runId());
    assert.equal(record.arm, 'A');
    assert.equal(record.model, 'fixture-model');
    assert.equal(record.harness, 'codex');
    assert.equal(record.promptSha256, hash(f.prompt));
    const config = await readFile(join(f.slot, 'codex', 'config.toml'));
    assert.equal(record.configSha256, hash(config));
    assert.doesNotMatch(config.toString(), /project_doc_max_bytes/u);
    assert.match(config.toString(), /approval_policy = "never"/u);
    assert.equal(
      (await readFile(join(f.slot, 'codex', 'auth.json'))).length,
      0,
    );
    assert.deepEqual(record.usage, {
      status: 'complete',
      input_tokens: 11,
      output_tokens: 5,
      cached_input_tokens: 7,
      reasoning_output_tokens: 3,
      total_tokens: 16,
    });
    const calls = (await readFile(join(f.output(), 'calls.jsonl'), 'utf8'))
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.index),
      [1],
    );
    assert.equal(calls[0].kind, 'turn.completed');
    assert.equal(calls[0].usage.cached_input_tokens, 7);
    assert.deepEqual(
      await readFile(join(f.output(), 'stream.jsonl')),
      Buffer.from(codexStream),
    );
    assert.deepEqual(
      await readFile(join(f.output(), 'stderr.log')),
      Buffer.from([0, 255, 10]),
    );
    assert.deepEqual(
      [await tree(f.experiment), await tree(f.home), await tree(f.neighbour)],
      protectedBefore,
    );
    refused(f, f.args()); // Neither evidence nor config may be reused.
  } finally {
    await f.cleanup();
  }
});
test('eval session timeout drains the scope including a detached network listener', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    await f.scenario('', 0, true);
    const observed = f.invoke([...f.args(), '--timeout', '5']);
    assert.equal(observed.status, 124, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'timeout');
    assert.equal(record.usage.status, 'missing');
    const { port } = JSON.parse(
      await readFile(join(f.slot, 'repo', 'listener.json'), 'utf8'),
    );
    await new Promise<void>((resolvePromise, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error('listener probe did not settle'));
      });
      socket.on('connect', () => {
        socket.destroy();
        reject(new Error('detached listener survived'));
      });
      socket.on('error', (error) => {
        assert.equal('code' in error && error.code, 'ECONNREFUSED');
        resolvePromise();
      });
    });
  } finally {
    await f.cleanup();
  }
});
