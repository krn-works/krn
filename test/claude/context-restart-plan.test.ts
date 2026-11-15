import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: the real SessionStart hook script in a real git repository (ADR 0024, S1).
const hook = fileURLToPath(
  new URL('../../scripts/claude/context-restart.ts', import.meta.url),
);
const repo = fileURLToPath(new URL('../..', import.meta.url));

const plan = [
  '# KRN plan',
  '',
  '- [S1 t-aaaaaa1] First slice — Outcome: one — Proof: `x: pass`',
  '- [S2 t-bbbbbb2] Second slice — Outcome: two — Proof: `y: pass`',
  '',
].join('\n');

function fixture(handoffTask: string): string {
  const root = mkdtempSync(join(tmpdir(), 'restart-plan-'));
  assert.equal(
    spawnSync('git', ['init', '-b', 'fixture'], { cwd: root }).status,
    0,
  );
  const commit = spawnSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    ],
    { cwd: root },
  );
  assert.equal(commit.status, 0);
  mkdirSync(join(root, 'docs/program'), { recursive: true });
  writeFileSync(join(root, 'docs/program/plan.md'), plan);
  mkdirSync(join(root, '.krn/runs/lead'), { recursive: true });
  writeFileSync(
    join(root, '.krn/runs/lead/handoff.md'),
    `## Resume\n- Task: ${handoffTask}\n- Verify: \`true\`\n`,
  );
  return root;
}

function sessionStart(root: string): string {
  const result = spawnSync(process.execPath, [hook], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      GIT_CEILING_DIRECTORIES: dirname(root),
    },
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 's',
      transcript_path: join(root, 't'),
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

test('session start injects plan.md@<hash> and the resume task slice line', () => {
  const root = fixture('t-bbbbbb2');
  try {
    const text = sessionStart(root);
    const hash = createHash('sha256').update(plan).digest('hex').slice(0, 12);
    assert.ok(text.includes(`Plan: docs/program/plan.md@${hash}`), text);
    assert.ok(text.includes('Slice: - [S2 t-bbbbbb2] Second slice'), text);
    assert.ok(!text.includes('First slice'), 'only the current slice line');
    assert.ok(!text.includes('# KRN plan'), 'a pointer, never the plan text');
    assert.doesNotMatch(text, /^Disk:/mu, 'disk lines leave the context');
    assert.doesNotMatch(
      text,
      /^Hidden:/mu,
      'stale claim lines leave the context',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resume task without a slice line still gets the plan pointer', () => {
  const root = fixture('t-ccccccc');
  try {
    const text = sessionStart(root);
    assert.match(text, /^Plan: docs\/program\/plan\.md@[0-9a-f]{12}/mu);
    assert.doesNotMatch(text, /^Slice:/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the capability index, its generator and its hook are gone', () => {
  for (const path of [
    'docs/generated/capability-index.md',
    'scripts/claude/capability-index.ts',
  ])
    assert.ok(!existsSync(join(repo, path)), path);
  const settings = readFileSync(join(repo, '.claude/settings.json'), 'utf8');
  assert.ok(!settings.includes('capability-index'));
});
