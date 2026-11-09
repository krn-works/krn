import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
test('Claude context budget settings wire documented hooks and read-only reader', () => {
  const path = new URL('.claude/settings.json', root);
  assert.ok(existsSync(path), 'project settings exist');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(settings.autoCompactWindow, 400000);
  // KRN uses no claude.ai connector and no rss_news tool; both stay off for
  // every checkout of this project, worktrees included.
  assert.equal(settings.disableClaudeAiConnectors, true);
  assert.deepEqual(settings.deniedMcpServers, [{ serverName: 'rss_news' }]);
  assert.equal(settings.env.BASH_MAX_OUTPUT_LENGTH, '12000');
  assert.equal(settings.env.MAX_MCP_OUTPUT_TOKENS, '8000');
  for (const [event, file] of Object.entries({
    UserPromptSubmit: 'context-gauge',
    PostToolUse: 'context-gauge',
    SessionStart: 'context-restart',
  })) {
    const group = settings.hooks[event];
    assert.equal(group.length, 1);
    assert.equal(group[0].hooks[0].type, 'command');
    assert.equal(
      group[0].hooks[0].command,
      `NODE_COMPILE_CACHE="$CLAUDE_PROJECT_DIR/.krn/cache/node" node "$CLAUDE_PROJECT_DIR/scripts/claude/${file}.ts"`,
    );
    assert.ok(existsSync(new URL(`scripts/claude/${file}.ts`, root)));
  }
  assert.equal(settings.hooks.PostToolUse[0].matcher, '*');
  assert.equal(
    settings.hooks.SessionStart[0].matcher,
    'startup|resume|clear|compact',
  );
  const guard = settings.hooks.PreToolUse;
  assert.deepEqual(
    guard.map((entry: { matcher: string }) => entry.matcher),
    [
      'Write|Edit',
      'Bash',
      'Agent|Task|Workflow|WebFetch|WebSearch|NotebookEdit|Write|Edit',
    ],
  );
  // The context ceiling refuses tools that start new work past 90%.
  assert.equal(
    guard[2].hooks[0].command,
    'NODE_COMPILE_CACHE="$CLAUDE_PROJECT_DIR/.krn/cache/node" node "$CLAUDE_PROJECT_DIR/scripts/claude/context-gauge.ts"',
  );
  assert.equal(
    guard[0].hooks[0].command,
    'NODE_COMPILE_CACHE="$CLAUDE_PROJECT_DIR/.krn/cache/node" node "$CLAUDE_PROJECT_DIR/scripts/claude/memory-budget.ts"',
  );
  assert.ok(existsSync(new URL('scripts/claude/memory-budget.ts', root)));
  assert.equal(
    guard[1].hooks[0].command,
    'NODE_COMPILE_CACHE="$CLAUDE_PROJECT_DIR/.krn/cache/node" node "$CLAUDE_PROJECT_DIR/scripts/claude/piped-check.ts"',
  );
  assert.equal(settings.hooks.PreCompact, undefined);
  // Pattern kills hit other lanes' processes; agents stop processes by PID.
  assert.deepEqual(settings.permissions.deny, [
    'Bash(pkill -f:*)',
    'Bash(pkill --full:*)',
    'Bash(killall:*)',
  ]);
});
