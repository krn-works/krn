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
import {
  advisory,
  codexReading,
  sessionStartSources,
} from '../../scripts/codex/context-hook.ts';

const script = fileURLToPath(
  new URL('../../scripts/codex/context-hook.ts', import.meta.url),
);
const fixtures = new URL('../fixtures/codex-hooks/', import.meta.url);
// A verbatim SessionStart payload captured from codex-cli 0.167.0, with paths
// replaced by placeholders; the rollout holds verbatim token_count and
// compacted lines of real sessions without rate limits or history bodies.
const sessionStart = JSON.parse(
  readFileSync(new URL('session-start.json', fixtures), 'utf8'),
);
const rollout = readFileSync(new URL('rollout.jsonl', fixtures), 'utf8')
  .trim()
  .split('\n');

function fixtureProject(managed = true) {
  const root = mkdtempSync(join(tmpdir(), 'codex-hook-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-b', 'fixture']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  writeFileSync(
    join(root, 'AGENTS.md'),
    managed ? '<!-- krn-agent-workflow:start -->\n' : 'plain\n',
  );
  return root;
}

function run(
  root: string,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  const result = spawnSync('node', [script], {
    input: JSON.stringify({ ...sessionStart, cwd: root, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...extra },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('the gauge reads the last request, never the cumulative session sum', () => {
  const before = codexReading(rollout.slice(0, 2).join('\n'));
  assert.equal(before.total, 244840);
  assert.equal(before.window, 258400);
  assert.equal(before.boundary, undefined);
  const after = codexReading(rollout.join('\n'));
  assert.equal(after.total, 16035, 'post-compaction estimate, not 17.5M');
  assert.ok(after.boundary);
});

test('advisories fire once per level and re-arm after compaction', () => {
  const state = { highest: 0 } as Parameters<typeof advisory>[1];
  const reading = (total: number, boundary?: string) => ({
    total,
    window: 475000,
    boundary,
    reason: undefined,
  });
  assert.equal(advisory(reading(90000), state), undefined);
  const first = advisory(reading(125000), state);
  assert.match(
    first ?? '',
    /125k \(KRN advisory 120k\/160k; model window 475k\)/,
  );
  assert.equal(advisory(reading(130000), state), undefined);
  assert.match(advisory(reading(165000), state) ?? '', /nearly exhausted/);
  assert.equal(advisory(reading(170000), state), undefined);
  assert.equal(advisory(reading(20000, 'w1'), state), undefined);
  assert.match(advisory(reading(125000, 'w1'), state) ?? '', /125k/);
  const missing = { total: undefined, window: undefined, boundary: undefined };
  const down = advisory({ ...missing, reason: 'rollout unreadable' }, state);
  assert.match(down ?? '', /gauge unavailable: rollout unreadable/);
  assert.equal(
    advisory({ ...missing, reason: 'rollout unreadable' }, state),
    undefined,
  );
  assert.equal(advisory({ ...missing, reason: undefined }, state), undefined);
});

test('the hook gauges a real rollout once and stays silent after compaction', () => {
  const root = fixtureProject();
  try {
    const transcript = join(root, 'rollout.jsonl');
    writeFileSync(transcript, `${rollout.slice(0, 2).join('\n')}\n`);
    const payload = {
      hook_event_name: 'PostToolUse',
      transcript_path: transcript,
    };
    const output = JSON.parse(run(root, payload));
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /^Context at 244k/,
    );
    assert.equal(run(root, payload), '', 'deduplicated');
    writeFileSync(transcript, `${rollout.join('\n')}\n`);
    assert.equal(run(root, payload), '', 'compacted context is small');
    const state = JSON.parse(
      readFileSync(
        join(
          root,
          `.krn/runs/codex/context-gauge/${sessionStart.session_id}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(state.highest, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SessionStart restores state and bounds an oversized block with a marker', () => {
  const root = fixtureProject();
  try {
    const small = JSON.parse(run(root, {}));
    assert.equal(small.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(
      small.hookSpecificOutput.additionalContext,
      /^Branch: fixture/,
    );
    mkdirSync(join(root, '.krn/task-claims'), { recursive: true });
    for (let index = 0; index < 60; index++)
      writeFileSync(
        join(root, `.krn/task-claims/c${index}.json`),
        JSON.stringify({
          id: `claim-${index}`,
          actor: 'lead',
          branch: 'b'.repeat(100),
        }),
      );
    const raw = run(root, { source: 'compact' });
    assert.ok(
      Buffer.byteLength(raw) <= 4096,
      `${Buffer.byteLength(raw)} bytes`,
    );
    const text = JSON.parse(raw).hookSpecificOutput.additionalContext;
    assert.match(text, /^Branch: fixture/);
    assert.match(text, /\[truncated: restart block exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resume and a compact source in one turn inject the restart block once', () => {
  const root = fixtureProject();
  try {
    // The rollout holds a real compacted line, as when `codex exec resume`
    // auto-compacts before its first turn and Codex drains resume then compact.
    const transcript = join(root, 'rollout.jsonl');
    writeFileSync(transcript, `${rollout.join('\n')}\n`);
    const payload = (source: string) => ({
      source,
      transcript_path: transcript,
    });
    assert.match(run(root, payload('resume')), /Branch: fixture/);
    assert.equal(run(root, payload('compact')), '', 'same turn, same block');
    assert.match(run(root, payload('fork')), /Branch: fixture/, 'new history');
    // A later compaction removes the block from context, so it returns.
    writeFileSync(
      transcript,
      `${rollout.join('\n')}\n${JSON.stringify({ timestamp: 'later', type: 'compacted', payload: { window_id: 'next-window' } })}\n`,
    );
    assert.match(run(root, payload('compact')), /Branch: fixture/);
    // Without a readable rollout nothing proves the block is still there.
    const blind = { source: 'compact', transcript_path: join(root, 'gone') };
    assert.match(run(root, blind), /Branch: fixture/);
    assert.match(run(root, blind), /Branch: fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreCompact saves a receipt, prints nothing and never blocks', () => {
  const root = fixtureProject();
  try {
    assert.equal(run(root, { hook_event_name: 'PreCompact' }), '');
    const saved = JSON.parse(
      readFileSync(
        join(
          root,
          `.krn/runs/codex/precompact/${sessionStart.session_id}.json`,
        ),
        'utf8',
      ),
    );
    assert.match(saved.at, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(saved.exit, 0);
    assert.match(saved.head, /^[0-9a-f]{7,}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a work tree without the KRN workflow gets no output and no writes', () => {
  const root = fixtureProject(false);
  try {
    for (const event of ['SessionStart', 'PreCompact', 'PostToolUse'])
      assert.equal(
        run(root, { hook_event_name: event, transcript_path: join(root, 'x') }),
        '',
      );
    assert.equal(existsSync(join(root, '.krn')), false);
    // The runner's temp directory may itself sit inside a checkout.
    const bare = mkdtempSync(join(tmpdir(), 'codex-hook-bare-'));
    try {
      assert.equal(
        run(bare, {}, { GIT_CEILING_DIRECTORIES: tmpdir() }),
        '',
        'not a work tree',
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the project hook definitions call the shipped script for every event', () => {
  const root = new URL('../../', import.meta.url);
  const hooks = JSON.parse(
    readFileSync(new URL('.codex/hooks.json', root), 'utf8'),
  ).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    'PostToolUse',
    'PreCompact',
    'SessionStart',
    'UserPromptSubmit',
  ]);
  for (const groups of Object.values(hooks) as {
    hooks: { command: string }[];
  }[][])
    assert.match(
      groups[0]?.hooks[0]?.command ?? '',
      /scripts\/codex\/context-hook\.ts"$/,
    );
  // Every SessionStart source Codex sends reaches the hook; adding one changes
  // the definition's trusted_hash, so the operator re-trusts it once.
  assert.equal(hooks.SessionStart[0].matcher, sessionStartSources.join('|'));
  assert.ok(existsSync(new URL('scripts/codex/context-hook.ts', root)));
});
