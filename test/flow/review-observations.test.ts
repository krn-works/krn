import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { runReview } from '../../src/flow/index.ts';
import { reviewRecordSchema } from '../../src/flow/types.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

// Verbatim captured Codex stream; kept with the frozen observer so base replay
// does not depend on the fixture file. The final message intentionally is not a verdict.
const capture = String.raw`{"type":"thread.started","thread_id":"01a17dc8-8990-7cb0-88dd-6e067a870e1d"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/usr/bin/bash -lc \"printf 'OK\\\\n' > hello.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/usr/bin/bash -lc \"printf 'OK\\\\n' > hello.txt\"","aggregated_output":"","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"DONE"}}
{"type":"turn.completed","usage":{"input_tokens":20385,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":47,"reasoning_output_tokens":0}}
`;

async function capturedReview(stream: string, exitCode = 0, timeout = false) {
  const root = mkdtempSync(join(tmpdir(), 'review-observations-'));
  const git = (...args: string[]) => {
    const child = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'README.md'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'README.md'), 'head');
    git('commit', '-qam', 'head');
    const head = git('rev-parse', 'HEAD');
    const lens = join(root, 'lens');
    writeFileSync(lens, 'Check contract');
    const executable = join(root, 'codex-stub.mjs');
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nfor await (const chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(stream)});${timeout ? 'setInterval(() => {}, 1000);' : `process.exitCode = ${exitCode};`}`,
      { mode: 0o700 },
    );
    await runReview({
      repo: root,
      base,
      head,
      lens,
      codexExecutable: executable,
      ...(timeout ? { timeoutMs: 5000 } : {}),
    });
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, '.krn/runs/review', head, 'record.json'), 'utf8'),
    );
    const result = reviewRecordSchema.safeParse(parsed);
    assert.equal(
      result.success,
      true,
      'written review record satisfies its schema',
    );
    if (!result.success) throw new Error('written review record is invalid');
    if (result.data.schemaVersion !== 2)
      throw new Error('written review record is not schema v2');
    return result.data;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function hostTest(name: string, run: (context: TestContext) => Promise<void>) {
  test(name, (context) => {
    if (!requiresIsolation(context, name, ['systemdUserScope'])) return;
    return run(context);
  });
}

hostTest(
  'panel persists captured usage, timing and round in its written record',
  async () => {
    const record = await capturedReview(capture);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.round, 1);
    assert.ok(record.timing);
    assert.ok(record.redFirstTiming);
    assert.ok(record.timing.durationMs >= 0);
    assert.ok(record.redFirstTiming.durationMs >= 0);
    for (const judge of record.judges) {
      assert.ok(judge.usage);
      assert.ok(judge.timing);
      assert.equal(judge.state, 'incomplete');
      assert.equal(
        judge.usage.tokens.inputTokens,
        20385,
        JSON.stringify(judge),
      );
      assert.equal(judge.usage.tokens.cachedInputTokens, 12160);
      assert.equal(judge.usage.tokens.outputTokens, 47);
      assert.equal(judge.usage.tokens.cacheWriteInputTokens, 0);
      assert.equal(judge.usage.tokens.reasoningOutputTokens, 0);
      assert.equal(judge.usage.state, 'observed');
      assert.ok(judge.timing.durationMs >= 0);
    }
  },
);

hostTest(
  'panel records unknown usage when the stream reports no counts',
  async () => {
    const record = await capturedReview(
      '{"type":"turn.started"}\n{"type":"turn.completed"}\n',
    );
    for (const judge of record.judges) {
      assert.ok(judge.usage);
      assert.ok(judge.timing);
      assert.equal(judge.usage.state, 'unknown');
      assert.ok(judge.usage.reason);
      assert.deepEqual(judge.usage.tokens, {});
      assert.equal(judge.usage.invalidFields, 0);
      assert.equal(judge.usage.complete, false);
    }
  },
);

hostTest(
  'panel records invalid usage fields without inventing zero counts',
  async () => {
    const record = await capturedReview(
      '{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":3,"cached_input_tokens":"bad"}}\n',
    );
    for (const judge of record.judges) {
      assert.ok(judge.usage);
      assert.ok(judge.timing);
      assert.deepEqual(judge.usage.tokens, { outputTokens: 3 });
      assert.equal(judge.usage.invalidFields, 2);
      assert.equal(judge.usage.complete, false);
    }
  },
);

hostTest(
  'panel sums multiple captured turns and marks their semantics unverified',
  async () => {
    const stream = readFileSync(
      new URL('../fixtures/codex/rust-v0.162.1.jsonl', import.meta.url),
      'utf8',
    );
    const record = await capturedReview(stream);
    for (const judge of record.judges) {
      assert.ok(judge.usage);
      assert.ok(judge.timing);
      assert.deepEqual(judge.usage.tokens, {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 9,
        cacheWriteInputTokens: 3,
        reasoningOutputTokens: 2,
      });
      assert.equal(judge.usage.multiTurnSemantics, 'unverified');
      assert.equal(judge.usage.turnsCompleted, 2);
    }
  },
);

for (const failure of ['nonzero exit', 'timeout']) {
  hostTest(
    `panel retains observed usage and timing after ${failure}`,
    async () => {
      const record = await capturedReview(
        capture,
        failure === 'nonzero exit' ? 1 : 0,
        failure === 'timeout',
      );
      for (const judge of record.judges) {
        assert.ok(judge.usage);
        assert.ok(judge.timing);
        assert.equal(judge.state, 'incomplete');
        assert.equal(judge.reason, 'nonzero_exit');
        assert.equal(judge.usage.tokens.inputTokens, 20385);
        assert.ok(judge.timing.startedAt);
        assert.ok(judge.timing.endedAt);
        assert.ok(judge.timing.durationMs >= 0);
      }
    },
  );
}
