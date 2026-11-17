import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRevertRate,
  renderRevertRate,
  summarizeReverts,
} from '../../src/outcome/revert-rate.ts';

const pr = (number: number, title: string, body = '') => ({
  number,
  title,
  body,
});

const prs = [
  pr(14, 'Revert "feat(a): add a"', 'Reverts krn-works/krn#10'),
  pr(13, 'fix(c): c'),
  pr(12, 'Revert "feat(b): add b"'),
  pr(11, 'Revert "feat(zzz): gone"'),
  pr(10, 'feat(a): add a'),
  pr(9, 'feat(b): add b'),
  pr(8, 'chore: d'),
  pr(7, 'chore: e'),
];

test('revert rate is reverts over merged PRs, matched to the reverted PR', () => {
  const r = summarizeReverts(prs);
  assert.equal(r.merged, 8);
  assert.equal(r.share, 3 / 8);
  assert.deepEqual(
    r.reverts.map((v) => [v.number, v.reverted]),
    [
      [14, 10],
      [12, 9],
      [11, null],
    ],
  );
  assert.equal(
    renderRevertRate(r),
    [
      'Revert rate: 37.5% (3 reverts / 8 merged PRs)',
      '#14 Revert "feat(a): add a" reverts #10',
      '#12 Revert "feat(b): add b" reverts #9',
      '#11 Revert "feat(zzz): gone" reverts unknown',
      '',
    ].join('\n'),
  );
});

test('no merged PRs gives n/a, not a ratio', () => {
  assert.equal(summarizeReverts([]).share, null);
  assert.match(renderRevertRate(summarizeReverts([])), /n\/a \(0 reverts \/ 0/);
});

test('collector reads the merged list through gh with the limit', async () => {
  const seen: string[][] = [];
  const r = await collectRevertRate({
    repo: 'krn-works/krn',
    limit: 8,
    run: (cmd, args) => {
      assert.equal(cmd, 'gh');
      seen.push(args);
      return JSON.stringify(prs);
    },
  });
  assert.equal(r.reverts.length, 3);
  assert.ok(seen[0]?.includes('number,title,body'));
  assert.equal(seen[0]?.[seen[0].indexOf('--limit') + 1], '8');
});
