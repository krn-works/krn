import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPLAY_CASES } from '../../evals/replay/agent-replay-cases.ts';
import {
  repeats,
  replayEvents,
} from '../../evals/replay/agent-replay-grade.ts';
import { prefixOf, projectSlug } from '../../src/harness/transcript-prefix.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// Three consecutive lines of a recorded lead session, verbatim: a tool result, then the assistant call whose --allow
// names a SKILL.md path the worker scope forbids (the wrong decision of case worker-allow-forbidden-path).
const fixture = readFileSync(
  new URL(
    '../../evals/replay/fixtures/agent-replay/forbidden-allow.jsonl',
    import.meta.url,
  ),
  'utf8',
)
  .trim()
  .split('\n');
const allowCase = REPLAY_CASES.find(
  (c) => c.id === 'worker-allow-forbidden-path',
);

test('the suite dry run lists at least five cases with their cut points and exits 0', () => {
  const r = spawnSync(
    process.execPath,
    ['evals/replay/agent-replay.ts', '--suite', '--dry-run'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.includes('\tcut='));
  assert.ok(lines.length >= 5, r.stdout);
  for (const c of REPLAY_CASES)
    assert.ok(
      lines.some(
        (l) => l.startsWith(`${c.id}\t`) && l.includes(`cut=${c.cut}`),
      ),
    );
});

test('every case records a transcript, a unique cut uuid and a mechanical grader', () => {
  assert.equal(
    new Set(REPLAY_CASES.map((c) => c.id)).size,
    REPLAY_CASES.length,
  );
  for (const c of REPLAY_CASES) {
    assert.match(c.transcript, /^[0-9a-f-]{36}\.jsonl$/u);
    assert.match(c.cutUuid, /^[0-9a-f-]{36}$/u);
    assert.doesNotThrow(() => new RegExp(c.grader.pattern, 'iu'));
  }
});

test('a prefix ends on the cut user line, drops later lines and moves to the new session', () => {
  const p = prefixOf(fixture, 0, 'new-session');
  assert.equal(p.lines.length, 1);
  assert.equal(p.cutRole, 'user');
  assert.equal(p.cutUuid, allowCase?.cutUuid);
  assert.equal(JSON.parse(p.lines[0] as string).sessionId, 'new-session');
  const all = prefixOf(fixture, 9);
  assert.equal(all.lines.length, fixture.length);
  assert.equal(
    all.danglingParents,
    1,
    'only the first line names a parent outside the excerpt',
  );
});

test('a prefix skips lines without a uuid and sidechain lines', () => {
  const lines = [
    '{"type":"api-request-blob","hash":"x"}',
    '{"type":"user","uuid":"a","parentUuid":null,"message":{"role":"user","content":"hi"}}',
    '{"type":"user","uuid":"b","parentUuid":"a","isSidechain":true,"message":{"role":"user","content":"side"}}',
    '{"type":"assistant","uuid":"c","parentUuid":"a","message":{"role":"assistant","content":[]}}',
  ];
  const p = prefixOf(lines, 3);
  assert.equal(p.lines.length, 2);
  assert.equal(p.messages, 2);
  assert.equal(p.danglingParents, 0);
  assert.equal(projectSlug('/a/b.c'), '-a-b-c');
});

test('the recorded wrong assistant call repeats, a corrected call does not', () => {
  assert.ok(allowCase);
  const recorded = replayEvents(fixture.join('\n'));
  assert.ok(recorded.some((e) => e.kind === 'tool'));
  assert.equal(repeats(allowCase.grader, recorded), true);
  assert.equal(
    repeats(allowCase.grader, [
      {
        kind: 'tool',
        text: 'krn worker start --allow src/a.ts --allow test/a.test.ts',
      },
    ]),
    false,
  );
});

test('a check before the decision clears it, and the plainest event list grades', () => {
  const g = {
    on: 'tool',
    pattern: 'repos/\\S+/transfer',
    unlessBefore: 'collaborators',
  } as const;
  const move = {
    kind: 'tool',
    text: 'gh api -X POST repos/o/r/transfer -f new_owner=x',
  } as const;
  assert.equal(repeats(g, [move]), true);
  assert.equal(
    repeats(g, [
      { kind: 'tool', text: 'gh api repos/o/r/collaborators' },
      move,
    ]),
    false,
  );
  assert.equal(
    repeats(g, [
      move,
      { kind: 'tool', text: 'gh api repos/o/r/collaborators' },
    ]),
    true,
  );
  const t = { on: 'text', pattern: 'recordedShip' } as const;
  assert.equal(repeats(t, [{ kind: 'tool', text: 'recordedShip' }]), false);
  assert.equal(
    repeats(t, [{ kind: 'text', text: 'Because recordedShip ended it.' }]),
    true,
  );
});

test('stream-json assistant events and transcript lines yield the same events', () => {
  const stream = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  assert.deepEqual(replayEvents(stream), [
    { kind: 'text', text: 'hi' },
    { kind: 'tool', text: 'ls' },
  ]);
  assert.deepEqual(replayEvents('not json\n{"type":"result"}'), []);
});
