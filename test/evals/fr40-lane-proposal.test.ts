import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  recordedLanes,
  replayFailing,
} from '../../evals/fr40/replay-proposal.ts';
import { brainPacket, parseRecords } from '../../src/brain/packet.ts';

test('the replay rebuilds every recorded arm-B packet byte for byte', () => {
  const records = parseRecords(
    JSON.parse(
      readFileSync(
        new URL('../../evals/fr40/records.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const lanes = recordedLanes().filter((lane) => lane.arm === 'B');
  assert.equal(lanes.length, 133);
  for (const lane of lanes) {
    const packet = brainPacket({
      task: lane.task,
      query: lane.brief,
      records,
      asOf: lane.asOf,
      budget: lane.budget,
    });
    assert.equal(packet.text, lane.packet, lane.task);
  }
});

test('a recorded failing lane is proposed once and the replay gates it on the recordings', () => {
  assert.match(
    replayFailing('fr40-agent-state-groups', 'A'),
    /^proposal r-agent-state from fr40-agent-state-groups: replay lanes=266 regressions=0 gains=\d+ failing-case=gain verdict=accept$/u,
  );
  assert.match(
    replayFailing('fr40-trailer-range', 'A'),
    /regressions=[1-9]\d* .*verdict=reject$/u,
  );
});
