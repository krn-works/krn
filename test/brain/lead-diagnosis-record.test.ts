import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { REPLAY_CASES } from '../../evals/replay/agent-replay-cases.ts';
import { parseUnified } from '../../src/brain/record.ts';
import {
  editRecords,
  laneCandidates,
  lanePacket,
} from '../../src/brain/worker-packet.ts';

const root = new URL('../../', import.meta.url).pathname;
const ID = 'r-stop-skip-needs-session-proof';
const asOf = '2026-11-19';

test('the Stop-attribution record carries its operator evidence and the replayed case names its subject', () => {
  const record = parseUnified(
    JSON.parse(readFileSync(`${root}.agents/records.json`, 'utf8')),
  ).find((r) => r.id === ID);
  assert.ok(record, 'the repository records hold it');
  assert.equal(record.evidence_kind, 'operator-verbatim');
  assert.equal(record.status, 'accepted');
  assert.equal(record.audience, 'lead');
  assert.ok(
    record.provenance.evidence.some((e) => e.includes('20ca9bff')),
    'evidence cites the recorded transcript',
  );
  const replayed = REPLAY_CASES.find(
    (c) => c.id === 'stop-attribution-unchecked',
  );
  assert.ok(replayed?.transcript.startsWith('20ca9bff'));
});

test('a lead record is served in a lead packet and never in a worker packet', () => {
  assert.ok(!laneCandidates(root, 'worker').some((r) => r.id === ID));
  const brief =
    'why did Stop skip the standards check in a lane: ship recordedShip timing session ran';
  const lead = lanePacket(
    root,
    brief,
    asOf,
    't-example',
    undefined,
    false,
    'lead',
  );
  assert.ok(
    lead?.records.includes(ID),
    'the lead packet serves it for a Stop diagnosis',
  );
  const worker = lanePacket(
    root,
    brief,
    asOf,
    't-example',
    undefined,
    false,
    'worker',
  );
  assert.ok(!worker?.records.includes(ID));
});

test('the edit moment never serves the lead record, even for the file it names', () => {
  const served = editRecords(root, 'src/hook/stop.ts', asOf).map((r) => r.id);
  assert.ok(!served.includes(ID));
});
