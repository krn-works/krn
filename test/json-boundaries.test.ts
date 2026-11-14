import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandFailure, refusalSchema } from '../src/deliver/transport.ts';
import { failureLine } from '../src/hook/stop.ts';
import { jsonObject } from '../src/repo/contract.ts';

// Verbatim shapes: a KRN receiver refusal, a node:test failure line, a package.json head.
const REFUSAL = '{"ok":false,"reason":"pull request is not mergeable"}';
const FAILURE_LINE =
  '{"file":"test/a.test.ts","name":"does the thing","extra":1}';

test('refusalSchema accepts a receiver refusal and rejects look-alikes', () => {
  assert.equal(
    refusalSchema.parse(JSON.parse(REFUSAL)).reason,
    'pull request is not mergeable',
  );
  assert.equal(
    refusalSchema.safeParse({ ok: true, reason: 'x' }).success,
    false,
  );
  assert.equal(
    refusalSchema.safeParse({ ok: false, reason: 3 }).success,
    false,
  );
});

test('CommandFailure names the refusal reason and tolerates non-JSON stdout', () => {
  const fail = (stdout: string) =>
    new CommandFailure({ code: 1, stdout, stderr: '' });
  assert.equal(fail(REFUSAL).message, 'pull request is not mergeable');
  assert.equal(fail('plain text\n').message, 'command exited 1');
  assert.equal(fail('null').message, 'command exited 1');
});

test('failureLine reads the runner failure line and rejects a partial one', () => {
  const line = failureLine(JSON.parse(FAILURE_LINE));
  assert.deepEqual(line, { file: 'test/a.test.ts', name: 'does the thing' });
  assert.equal(failureLine({ file: 'x' }), undefined);
  assert.equal(failureLine(null), undefined);
});

test('jsonObject accepts objects only', () => {
  const pkg = '{"name":"x","scripts":{"test":"node --test"}}';
  assert.notEqual(jsonObject(JSON.parse(pkg)), undefined);
  for (const bad of ['[]', 'null', '3', '"s"'])
    assert.equal(jsonObject(JSON.parse(bad)), undefined);
});
