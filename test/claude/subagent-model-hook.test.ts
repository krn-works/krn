import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  alias,
  frontmatterModel,
  rewriteNotice,
  updatedInput,
} from '../../scripts/claude/subagent-model.ts';
import { events } from '../../src/dispatch/table.ts';

// Receiver evidence (live, Claude Code 2.1.316, 2026-11-09): `claude -p --model opus`
// spawning Explore with no model ran claude-opus-5-5 without this hook and
// claude-sonnet-5-5 with it, under CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5
// (.krn/runs/token-audit/subagent-model-audit.md).

const script = fileURLToPath(
  new URL('../../scripts/claude/subagent-model.ts', import.meta.url),
);
const call = (input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: input,
});

test('Explore and Plan without a model get the configured subagent alias', () => {
  for (const subagent_type of ['Explore', 'Plan']) {
    assert.deepEqual(
      updatedInput(call({ subagent_type, prompt: 'p' }), 'claude-sonnet-5-5'),
      { subagent_type, prompt: 'p', model: 'sonnet' },
    );
  }
  assert.equal(alias('haiku'), 'haiku');
  assert.equal(alias('claude-fable-5-1'), 'fable');
  assert.equal(alias('custom-model'), undefined);
});

test('explicit models, other agent types and an unset variable stay untouched', () => {
  const env = 'sonnet';
  assert.equal(
    updatedInput(call({ subagent_type: 'Explore', model: 'opus' }), env),
    undefined,
  );
  for (const subagent_type of ['fork', 'krn-reader'])
    assert.equal(updatedInput(call({ subagent_type }), env), undefined);
  assert.equal(updatedInput(call({ prompt: 'p' }), env), undefined);
  assert.equal(
    updatedInput(call({ subagent_type: 'Explore' }), undefined),
    undefined,
  );
  assert.equal(updatedInput(null, env), undefined);
});

test('the hook prints updatedInput and stays silent otherwise', () => {
  const run = (input: Record<string, unknown>) =>
    spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      input: JSON.stringify(call(input)),
      env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' },
    });
  const filled = run({ subagent_type: 'Explore', prompt: 'p' });
  assert.equal(filled.status, 0);
  assert.deepEqual(JSON.parse(filled.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { subagent_type: 'Explore', prompt: 'p', model: 'sonnet' },
    },
  });
  const silent = run({ subagent_type: 'fork' });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '');
});

test('the hook table runs the hook before every Agent call', () => {
  const route = events['pre-tool'].routes.find(
    (candidate) => candidate.name === 'subagent-model',
  );
  assert.ok(route?.tools?.split('|').includes('Agent'));
});

test('general-purpose lanes are routed to krn-lane, which carries a turn ceiling', () => {
  assert.deepEqual(
    updatedInput(
      call({ subagent_type: 'general-purpose', prompt: 'p' }),
      undefined,
    ),
    { subagent_type: 'krn-lane', prompt: 'p' },
  );
  const agent = readFileSync(
    fileURLToPath(new URL('../../.claude/agents/krn-lane.md', import.meta.url)),
    'utf8',
  );
  const turns = Number(/^maxTurns:\s*(\d+)/m.exec(agent)?.[1]);
  assert.ok(turns >= 60 && turns <= 90, 'krn-lane needs maxTurns of 60 to 90');
  assert.ok(!/^tools:/m.test(agent), 'krn-lane keeps the full tool set');
});

test('a non-lane call with an explicit model is never rerouted or changed', () => {
  const pinned = () => 'haiku';
  for (const subagent_type of ['krn-reader', 'Explore', 'fork'])
    assert.equal(
      updatedInput(
        call({ subagent_type, model: 'opus', prompt: 'p' }),
        'sonnet',
        pinned,
      ),
      undefined,
    );
});

test('the hook fills the model from agent frontmatter when the call has none', () => {
  const agents = fileURLToPath(
    new URL('../../.claude/agents', import.meta.url),
  );
  assert.equal(frontmatterModel(agents, 'krn-reader'), 'haiku');
  assert.equal(frontmatterModel(agents, 'no-such-agent'), undefined);
  assert.equal(frontmatterModel(agents, '../settings'), undefined);
  const pinned = (type: string) => frontmatterModel(agents, type);
  assert.deepEqual(
    updatedInput(
      call({ subagent_type: 'krn-reader', prompt: 'p' }),
      'sonnet',
      pinned,
    ),
    { subagent_type: 'krn-reader', prompt: 'p', model: 'haiku' },
  );
  // general-purpose is rerouted to krn-lane and takes krn-lane's pinned model
  assert.deepEqual(
    updatedInput(
      call({ subagent_type: 'general-purpose', prompt: 'p' }),
      undefined,
      (type) => (type === 'krn-lane' ? 'sonnet' : undefined),
    ),
    { subagent_type: 'krn-lane', prompt: 'p', model: 'sonnet' },
  );
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify(call({ subagent_type: 'krn-reader', prompt: 'p' })),
    env: {
      ...process.env,
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5',
      CLAUDE_PROJECT_DIR: fileURLToPath(new URL('../..', import.meta.url)),
    },
  });
  assert.equal(run.status, 0);
  assert.equal(
    JSON.parse(run.stdout).hookSpecificOutput.updatedInput.model,
    'haiku',
  );
});

test('a lane call naming opus or fable runs the pinned lane model unless the prompt opts in', () => {
  const pinned = (type: string) => (type === 'krn-lane' ? 'sonnet' : undefined);
  for (const subagent_type of ['krn-lane', 'general-purpose'])
    for (const model of ['opus', 'claude-fable-5-2'])
      assert.deepEqual(
        updatedInput(
          call({ subagent_type, model, prompt: 'p' }),
          undefined,
          pinned,
        ),
        { subagent_type: 'krn-lane', model: 'sonnet', prompt: 'p' },
      );
  const optIn = 'Brief\nlane-model: opus\nrest';
  assert.equal(
    updatedInput(
      call({ subagent_type: 'krn-lane', model: 'opus', prompt: optIn }),
      undefined,
      pinned,
    ),
    undefined,
  );
  assert.equal(
    updatedInput(
      call({ subagent_type: 'krn-lane', model: 'haiku', prompt: 'p' }),
      undefined,
      pinned,
    ),
    undefined,
  );
  assert.deepEqual(
    updatedInput(
      call({ subagent_type: 'krn-lane', model: 'fable', prompt: optIn }),
      'claude-sonnet-5-5',
    ),
    { subagent_type: 'krn-lane', model: 'sonnet', prompt: optIn },
  );
});

test('a lane model rewrite prints a notice naming asked model, run model and the opt-in', () => {
  const payload = call({
    subagent_type: 'krn-lane',
    model: 'opus',
    prompt: 'p',
  });
  const run = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fileURLToPath(new URL('../..', import.meta.url)),
    },
  });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert.match(out.systemMessage, /asked model opus/);
  assert.match(out.systemMessage, /runs sonnet/);
  assert.match(out.systemMessage, /lane-model: opus/);
  assert.equal(
    rewriteNotice(
      call({ subagent_type: 'krn-lane', model: 'opus', prompt: 'p' }),
      { subagent_type: 'krn-lane', model: 'opus' },
    ),
    undefined,
  );
});

test('a live krn-lane call naming opus recorded the pinned model in its transcript', () => {
  const turns = readFileSync(
    fileURLToPath(
      new URL('./fixtures/lane-opus-call-transcript.jsonl', import.meta.url),
    ),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(turns.length >= 2);
  for (const turn of turns)
    assert.equal(turn.message.model, 'claude-sonnet-5-5');
});

test('a lane brief with lane-model: opus, inline or behind a pointer file, runs the lane on opus', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  mkdirSync(join(root, '.krn', 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(root, '.krn', 'tmp', 'lane-model-'));
  try {
    const file = join(dir, 'brief.prompt');
    writeFileSync(file, 'Repository conventions\nlane-model: opus\nTask\n');
    const plain = join(dir, 'plain.prompt');
    writeFileSync(plain, 'Task without an opt-in line\n');
    const pointer = (path: string) =>
      `Your complete brief is the file ${path}. Read it in full first.`;
    const run = (input: Record<string, unknown>) => {
      const out = spawnSync(process.execPath, [script], {
        input: JSON.stringify(call(input)),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
      assert.equal(out.status, 0);
      return out.stdout
        ? JSON.parse(out.stdout).hookSpecificOutput.updatedInput.model
        : undefined;
    };
    for (const subagent_type of ['krn-lane', 'general-purpose'])
      for (const prompt of [pointer(file), 'Brief\nlane-model: opus\nrest']) {
        assert.equal(run({ subagent_type, prompt }), 'opus');
        assert.notEqual(
          run({ subagent_type, prompt, model: 'opus' }),
          'sonnet',
        );
      }
    assert.equal(
      run({ subagent_type: 'krn-lane', model: 'opus', prompt: pointer(plain) }),
      'sonnet',
    );
    assert.equal(
      run({
        subagent_type: 'krn-lane',
        model: 'opus',
        prompt: pointer('/etc/hostname'),
      }),
      'sonnet',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
