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

// Verbatim captures: a task claim, a transcript line, a CI summary line, a decision row.
test('lane and state readers accept captured files and reject look-alikes', async () => {
  const { claimFileSchema } = await import('../src/cli/lane.ts');
  const { transcriptLineSchema } = await import(
    '../src/cli/lane-run/result.ts'
  );
  const { redCheckSchema, testSummarySchema } = await import(
    '../src/cli/lane-run/red-check.ts'
  );
  const { decisionSchema } = await import('../src/cli/decide.ts');
  const { claimIdSchema, taskStatusSchema } = await import(
    '../src/state/loss.ts'
  );
  const { manifestSchema } = await import('../src/adopt/init.ts');
  const claim = '{"id":"t-abc1234","worktree":"/w/x","actor":"claude"}';
  assert.equal(claimFileSchema.parse(JSON.parse(claim)).worktree, '/w/x');
  assert.equal(claimIdSchema.parse(JSON.parse(claim)).id, 't-abc1234');
  assert.equal(claimFileSchema.safeParse(null).success, false);
  assert.equal(
    taskStatusSchema.parse(JSON.parse('{"id":"t-a","status":"closed"}')).status,
    'closed',
  );
  const line =
    '{"type":"assistant","message":{"id":"msg_01","role":"assistant"}}';
  assert.equal(
    transcriptLineSchema.parse(JSON.parse(line)).message?.id,
    'msg_01',
  );
  assert.equal(transcriptLineSchema.safeParse('x').success, false);
  const summary = '{"files":[{"file":"test/a.test.ts","failed":2}],"pass":1}';
  assert.equal(
    testSummarySchema.parse(JSON.parse(summary)).files?.[0]?.failed,
    2,
  );
  assert.equal(
    testSummarySchema.safeParse({ files: [{ file: 1 }] }).success,
    false,
  );
  assert.equal(
    redCheckSchema.safeParse({ run: '1', sha: 'abc1234' }).success,
    true,
  );
  assert.throws(() => redCheckSchema.parse('x'), /red-check record/);
  const row =
    '{"id":"d1","question":"q","recommendation":"r","default":"d","deadline":"2026-11-20","opened":"2026-11-14","status":"open"}';
  assert.equal(decisionSchema.parse(JSON.parse(row)).status, 'open');
  assert.throws(() => decisionSchema.parse('x'), /decision row/);
  const pkg = manifestSchema.parse(
    JSON.parse('{"name":"x","scripts":{"build":"tsc"},"license":"MIT"}'),
  );
  assert.equal(pkg.license, 'MIT');
  assert.throws(() => manifestSchema.parse('x'), /package\.json/);
});
