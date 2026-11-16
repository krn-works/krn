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
  const pkg = manifestSchema.parse(
    JSON.parse('{"name":"x","scripts":{"build":"tsc"},"license":"MIT"}'),
  );
  assert.equal(pkg.license, 'MIT');
  assert.throws(() => manifestSchema.parse('x'), /package\.json/);
});

// Verbatim captures: a session mark, a plan sampler row, a price table head, a project .mcp.json,
// a settings Stop hook, a task record head.
test('outcome, adopt and state readers accept captured files and reject look-alikes', async () => {
  const { sessionMarkSchema } = await import('../src/outcome/holdings.ts');
  const { priceTableSchema } = await import('../src/outcome/slice-cost.ts');
  const { planSampleRowSchema, parsePlanSamples } = await import(
    '../src/outcome/plan-gauge.ts'
  );
  const { mcpConfigSchema } = await import('../src/adopt/first-turn.ts');
  const { stopSettingsSchema } = await import('../src/adopt/canary.ts');
  const { settingsFileSchema } = await import('../src/adopt/adopt.ts');
  const { taskIdSchema } = await import('../src/state/check.ts');

  const mark =
    '{"session":"87b3855c-ba1d-4b63-9ebe-c11242f79b67","class":"delivery","time":"2026-11-10T10:53:18.620Z"}';
  assert.equal(sessionMarkSchema.parse(JSON.parse(mark)).class, 'delivery');
  assert.equal(
    sessionMarkSchema.safeParse({ session: 's', class: 'other' }).success,
    false,
  );

  const sample =
    '{"time":"2026-11-10T09:20:58Z","session":"b68fa2a2-cb6c-4f99-a596-d633454739bf","five_hour":59,"seven_day":60}';
  assert.equal(planSampleRowSchema.parse(JSON.parse(sample)).five_hour, 59);
  assert.equal(
    planSampleRowSchema.safeParse({ time: 't', five_hour: '1', seven_day: 2 })
      .success,
    false,
  );
  assert.deepEqual(parsePlanSamples(`${sample}\nnot json\n`), [
    { at: Date.parse('2026-11-10T09:20:58Z'), fiveHour: 59, sevenDay: 60 },
  ]);

  const prices =
    '{"comment":"USD per million tokens","models":{"claude-opus-5-5":[4,20,0.2]},"longPrompt":{"model":"claude-sonnet","tokens":200000,"scale":2}}';
  assert.equal(
    priceTableSchema.parse(JSON.parse(prices)).models['claude-opus-5-5']?.[1],
    20,
  );
  assert.equal(priceTableSchema.safeParse({ models: {} }).success, false);

  const mcp = '{"mcpServers":{"docs":{"command":"npx","args":["docs"]}}}';
  assert.deepEqual(
    Object.keys(mcpConfigSchema.parse(JSON.parse(mcp)).mcpServers ?? {}),
    ['docs'],
  );
  assert.equal(mcpConfigSchema.safeParse([]).success, false);

  const settings =
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"krn hook stop"}]}]}}';
  assert.equal(
    stopSettingsSchema.parse(JSON.parse(settings)).hooks?.Stop?.[0]?.hooks?.[0]
      ?.command,
    'krn hook stop',
  );
  assert.equal(stopSettingsSchema.safeParse('x').success, false);
  assert.equal(
    settingsFileSchema.safeParse(JSON.parse(settings)).success,
    true,
  );
  assert.equal(settingsFileSchema.safeParse([]).success, false);

  assert.equal(
    taskIdSchema.parse(JSON.parse('{"id":"t-5wzk8zf","status":"open"}')).id,
    't-5wzk8zf',
  );
  assert.equal(taskIdSchema.safeParse({ id: 3 }).success, false);
});

test('shellWords quotes every word for sh -c', async () => {
  const { shellWord, shellWords } = await import('../src/repo/shell-text.ts');
  const { execFileSync } = await import('node:child_process');
  assert.equal(shellWord("it's"), `'it'\\''s'`);
  const words = ['a b', "it's", '$HOME', ''];
  const out = execFileSync('sh', ['-c', `printf '%s|' ${shellWords(words)}`], {
    encoding: 'utf8',
  });
  assert.equal(out, "a b|it's|$HOME||");
});
