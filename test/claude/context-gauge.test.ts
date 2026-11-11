import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Fixtures are Claude Code transcript lines captured from a lead session:
// message content arrays are elided and cwd is redacted to '.', every other
// field, including message.usage, is verbatim.

const script = fileURLToPath(
  new URL('../../scripts/claude/context-gauge.ts', import.meta.url),
);
const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), 'utf8');

test('gauge exports a pure last main-chain context reader', async () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const module = await import(script);
  assert.equal(typeof module.contextTotal, 'function');
  for (const [name, total] of [
    ['below', 95053],
    ['warn', 121481],
    ['second', 163398],
  ] as const) {
    assert.equal(module.contextTotal(fixture(name)), total);
  }
  assert.equal(
    module.contextTotal(`${fixture('second')}\n${fixture('below')}`),
    95053,
  );
});

test('gauge caps its advisories at 150k and 200k of a 400k window', async () => {
  const { advisoriesOf } = await import(script);
  assert.deepEqual(advisoriesOf(400000), { first: 150000, second: 200000 });
  assert.deepEqual(advisoriesOf(200000), { first: 120000, second: 160000 });
  // The project window stays 400k; a 163k captured reading already advises.
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  try {
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ autoCompactWindow: 400000 }),
    );
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, fixture('second'));
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Context at 163k of 400k\. Finish the current step, then run krn-handoff\./u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge hook advises once per threshold and re-arms after compaction', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  const run = (text: string, event = 'PostToolUse') => {
    writeFileSync(transcript, text);
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: event,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (result.stdout)
      assert.equal(
        JSON.parse(result.stdout).hookSpecificOutput.hookEventName,
        event,
      );
    return result.stdout;
  };
  try {
    assert.equal(run(fixture('below')), '');
    assert.match(
      run(fixture('warn'), 'UserPromptSubmit'),
      /Context at 121k of 200k\. Finish the current step, then run krn-handoff\./u,
    );
    assert.equal(run(fixture('warn')), '');
    assert.match(run(fixture('second')), /163k.*200k.*krn-handoff/u);
    assert.equal(run(fixture('second')), '');
    assert.equal(run(fixture('compact-boundary')), '');
    assert.match(run(fixture('warn')), /121k/u);
    assert.match(run(fixture('second')), /163k/u);
    // A second compaction followed directly by a reading above 120k re-arms
    // too; derived from the captured boundary by changing its uuid only.
    const captured = JSON.parse(
      fixture('compact-boundary').split('\n')[0] ?? '',
    );
    const boundary = JSON.stringify({ ...captured, uuid: 'second-compaction' });
    assert.match(run(`${boundary}\n${fixture('warn')}`), /121k/u);
    assert.equal(run(`${boundary}\n${fixture('warn')}`), '');
    // A partial last line from the transcript writer does not hide the reading.
    assert.match(
      run(`${boundary}\n${fixture('second')}\n{"type":"assi`),
      /163k/u,
    );
    // A compaction whose boundary already left the read window still re-arms:
    // context drops from 163k to 121k with no boundary line in the transcript.
    assert.match(run(fixture('warn')), /121k/u);
    assert.equal(run(fixture('warn')), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge hook gives both advisories when one reading passes both thresholds', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  try {
    writeFileSync(transcript, fixture('second'));
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      text,
      /163k of 200k\. Finish the current step, then run krn-handoff\./u,
    );
    assert.match(text, /nearly exhausted/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge hook fails silently for malformed, missing and sidechain inputs', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  };
  const input = JSON.stringify({
    session_id: 'session',
    transcript_path: transcript,
    hook_event_name: 'PostToolUse',
  });
  try {
    run(input); // missing file
    run('{');
    run('{}');
    writeFileSync(transcript, '{malformed line\n');
    run(input);
    // Derived from the verbatim warn capture by flipping isSidechain only.
    writeFileSync(
      transcript,
      fixture('warn').replaceAll('"isSidechain": false', '"isSidechain": true'),
    );
    run(input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge reads only the final 256 KiB and skips the partial first line', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  try {
    // Malformed old data is outside the read window; the long user line straddles it.
    writeFileSync(
      transcript,
      `malformed old line\n${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(270000) } })}\n${fixture('warn')}`,
    );
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /121k of 200k/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge budget follows the project auto-compact window and ignores the measured baseline', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  const settings = join(root, '.claude/settings.json');
  // Derived from the verbatim below capture by changing the usage counters
  // only. 47,144 is the first-turn context of a lead session measured on
  // 2026-11-01 (interactive lead sessions started at 46.0k-47.7k).
  const reading = (total: number) => {
    const entry = JSON.parse(fixture('below').split('\n')[0] ?? '');
    entry.message.usage = {
      ...entry.message.usage,
      input_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: total - 2,
    };
    return `${JSON.stringify(entry)}\n`;
  };
  const run = (text: string, session = 'session') => {
    writeFileSync(transcript, text);
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: session,
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  try {
    assert.equal(run(reading(47144), 'default'), '');
    mkdirSync(join(root, '.claude'));
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 200000 }));
    assert.equal(run(reading(47144), 'configured'), '');
    assert.match(run(fixture('warn'), 'configured'), /121k of 200k/u);
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 300000 }));
    assert.equal(run(reading(47144), 'wide'), '');
    assert.equal(run(fixture('warn'), 'wide'), '');
    // 60% of 300k is 180k, so the 150k cap moves the first advisory down.
    assert.match(
      run(fixture('second'), 'wide'),
      /^\{.*Context at 163k of 300k\. Finish the current step, then run krn-handoff\."/u,
    );
    assert.equal(run(reading(181000), 'wide'), '');
    assert.match(
      run(reading(201000), 'wide'),
      /201k of 300k.*nearly exhausted/u,
    );
    // An invalid window fails open without a misleading advisory.
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: '200000' }));
    assert.equal(run(fixture('second'), 'invalid'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge repeats the advisory past the second threshold and refuses new work past the ceiling', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  // Derived from the verbatim below capture by changing the usage counters only.
  const reading = (total: number) => {
    const entry = JSON.parse(fixture('below').split('\n')[0] ?? '');
    entry.message.usage = {
      ...entry.message.usage,
      input_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: total - 2,
    };
    return `${JSON.stringify(entry)}\n`;
  };
  const run = (
    total: number,
    event: string,
    tool: object = {},
    sessionClass = '',
  ) => {
    writeFileSync(transcript, reading(total));
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        HOME: root,
        KRN_SESSION_CLASS: sessionClass,
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: event,
        ...tool,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const deny = (total: number, tool_name: string, tool_input: object = {}) => {
    const out = run(total, 'PreToolUse', { tool_name, tool_input });
    if (!out) return false;
    const output = JSON.parse(out).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /ceiling.*krn-handoff/u);
    return true;
  };
  try {
    // A headless lane session cannot hand off, so the ceiling never refuses it.
    assert.equal(
      run(
        190000,
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        'lane',
      ),
      '',
    );
    assert.equal(deny(190000, 'Bash', { command: 'ls' }), true);
    // Default 200k budget: second threshold 160k, ceiling 180k.
    assert.match(run(161000, 'PostToolUse'), /nearly exhausted/u);
    assert.equal(run(165000, 'PostToolUse'), '');
    assert.match(
      run(171000, 'PostToolUse'),
      /171k of 200k, still past the handoff advisory.*180k new work is refused/u,
    );
    assert.equal(run(175000, 'PostToolUse'), '');
    assert.match(run(181000, 'PostToolUse'), /181k/u);
    assert.equal(deny(179000, 'Agent'), false);
    for (const tool of ['Agent', 'Task', 'Workflow', 'WebFetch', 'WebSearch'])
      assert.equal(deny(181000, tool), true, tool);
    for (const tool of ['Glob', 'Grep', 'mcp__x__y'])
      assert.equal(deny(181000, tool), true, tool);
    assert.equal(deny(181000, 'Skill'), false);
    // Bash runs only commands built from handoff commands.
    for (const command of [
      'git push',
      'cd /p && krn state check --root . && git status --short',
      'bin/krn task show t-1; echo done',
      'node scripts/claude/handoff-requests.ts .krn/runs/x/handoff.md',
      'CLAUDECODE= node scripts/claude/successor-launch.ts --retire',
    ])
      assert.equal(deny(181000, 'Bash', { command }), false, command);
    for (const command of [
      'npm run fast',
      'git log | grep x',
      'cat src/a.ts',
      'echo $(cat src/a.ts)',
      'node scripts/build.ts',
      '',
    ])
      assert.equal(deny(181000, 'Bash', { command }), true, command);
    assert.equal(deny(181000, 'Bash'), true);
    // Read is open under agent state and memory, bounded elsewhere.
    assert.equal(deny(181000, 'Read', { file_path: 'src/a.ts' }), true);
    assert.equal(
      deny(181000, 'Read', { file_path: 'src/a.ts', limit: 200 }),
      false,
    );
    assert.equal(
      deny(181000, 'Read', { file_path: 'src/a.ts', limit: 201 }),
      true,
    );
    assert.equal(
      deny(181000, 'Read', { file_path: '.krn/runs/x/handoff.md' }),
      false,
    );
    assert.equal(deny(181000, 'Edit', { file_path: 'src/a.ts' }), true);
    assert.equal(
      deny(181000, 'Write', { file_path: join(root, '../a.md') }),
      true,
    );
    assert.equal(
      deny(181000, 'Write', {
        file_path: '.krn/runs/delivery-loop/x/handoff.md',
      }),
      false,
    );
    assert.equal(
      deny(181000, 'Write', {
        file_path: join(root, '.claude/projects/p/memory/MEMORY.md'),
      }),
      false,
    );
    assert.equal(deny(181000, 'Edit', { file_path: '.krn/../src/a.ts' }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host gauge serves every project except one that wires its own gauge', async () => {
  const { handoffBash, refusesAtCeiling } = await import(script);
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-host-'));
  const project = join(root, 'project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const transcript = join(root, 'transcript.jsonl');
  // Derived from the verbatim below capture by changing the usage counters only.
  const entry = JSON.parse(fixture('below').split('\n')[0] ?? '');
  const run = (total: number, event: string, tool: object = {}) => {
    entry.message.usage = {
      ...entry.message.usage,
      input_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: total - 2,
    };
    writeFileSync(transcript, `${JSON.stringify(entry)}\n`);
    const result = spawnSync(process.execPath, [script, '--host'], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        HOME: root,
        XDG_STATE_HOME: join(root, 'state'),
      },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: event,
        prompt: 'p',
        ...tool,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  try {
    // A project without settings gets the 400k default and the relay wording.
    assert.match(
      run(241000, 'PostToolUse'),
      /241k of 400k\. Finish the current step, then hand off with the context-relay skill\./u,
    );
    assert.ok(existsSync(join(root, 'state/krn/context-gauge/session.json')));
    assert.ok(!existsSync(join(project, '.krn')), 'no state in the project');
    run(241000, 'UserPromptSubmit');
    assert.ok(!existsSync(join(project, '.krn')), 'no prompt capture');
    const out = run(361000, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: {},
    });
    assert.match(
      JSON.parse(out).hookSpecificOutput.permissionDecisionReason,
      /360k ceiling of the 400k budget.*context-relay skill/u,
    );
    // A project that wires its own gauge is left to it.
    writeFileSync(
      join(project, '.claude/settings.json'),
      JSON.stringify({
        autoCompactWindow: 400000,
        hooks: { PostToolUse: [{ command: 'node scripts/context-gauge.ts' }] },
      }),
    );
    assert.equal(
      run(361000, 'PreToolUse', { tool_name: 'Agent', tool_input: {} }),
      '',
    );
    assert.equal(run(330000, 'PostToolUse'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // The relay handoff stays open in host mode only.
  for (const command of [
    'python3 ~/.claude/skills/context-relay/scripts/context-usage.py',
    '~/.claude/skills/context-relay/scripts/relay.sh docs/X-PROMPT.md lead-2',
    'herdr agent get lead-2 && bd update x-1 --status done',
  ]) {
    assert.equal(handoffBash(command, true), true, command);
    assert.equal(handoffBash(command), false, command);
  }
  assert.equal(handoffBash('herdr x; npm test', true), false);
  for (const file of ['docs/EKO-CLAUDE-CODE-PROMPT.md', 'docs/handoff.md']) {
    assert.equal(
      refusesAtCeiling('Write', { file_path: file }, '/p', true),
      false,
    );
    assert.equal(refusesAtCeiling('Write', { file_path: file }, '/p'), true);
  }
  assert.equal(
    refusesAtCeiling('Edit', { file_path: 'src/prompt.ts' }, '/p', true),
    true,
  );
});
