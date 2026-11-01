import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
test('Claude context budget settings wire documented hooks and read-only reader', () => {
  const path = new URL('.claude/settings.json', root);
  assert.ok(existsSync(path), 'project settings exist');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(settings.autoCompactWindow, 200000);
  // KRN uses no claude.ai connector and no rss_news tool; both stay off for
  // every checkout of this project, worktrees included.
  assert.equal(settings.disableClaudeAiConnectors, true);
  assert.deepEqual(settings.deniedMcpServers, [{ serverName: 'rss_news' }]);
  assert.equal(settings.env.BASH_MAX_OUTPUT_LENGTH, '12000');
  assert.equal(settings.env.MAX_MCP_OUTPUT_TOKENS, '8000');
  for (const [event, file] of Object.entries({
    UserPromptSubmit: 'context-gauge',
    PostToolUse: 'context-gauge',
    PreCompact: 'context-precompact',
    SessionStart: 'context-restart',
  })) {
    const group = settings.hooks[event];
    assert.equal(group.length, 1);
    assert.equal(group[0].hooks[0].type, 'command');
    assert.equal(
      group[0].hooks[0].command,
      `node "$CLAUDE_PROJECT_DIR/scripts/claude/${file}.ts"`,
    );
    assert.ok(existsSync(new URL(`scripts/claude/${file}.ts`, root)));
  }
  assert.equal(settings.hooks.PostToolUse[0].matcher, '*');
  assert.equal(
    settings.hooks.SessionStart[0].matcher,
    'startup|resume|compact',
  );
  assert.equal(settings.hooks.PreCompact[0].hooks[0].timeout, 30);
  const reader = readFileSync(
    new URL('.claude/agents/krn-reader.md', root),
    'utf8',
  );
  assert.match(
    reader,
    /^---\nname: krn-reader\nmodel: haiku\ntools: Read, Grep, Glob, Bash\n---/u,
  );
  for (const text of ['read-only', '300 words', 'never edits', 'file paths'])
    assert.ok(reader.includes(text), text);
});
