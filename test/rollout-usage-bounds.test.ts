import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/rollout-usage.ts', import.meta.url),
);

function invoke(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('rollout usage bounds JSON and directory scans', () => {
  assert.ok(existsSync(script), 'rollout usage script exists');
  const tempBase = fileURLToPath(new URL('../.krn/tmp/', import.meta.url));
  mkdirSync(tempBase, { recursive: true });
  const root = mkdtempSync(join(tempBase, 'rollout-usage-bounds-'));
  try {
    const oversized = join(root, 'session.json');
    writeFileSync(
      oversized,
      `${JSON.stringify({ threadId: 'abcdef12' })}${' '.repeat(1024 ** 2)}`,
    );
    const json = invoke(['--run', root, '--sessions', join(root, 'sessions')]);
    assert.equal(json.status, 65, json.stderr);
    assert.equal(json.stdout, '');
    assert.match(json.stderr, /--run/);

    const sessions = join(root, 'sessions');
    mkdirSync(sessions);
    for (let index = 0; index <= 10_000; index++) {
      writeFileSync(join(sessions, `entry-${index}`), '');
    }
    const directory = invoke(['--sessions', sessions, '--thread', 'abcdef12']);
    assert.equal(directory.status, 65, directory.stderr);
    assert.equal(directory.stdout, '');
    assert.match(directory.stderr, /--thread/);

    const rollout = join(root, 'normal.jsonl');
    const id = '01a13f09-ba70-7052-9fc0-9a279bb50a92';
    const usage = {
      input_tokens: 5,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 6,
    };
    const lines = [
      {
        timestamp: '2026-10-15T12:00:00.000Z',
        type: 'session_meta',
        payload: { id },
      },
      {
        timestamp: '2026-10-15T12:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      },
    ];
    writeFileSync(
      rollout,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    const control = invoke(['--rollout', rollout]);
    assert.equal(control.status, 0, control.stderr);
    assert.equal(JSON.parse(control.stdout).rolloutId, id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
