import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/context-report.ts', import.meta.url),
);

test('context report counts main-chain turns, compactions and tool characters', () => {
  assert.ok(existsSync(script), 'report script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-report-'));
  const input = { command: 'pwd' };
  const assistant = {
    type: 'assistant',
    message: {
      id: 'message',
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
      content: [{ type: 'tool_use', input }],
    },
  };
  try {
    writeFileSync(
      join(root, 'transcript.jsonl'),
      `${[
        assistant,
        { ...assistant, message: { ...assistant.message, content: [] } },
        {
          ...assistant,
          isSidechain: true,
          message: {
            ...assistant.message,
            id: 'sidechain',
            usage: {
              input_tokens: 99999,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                content: [{ type: 'text', text: '12345678' }],
              },
            ],
          },
        },
        { type: 'system', subtype: 'compact_boundary' },
        {
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: ['s'.repeat(38)],
            tools: [{ name: 'Big', description: 'd'.repeat(70) }],
          },
        },
        {
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            tools: [{ name: 'Later', description: 'x' }],
          },
        },
        { type: 'attachment', attachment: { type: 'skill_listing' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\nmalformed\n`,
    );
    const result = spawnSync(process.execPath, [script, root, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const [row] = JSON.parse(result.stdout);
    assert.deepEqual(row, {
      path: join(root, 'transcript.jsonl'),
      peakContext: 124,
      assistantTurns: 1,
      compactions: 1,
      toolResultTokens: 2,
      toolInputTokens: Math.round(JSON.stringify(input).length / 4),
      baselineTokens: { tools: 26, systemPrompt: 11, skill_listing: 6 },
      toolTokens: { Big: 25 },
    });
    const text = spawnSync(
      process.execPath,
      [script, join(root, 'transcript.jsonl')],
      { encoding: 'utf8' },
    );
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /peak main-chain context: 124/u);
    assert.match(text.stdout, /baseline tokens \(~chars\/4\): tools 26/u);
    assert.match(text.stdout, /largest tools: Big 25/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
