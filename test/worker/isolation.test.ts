import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { recordedServers } from '../../scripts/codex/app-server-replay.ts';
import { isolationConfig } from '../../src/worker/isolation.ts';
import { WorkerError } from '../../src/worker/state.ts';

test('isolation turns off hooks, plugins, the skills catalog, web search and every listed MCP server', () => {
  const config = isolationConfig(
    JSON.stringify([
      { name: 'figma', enabled: true, transport: { type: 'stdio' } },
      { name: 'asana', enabled: false },
      { name: 'figma' },
    ]),
  );
  assert.equal(config['features.hooks'], false);
  assert.equal(config['features.plugins'], false);
  assert.equal(config['features.apps'], false);
  assert.equal(config['skills.include_instructions'], false);
  assert.equal(config.web_search, 'disabled');
  assert.equal(config['features.goals'], false);
  assert.deepEqual(
    Object.keys(config).filter((key) => key.startsWith('mcp_servers.')),
    ['mcp_servers.asana.enabled', 'mcp_servers.figma.enabled'],
  );
});

test('an unreadable MCP server list fails closed', () => {
  for (const text of ['', '{}', '[{"name":"a.b c"}]', '[{}]'])
    assert.throws(
      () => isolationConfig(text),
      (error) => error instanceof WorkerError && error.exitCode === 65,
      text,
    );
});

test('replay answers mcp list with the names its thread/start turned off', () => {
  const frame = {
    id: 2,
    method: 'thread/start',
    params: {
      config: {
        'features.hooks': false,
        'mcp_servers.figma.enabled': false,
        'mcp_servers.node_repl.enabled': false,
      },
    },
  };
  assert.deepEqual(
    recordedServers(
      `> {"id":1,"method":"initialize"}\n> ${JSON.stringify(frame)}\n`,
    ),
    [{ name: 'figma' }, { name: 'node_repl' }],
  );
});

test('a recorded worker first call stays below 15,000 input tokens', () => {
  const log = readFileSync(
    new URL('../fixtures/codex-app-server/compact.rpc', import.meta.url),
    'utf8',
  );
  const first = Number(log.match(/"inputTokens":(\d+)/)?.[1]);
  assert.ok(first > 0 && first < 15_000, `first call took ${first} tokens`);
});
