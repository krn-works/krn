import assert from 'node:assert/strict';
import test from 'node:test';
import {
  packetIds,
  proposeEdit,
  type RecordedLane,
  renderVerdict,
  replayProposal,
} from '../../src/brain/lane-proposal.ts';
import type { BrainRecord } from '../../src/brain/packet.ts';

const record = (id: string, text: string): BrainRecord => ({
  id,
  type: 'rule',
  text,
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
  source: 'test',
});

const records = [
  record('r-notes', 'Keep agent notes under .krn/ and never in tracked files.'),
  record('r-style', 'Format the parser module with biome before committing.'),
];

const lane = (over: Partial<RecordedLane>): RecordedLane => ({
  task: 'parser-1',
  arm: 'A',
  template: 'agent-state',
  rule: 'r-notes',
  brief: 'Write a parser module and keep notes.\n',
  passed: false,
  reason: 'fail parser-1: state outside .krn/: docs/notes.md',
  packet: '',
  asOf: '2026-02-01',
  budget: 400,
  ...over,
});

test('a failing lane yields one proposal that restates its rule with the failure', () => {
  const proposal = proposeEdit(lane({}), records);
  assert.ok(proposal);
  assert.equal(proposal.record.id, 'r-notes');
  assert.match(proposal.record.text, /state outside \.krn\//u);
  assert.ok(proposal.record.text.length <= (records[0]?.text.length ?? 0));
  assert.equal(proposal.task, 'parser-1');
});

test('a passing lane yields no proposal', () => {
  assert.equal(
    proposeEdit(lane({ passed: true, reason: 'pass' }), records),
    null,
  );
});

test('a rule the repository lacks is proposed as a new record', () => {
  const proposal = proposeEdit(lane({ rule: 'r-new' }), records);
  assert.equal(proposal?.record.id, 'r-new');
  assert.equal(proposal?.record.source, 'lane parser-1');
});

test('the replay accepts an edit that gains on the failing case and drops no rule', () => {
  const failing = lane({});
  const proposal = proposeEdit(failing, records);
  assert.ok(proposal);
  const result = replayProposal(proposal, records, [failing]);
  assert.equal(result.verdict, 'accept');
  assert.equal(result.failingCaseGains, true);
  assert.match(renderVerdict(proposal, result), /verdict=accept/u);
});

test('the replay rejects an edit that pushes a rule out of a passing lane', () => {
  const failing = lane({});
  const proposal = proposeEdit(failing, records);
  assert.ok(proposal);
  const bloated = {
    ...proposal,
    record: {
      ...proposal.record,
      text: `${proposal.record.text} ${'parser module format biome notes '.repeat(46)}`,
    },
  };
  const passing = lane({
    task: 'parser-2',
    brief: 'Write a parser module, keep notes, format with biome.\n',
    arm: 'B',
    passed: true,
    reason: 'pass',
    packet: records.map((r) => `- [${r.id}] ${r.text}`).join('\n'),
  });
  assert.deepEqual(packetIds(passing.packet), ['r-notes', 'r-style']);
  const result = replayProposal(bloated, records, [failing, passing]);
  assert.deepEqual(result.regressions, ['parser-2']);
  assert.equal(result.verdict, 'reject');
});

test('the replay rejects an edit that does not reach the failing case', () => {
  const failing = lane({ brief: 'Unrelated text zzz.\n' });
  const proposal = proposeEdit(failing, records);
  assert.ok(proposal);
  const result = replayProposal(proposal, records, [failing]);
  assert.equal(result.failingCaseGains, false);
  assert.equal(result.verdict, 'reject');
});
