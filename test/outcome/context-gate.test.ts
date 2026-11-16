import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type BandName,
  bandOf,
  bandStats,
  codeFilesByPr,
  fisherLess,
  type GateRow,
  judgeBand,
  renderContextGate,
  reworked,
} from '../../src/outcome/context-gate.ts';
import { attributePr, parseTranscript } from '../../src/outcome/ledger.ts';

const rows = (
  band: BandName,
  n: number,
  green: number,
  rework: number,
): GateRow[] =>
  Array.from({ length: n }, (_, i) => ({
    band,
    firstGreen: i < green,
    rework: i < rework,
  }));

test('Fisher one-sided p matches the tea-tasting table (17/70)', () => {
  assert.ok(Math.abs(fisherLess(3, 4, 1, 4) - 17 / 70) < 1e-9);
  assert.ok(Math.abs(fisherLess(1, 4, 3, 4) - 17 / 70) > 0.1);
  assert.equal(fisherLess(5, 5, 5, 5), 1);
});

test('bands split at 150k, 200k and 300k', () => {
  assert.deepEqual([149_999, 150_000, 200_000, 299_999, 300_000].map(bandOf), [
    '<150k',
    '150-200k',
    '200-300k',
    '200-300k',
    '300k+',
  ]);
});

test('pass: the band is no worse than <150k with 100 merges per band', () => {
  const stats = bandStats([
    ...rows('<150k', 120, 100, 10),
    ...rows('200-300k', 110, 95, 10),
  ]);
  assert.equal(judgeBand(stats, '200-300k').verdict, 'pass');
});

test('fail: first-push-green significantly lower than <150k', () => {
  const stats = bandStats([
    ...rows('<150k', 120, 105, 10),
    ...rows('200-300k', 110, 70, 10),
  ]);
  assert.equal(judgeBand(stats, '200-300k').verdict, 'fail');
});

test('fail: rework significantly higher than <150k', () => {
  const stats = bandStats([
    ...rows('<150k', 120, 100, 5),
    ...rows('200-300k', 110, 90, 40),
  ]);
  assert.equal(judgeBand(stats, '200-300k').verdict, 'fail');
});

test('inconclusive: a band under 100 merges is never judged', () => {
  const stats = bandStats([
    ...rows('<150k', 120, 105, 10),
    ...rows('200-300k', 99, 10, 90),
  ]);
  const v = judgeBand(stats, '200-300k');
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reason, /need 100/);
});

test('rework: a later fix within 48h sharing the task id or a code file', () => {
  const prs = [
    {
      number: 1,
      title: 'feat(a): x (t-aaaaaaa)',
      mergedAt: '2026-11-10T00:00:00Z',
    },
    {
      number: 2,
      title: 'fix(a): y (t-aaaaaaa)',
      mergedAt: '2026-11-11T00:00:00Z',
    },
    {
      number: 3,
      title: 'feat(b): z (t-bbbbbbb)',
      mergedAt: '2026-11-10T00:00:00Z',
    },
    {
      number: 4,
      title: 'fix(b): w (t-ccccccc)',
      mergedAt: '2026-11-10T12:00:00Z',
    },
    {
      number: 5,
      title: 'feat(c): v (t-ddddddd)',
      mergedAt: '2026-11-01T00:00:00Z',
    },
    {
      number: 6,
      title: 'fix(c): u (t-eeeeeee)',
      mergedAt: '2026-11-10T12:00:00Z',
    },
  ];
  const log =
    '@@abc|2026-11-10T00:00:00Z|feat(b): z (t-bbbbbbb) (#3)\nsrc/b.ts\ndocs/x.md\n' +
    '@@def|2026-11-10T12:00:00Z|fix(b): w (t-ccccccc) (#4)\nsrc/b.ts\n';
  const files = codeFilesByPr(log);
  assert.deepEqual([...(files.get(3) ?? [])], ['src/b.ts']);
  assert.deepEqual([...reworked(prs, files)].sort(), [1, 3]);
});

test('a PR maps to the lead session whose commands name it most, ties map to none', () => {
  const line = (command: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id: command,
        role: 'assistant',
        model: 'm',
        usage: { input_tokens: 5, cache_read_input_tokens: 250_000 },
        content: [
          { type: 'tool_use', id: command, name: 'Bash', input: { command } },
        ],
      },
    });
  const a = parseTranscript([line('krn pr ship --pr 7 t-aaaaaaa')]);
  const b = parseTranscript([line('git log')]);
  assert.equal(a.peak, 250_005);
  const pr = { number: 7, title: 'feat: x (t-aaaaaaa)' };
  assert.equal(attributePr(pr, [b, a]), a);
  assert.equal(attributePr(pr, [a, a]), null);
  assert.equal(attributePr(pr, [b]), null);
});

test('render ends with the verdict line and prints coverage', () => {
  const stats = bandStats(rows('<150k', 3, 3, 0));
  const out = renderContextGate({
    merges: 10,
    leadShipped: 8,
    mapped: 7,
    coverage: 7 / 8,
    stats,
    band: '200-300k',
    verdict: { verdict: 'inconclusive', reason: 'x' },
    sessions: { '<150k': 1, '150-200k': 0, '200-300k': 0, '300k+': 0 },
  });
  assert.match(out, /^coverage: 87\.5% \(7 of 8/);
  assert.match(
    out.trimEnd().split('\n').at(-1) ?? '',
    /^verdict: inconclusive/,
  );
});
