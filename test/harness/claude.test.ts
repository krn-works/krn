import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  configHome,
  headlessArgs,
  hookInput,
  laneBinary,
  projectPath,
  projectRelative,
  usageOf,
  userStateFile,
} from '../../src/harness/claude.ts';

test('a headless lane run passes the brief, settings, models and budget as claude -p flags', () => {
  assert.deepEqual(
    headlessArgs({
      brief: 'do it',
      settings: '/s.json',
      model: 'opus',
      fallbackModel: 'sonnet',
      budgetUsd: 5,
    }),
    [
      '-p',
      'do it',
      '--output-format',
      'json',
      '--settings',
      '/s.json',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'opus',
      '--fallback-model',
      'sonnet',
      '--max-budget-usd',
      '5',
      '--setting-sources',
      'project',
    ],
  );
});

test('the binary, config home and state file honour their environment overrides', () => {
  assert.equal(laneBinary({}), 'claude');
  assert.equal(laneBinary({ KRN_LANE_CLAUDE: '/stub' }), '/stub');
  assert.equal(configHome({}, '/h'), join('/h', '.claude'));
  assert.equal(configHome({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c');
  assert.equal(
    userStateFile({ CLAUDE_CONFIG_DIR: '/c' }),
    join('/c', '.claude.json'),
  );
  assert.equal(projectPath('/r', 'settings.json'), '/r/.claude/settings.json');
  assert.equal(projectRelative('skills'), '.claude/skills');
});

test('the hook codec decodes a SessionStart payload and refuses another event', () => {
  const raw = JSON.stringify({
    session_id: 'abc-1',
    transcript_path: '/t.jsonl',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const env = { CLAUDE_PROJECT_DIR: '/p' };
  assert.deepEqual(hookInput(['SessionStart'], raw, env), {
    sessionId: 'abc-1',
    transcriptPath: '/t.jsonl',
    event: 'SessionStart',
    project: '/p',
    source: 'startup',
  });
  assert.throws(() => hookInput(['Stop'], raw, env), /Invalid hook input/u);
  assert.throws(() => hookInput(['SessionStart'], raw, {}), /Invalid/u);
});

test('the usage normaliser splits cache writes by lifetime and zeroes malformed counters', () => {
  assert.deepEqual(
    usageOf({
      input_tokens: 3,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_1h_input_tokens: 2 },
      output_tokens: -1,
    }),
    { input: 3, cacheRead: 10, cacheWrite5m: 5, cacheWrite1h: 2, output: 0 },
  );
});
