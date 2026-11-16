import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelSwitchReport } from '../../src/cli/doctor-hooks.ts';
import { recordModelSwitch } from '../../src/hook/model-switch.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const entry = join(root, 'src', 'dispatch', 'main.ts');

// No live capture of a PostModelSwitch payload exists yet: this one is built from the documented event
// fields (common hook fields plus the model before and after the switch).
const payload = {
  session_id: 'abc123',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp',
  hook_event_name: 'PostModelSwitch',
  from_model: 'claude-fable-5-2',
  to_model: 'claude-opus-4-8',
};

test('the real hook entry writes one from -> to line to the lane run log', () => {
  const project = mkdtempSync(join(tmpdir(), 'model-switch-'));
  try {
    const run = spawnSync(process.execPath, [entry, 'model-switch'], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        KRN_LANE: 'lane-x',
        KRN_HOOK_TIMING_LOG: join(project, 'timing.jsonl'),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = readFileSync(
      join(project, '.krn', 'runs', 'lane-x', 'model-switches.log'),
      'utf8',
    )
      .trim()
      .split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /Z claude-fable-5-2 -> claude-opus-4-8$/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a payload without model names logs unknown and a payload of another event writes nothing', () => {
  const project = mkdtempSync(join(tmpdir(), 'model-switch-'));
  const env = { CLAUDE_PROJECT_DIR: project, KRN_LANE: 'l' };
  try {
    const line = recordModelSwitch(
      JSON.stringify({
        ...payload,
        from_model: undefined,
        to_model: undefined,
      }),
      env,
    );
    assert.match(line, /unknown -> unknown\n$/u);
    assert.throws(() =>
      recordModelSwitch(
        JSON.stringify({ ...payload, hook_event_name: 'PostToolUse' }),
        env,
      ),
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('krn doctor --hooks reports PostModelSwitch wired in the product settings', () => {
  const report = modelSwitchReport(root);
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /PostModelSwitch wired/u);
  assert.equal(modelSwitchReport(tmpdir()).exitCode, 1);
});
