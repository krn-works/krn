import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { renderRetroCauses } from '../../src/state/retro-causes.ts';
import {
  parseReviewComment,
  readTranscript,
} from '../../src/state/retro-evidence.ts';
import { rankCauses, renderCauses } from '../../src/state/retro-rank.ts';

// Captured, verbatim except host path prefixes masked as <repo> and <tmp> (the host-path guard): two Claude session transcripts (their first prompt and the
// lines naming a refusal or an operator correction) and one krn-review comment
// of PR #1565 (KRN-12: the receiver reads the real output shapes).
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'retro');
const lines = (path: string) => readFileSync(path, 'utf8').split('\n');
const sessionA = lines(join(fixtures, 'session-a.jsonl'));
const sessionB = lines(join(fixtures, 'session-b.jsonl'));
const comment = readFileSync(join(fixtures, 'krn-review-comment.md'), 'utf8');

test('the transcript reader types refusals and operator corrections with pointers', () => {
  const a = readTranscript(sessionA, 'a');
  assert.deepEqual(
    a.map((item) => [item.kind, item.pointer]),
    [
      ['refusal', 'a:2'],
      ['operator-correction', 'a:3'],
    ],
  );
  const b = readTranscript(sessionB, 'b');
  assert.deepEqual(
    b.map((item) => [item.kind, item.pointer, item.subject]),
    [['refusal', 'b:2', 'Blocked: sleep <n>']],
  );
});

test('the review parser keeps every finding with its file:line pointer', () => {
  const items = parseReviewComment(comment, 1565, 2);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.pointer, 'PR#1565:src/lane/manifest.ts:23');
  assert.equal(items[0]?.round, 2);
  assert.deepEqual(parseReviewComment('plain remark', 1, 1), []);
});

test('the ranked causes put the refusal seen in two sources above the review module seen in one PR', () => {
  const items = [
    ...readTranscript(sessionA, 'a'),
    ...readTranscript(sessionB, 'b'),
    ...parseReviewComment(comment, 1565, 2),
  ];
  const causes = rankCauses(items);
  assert.equal(causes[0]?.subject, 'Blocked: sleep <n>');
  assert.deepEqual(causes[0]?.pointers, ['a:2', 'b:2']);
  assert.equal(causes[1]?.kind, 'review-finding');
  assert.equal(causes[1]?.subject, 'src/cli/lane.ts');
  assert.deepEqual(causes[1]?.pointers, [
    'PR#1565:src/cli/lane.ts:505',
    'PR#1565:src/cli/lane.ts:505',
  ]);
  assert.equal(causes.length, 2);
  const text = renderCauses(causes);
  assert.match(text, /2\. \[review-finding\] src\/cli\/lane\.ts: 2x/);
  assert.match(text, /at a:2 b:2/);
});

test('renderRetroCauses prints the evidence count and the ranking', () => {
  const text = renderRetroCauses(
    [
      { name: 'a', lines: sessionA },
      { name: 'b', lines: sessionB },
    ],
    parseReviewComment(comment, 1565, 2),
  );
  assert.match(text, /^Evidence: 2 transcript\(s\), 3 review finding\(s\)/);
  assert.match(text, /\[refusal\] Blocked: sleep <n>: 2x in 2 source/);
});
