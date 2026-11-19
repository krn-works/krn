import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  incidentRecords,
  judgePrinciple,
} from '../../src/brain/principle-check.ts';
import { parseProposal } from '../../src/brain/proposals.ts';
import { StandardsDataError } from '../../src/brain/standards.ts';

const incident =
  "When you explain why a lane's Stop or standards check did not run, first prove that a session ran: the lane line shows cost and turns, and the worktree's .krn/runs/hook/timing.jsonl holds a Stop entry near the run time. No cost or turns means no session ran; no Stop entry means Stop never ran. Name that cause, never a Stop condition such as recordedShip.";
const principle =
  'Before you state the cause of a failure, verify the fact that cause depends on.';
const evidence = [
  'evals/replay/agent-replay-cases.ts#stop-attribution-unchecked',
];

function proposal(text: string) {
  return { text, kind: 'prose', evidence, recorded_at: '2026-11-19' };
}

test('a proposal that retells one incident is refused with the remedy', () => {
  assert.throws(
    () => parseProposal(proposal(incident)),
    (error) =>
      error instanceof StandardsDataError &&
      /one incident/u.test(error.message) &&
      /general principle/u.test(error.message) &&
      /evidence/u.test(error.message),
  );
});

test('the principle form of the same lesson is accepted', () => {
  assert.equal(parseProposal(proposal(principle)).text, principle);
});

test('legitimate records pass', () => {
  for (const text of [
    'Never pipe a check run into a filter: redirect it to a log, read the exit code, then read the log.',
    'Every integration or forward is tested against its real receiver or a verbatim capture of its output.',
  ])
    assert.deepEqual(judgePrinciple({ text }), { principle: true });
});

test('one pull request number, date or task id is enough to refuse', () => {
  for (const text of [
    'Keep the lock file in sync, as PR #1484 showed.',
    'Since 2026-11-19 the check must be green.',
    'Close t-nmywj2v by hand.',
  ])
    assert.equal(judgePrinciple({ text }).principle, false, text);
});

test('a check record may name the test it runs', () => {
  assert.deepEqual(
    judgePrinciple({
      text: 'Task status stays with the lead; CI runs test/rules/lane-close-rule.test.ts, which reads .krn/runs/lead/log.jsonl.',
      enforced: true,
    }),
    { principle: true },
  );
});

test('krn standards propose exits 65 for an incident and 0 for its principle', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-principle-'));
  spawnSync('git', ['init', '-q', root]);
  const bin = fileURLToPath(new URL('../../bin/krn', import.meta.url));
  const run = (text: string) =>
    spawnSync(
      bin,
      [
        'standards',
        'propose',
        '--root',
        root,
        '--text',
        text,
        '--kind',
        'prose',
        '--evidence',
        evidence[0] as string,
      ],
      { encoding: 'utf8' },
    );
  const refused = run(incident);
  assert.equal(refused.status, 65, refused.stderr);
  assert.match(refused.stderr, /general principle/u);
  assert.equal(run(principle).status, 0);
});

test('a record whose why retells one incident is flagged even when its text states a principle', () => {
  const why =
    'The lead attributed a skipped Stop to recordedShip without checking that any session ran.';
  assert.deepEqual(
    incidentRecords([
      { id: 'r-x', text: principle, why, provenance: { evidence } },
    ]).map((row) => row.id),
    ['r-x'],
  );
  assert.deepEqual(
    incidentRecords([
      {
        id: 'r-y',
        text: principle,
        why: 'A wrong premise sends the fix to the wrong place.',
      },
    ]),
    [],
  );
});
