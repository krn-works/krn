import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/rollout-usage.ts', import.meta.url),
);

function invoke(args: string[]) {
  assert.ok(existsSync(script), 'rollout usage script exists');
  return requireSpawn(args);
}

function requireSpawn(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
  });
  return result;
}

function recordLine(timestamp: string, type: string, payload: unknown) {
  return { timestamp, type, payload };
}

function tokenUsage(
  input: number,
  cached: number,
  output: number,
  total: number,
) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: total,
  };
}

function tokenCount(
  timestamp: string,
  total: ReturnType<typeof tokenUsage>,
  last: ReturnType<typeof tokenUsage> = total,
) {
  return recordLine(timestamp, 'event_msg', {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last },
  });
}

function writeRollout(path: string, lines: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

function rolloutPath(sessions: string, id: string) {
  return join(
    sessions,
    '2026',
    '10',
    '15',
    `rollout-2026-10-15T12-09-24-${id}.jsonl`,
  );
}

test('rollout usage counts final token usage, resolves inputs, and rejects unsafe data', () => {
  assert.ok(existsSync(script), 'report script exists');
  const tempBase = fileURLToPath(
    new URL('../.krn/runs/worker/tmp/', import.meta.url),
  );
  mkdirSync(tempBase, { recursive: true });
  const root = mkdtempSync(join(tempBase, 'rollout-usage-'));
  try {
    const id = '01a13f09-ba70-7052-9fc0-9a279bb50a92';
    const direct = join(root, 'direct.jsonl');
    const base = [
      recordLine('2026-10-15T12:00:00.000Z', 'session_meta', { id }),
      recordLine('2026-10-15T12:00:10.000Z', 'turn_context', {
        model: 'gpt-6.1-sol',
        effort: 'low',
      }),
      tokenCount(
        '2026-10-15T12:00:30.000Z',
        tokenUsage(90, 30, 10, 100),
        tokenUsage(50, 20, 10, 60),
      ),
      tokenCount('2026-10-15T12:00:35.000Z', tokenUsage(90, 30, 10, 100)),
      recordLine('2026-10-15T12:00:40.000Z', 'event_msg', {
        type: 'token_count',
        info: null,
      }),
      recordLine('2026-10-15T12:00:45.000Z', 'turn_context', {
        model: 'gpt-6.1-codex',
        effort: 'high',
      }),
      tokenCount(
        '2026-10-15T12:01:31.000Z',
        tokenUsage(130, 60, 20, 150),
        tokenUsage(130, 60, 20, 150),
      ),
    ];
    writeRollout(direct, base);

    const directResult = invoke(['--rollout', direct]);
    assert.equal(directResult.status, 0, directResult.stderr);
    assert.equal(directResult.stderr, '');
    const [directRow] = directResult.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(directRow, {
      source: 'rollout',
      rolloutId: id,
      file: direct,
      models: ['gpt-6.1-sol', 'gpt-6.1-codex'],
      efforts: ['low', 'high'],
      firstTs: '2026-10-15T12:00:00.000Z',
      lastTs: '2026-10-15T12:01:31.000Z',
      wallMinutes: 1.5,
      calls: 2,
      input: 130,
      cached: 60,
      output: 20,
      uncached: 90,
      peakContext: 130,
      malformedLines: 0,
      driverUncached: null,
    });

    const sessions = join(root, 'sessions');
    const threadFile = rolloutPath(sessions, id);
    writeRollout(threadFile, base);
    const threadResult = invoke([
      '--sessions',
      sessions,
      '--thread',
      id.slice(0, 8),
    ]);
    assert.equal(threadResult.status, 0, threadResult.stderr);
    assert.equal(JSON.parse(threadResult.stdout).rolloutId, id);
    assert.equal(JSON.parse(threadResult.stdout).source, 'thread');

    const ambiguousId = '01a13f09-cb70-7052-9fc0-9a279bb50a92';
    writeRollout(rolloutPath(sessions, ambiguousId), [
      recordLine('2026-10-15T12:00:00.000Z', 'session_meta', {
        id: ambiguousId,
      }),
      tokenCount('2026-10-15T12:00:01.000Z', tokenUsage(10, 0, 1, 11)),
    ]);
    const ambiguous = invoke([
      '--sessions',
      sessions,
      '--thread',
      id.slice(0, 8),
    ]);
    assert.equal(ambiguous.status, 65);
    assert.equal(ambiguous.stdout, '');
    const missing = invoke(['--sessions', sessions, '--thread', 'abcdef12']);
    assert.equal(missing.status, 65);
    assert.equal(missing.stdout, '');

    const runDir = join(root, 'run');
    mkdirSync(join(runDir, 'rounds', '001'), { recursive: true });
    mkdirSync(join(runDir, 'rounds', '002'), { recursive: true });
    writeFileSync(
      join(runDir, 'closed-session.json'),
      JSON.stringify({ threadId: id }),
    );
    writeFileSync(
      join(runDir, 'rounds', '001', 'metrics.json'),
      JSON.stringify({ cumulative: { uncached_total: 111 } }),
    );
    writeFileSync(
      join(runDir, 'rounds', '002', 'metrics.json'),
      JSON.stringify({ cumulative: { uncached_total: 222 } }),
    );
    const runResult = invoke(['--sessions', sessions, '--run', runDir]);
    assert.equal(runResult.status, 0, runResult.stderr);
    const runRow = JSON.parse(runResult.stdout);
    assert.equal(runRow.source, 'run');
    assert.equal(runRow.driverUncached, 222);

    const bomFile = join(root, 'bom-crlf.jsonl');
    writeFileSync(
      bomFile,
      `\uFEFF${[
        recordLine('2026-10-15T12:00:00.000Z', 'session_meta', { id }),
        tokenCount('2026-10-15T12:00:01.000Z', tokenUsage(10, 2, 3, 13)),
      ]
        .map((line) => JSON.stringify(line))
        .join('\r\n')}\r\nnot-json\r\n`,
    );
    const bomResult = invoke(['--rollout', bomFile]);
    assert.equal(bomResult.status, 0, bomResult.stderr);
    assert.equal(JSON.parse(bomResult.stdout).malformedLines, 1);

    const symlinkPath = join(root, 'linked.jsonl');
    symlinkSync(direct, symlinkPath);
    const linked = invoke(['--rollout', symlinkPath]);
    assert.equal(linked.status, 65);
    assert.equal(linked.stdout, '');

    const noUsage = join(root, 'no-usage.jsonl');
    writeRollout(noUsage, [
      recordLine('2026-10-15T12:00:00.000Z', 'session_meta', { id }),
    ]);
    const noTokenCount = invoke(['--rollout', noUsage]);
    assert.equal(noTokenCount.status, 65);
    assert.equal(noTokenCount.stdout, '');

    for (const args of [['--unknown'], []]) {
      const result = invoke(args);
      assert.equal(result.status, 64);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim().split('\n').length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
