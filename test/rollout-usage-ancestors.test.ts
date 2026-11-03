import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/rollout-usage.ts', import.meta.url),
);
const id = '01a13f09-ba70-7052-9fc0-9a279bb50a92';

function run(args: string[]) {
  assert.ok(existsSync(script), 'rollout usage script exists');
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function rollout(): string {
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  return `${[
    {
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'session_meta',
      payload: { id },
    },
    {
      timestamp: '2026-10-15T10:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: usage, last_token_usage: usage },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')}\n`;
}

test('a symlinked ancestor directory is refused for every input form', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rollout-ancestors-')));
  try {
    const sessions = join(root, 'real', 'sessions');
    const day = join(sessions, '2026', '10', '15');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-10-15T12-09-24-${id}.jsonl`),
      rollout(),
    );
    const runDir = join(root, 'real', 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'closed-session.json'),
      JSON.stringify({ threadId: id }),
    );
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const linked = join(root, 'link');

    // Control: the real paths are accepted, so a refusal below is the link.
    const direct = run(['--sessions', sessions, '--run', runDir]);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(JSON.parse(direct.stdout).uncached, 8);

    const cases = [
      [
        '--rollout',
        join(
          linked,
          'sessions',
          '2026',
          '10',
          '15',
          `rollout-2026-10-15T12-09-24-${id}.jsonl`,
        ),
      ],
      ['--sessions', join(linked, 'sessions'), '--thread', id.slice(0, 8)],
      ['--sessions', sessions, '--run', join(linked, 'run')],
    ];
    for (const args of cases) {
      const result = run(args);
      assert.equal(result.status, 65, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
