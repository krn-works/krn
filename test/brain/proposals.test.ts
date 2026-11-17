import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatProposal,
  harvestCandidates,
  harvestInstructionBullets,
  normalizeText,
  overdueProposals,
  parseProposal,
  parseResearchCandidate,
  proposalFileName,
  renderHarvest,
  type Sourced,
  staleResearch,
} from '../../src/brain/proposals.ts';
import { StandardsDataError } from '../../src/brain/standards.ts';

// The plainest hand-written proposal, exactly the four fields the format names.
const plain = `{
  "text": "Run the linter before every commit.",
  "kind": "check",
  "evidence": ["#12"],
  "recorded_at": "2026-11-13"
}`;

test('parseProposal accepts the plainest hand-written proposal', () => {
  assert.deepEqual(parseProposal(JSON.parse(plain)), {
    text: 'Run the linter before every commit.',
    kind: 'check',
    evidence: ['#12'],
    recorded_at: '2026-11-13',
  });
});

test('parseProposal refuses malformed proposals and names the field', () => {
  const base = () => JSON.parse(plain) as Record<string, unknown>;
  const cases: [(p: Record<string, unknown>) => void, RegExp][] = [
    [(p) => delete p.kind, /fields must be exactly/u],
    [(p) => Object.assign(p, { extra: 1 }), /fields must be exactly/u],
    [(p) => Object.assign(p, { text: '  ' }), /proposal\.text/u],
    [(p) => Object.assign(p, { kind: 'rule' }), /proposal\.kind: expected/u],
    [(p) => Object.assign(p, { evidence: [] }), /proposal\.evidence/u],
    [
      (p) => Object.assign(p, { evidence: ['../x'] }),
      /proposal\.evidence\[0\]/u,
    ],
    [
      (p) => Object.assign(p, { recorded_at: '13.11.2026' }),
      /proposal\.recorded_at/u,
    ],
  ];
  for (const [change, pattern] of cases) {
    const proposal = base();
    change(proposal);
    assert.throws(
      () => parseProposal(proposal),
      (error: unknown) =>
        error instanceof StandardsDataError &&
        error.exitCode === 65 &&
        pattern.test(error.message),
      pattern.source,
    );
  }
  assert.throws(() => parseProposal([]), /expected an object/u);
});

test('normalizeText ignores case, spacing and a closing full stop', () => {
  assert.equal(
    normalizeText('  Run the  linter\nbefore every commit. '),
    normalizeText('run the linter before every commit'),
  );
  assert.notEqual(
    normalizeText('Run the linter'),
    normalizeText('Run the tests'),
  );
});

test('proposalFileName is a readable slug plus a hash of the normalized text', () => {
  const name = proposalFileName('Run the linter before every commit.');
  assert.match(name, /^run-the-linter-before-every-commit-[0-9a-f]{8}\.json$/u);
  assert.equal(proposalFileName('RUN the linter before every commit'), name);
  assert.notEqual(proposalFileName('Run the tests before every commit'), name);
  assert.match(proposalFileName('!!!'), /^proposal-[0-9a-f]{8}\.json$/u);
});

test('formatProposal round-trips through parseProposal', () => {
  const proposal = parseProposal(JSON.parse(plain));
  assert.deepEqual(
    parseProposal(JSON.parse(formatProposal(proposal))),
    proposal,
  );
  assert.ok(formatProposal(proposal).endsWith('}\n'));
});

function sourced(
  origin: string,
  text: string,
  evidence = ['#1'],
  kind: 'check' | 'prose' = 'check',
): Sourced {
  return {
    origin,
    repository: `/repos/${origin}`,
    file: `.agents/standards-proposals/${proposalFileName(text)}`,
    proposal: { text, kind, evidence, recorded_at: '2026-11-13' },
  };
}

test('harvestCandidates groups equal lessons across repositories and counts them', () => {
  const candidates = harvestCandidates([
    sourced('alpha', 'Run the linter before every commit.', ['#3']),
    sourced('beta', 'run the linter before every commit', ['abc1234']),
    sourced('beta', 'Pin tool versions.'),
  ]);
  assert.equal(candidates.length, 2);
  const [first, second] = candidates;
  assert.equal(first?.text, 'Run the linter before every commit.');
  assert.equal(first?.occurrences, 2);
  assert.equal(first?.repositories, 2);
  assert.deepEqual(first?.origins, ['alpha', 'beta']);
  assert.deepEqual(first?.evidence, ['alpha:#3', 'beta:abc1234']);
  assert.equal(first?.promotable, true);
  assert.equal(second?.occurrences, 1);
  assert.equal(second?.promotable, false);
});

test('a lesson from one repository is promotable after three proposals or with an https source', () => {
  const thrice = harvestCandidates([
    sourced('alpha', 'Pin tool versions.', ['#1']),
    { ...sourced('alpha', 'Pin tool versions', ['#2']) },
    { ...sourced('alpha', 'pin tool versions.', ['#3']) },
  ]);
  assert.equal(thrice[0]?.occurrences, 3);
  assert.equal(thrice[0]?.repositories, 1);
  assert.equal(thrice[0]?.promotable, true);
  const external = harvestCandidates([
    sourced('alpha', 'Pin tool versions.', ['https://example.com/pin']),
  ]);
  assert.equal(external[0]?.promotable, true);
});

test('renderHarvest prints one candidate line per lesson and a summary last', () => {
  const lines = renderHarvest(
    harvestCandidates([
      sourced('alpha', 'Run the linter.'),
      sourced('beta', 'Run the linter.'),
    ]),
    2,
  );
  assert.deepEqual(lines, [
    'candidate count 2 in 2 repositories (promotable): Run the linter.',
    '  kinds: check; origins: alpha, beta; evidence: alpha:#1, beta:#1',
    'harvest: 1 candidate from 2 proposals in 2 repositories, 1 promotable',
  ]);
  assert.deepEqual(renderHarvest([], 1), [
    'harvest: 0 candidates from 0 proposals in 1 repository, 0 promotable',
  ]);
});

test('harvestInstructionBullets counts a bullet once per repository and ignores short bullets', () => {
  const doc = (text: string) => ({
    repository: '/r',
    origin: 'r',
    file: 'AGENTS.md',
    text,
  });
  const one = harvestInstructionBullets([
    doc('- Keep imports inside core.\n- Keep imports inside core.\n- Done.\n'),
    { ...doc('- keep IMPORTS inside core'), repository: '/s', origin: 's' },
  ]);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.repositories, 2);
  assert.deepEqual(one[0]?.sources, ['r/AGENTS.md', 's/AGENTS.md']);
});

test('a committed proposal waits its review window; only an undisposed overdue one is reported', () => {
  const fresh = parseProposal({
    text: 'Fresh lesson from this slice.',
    kind: 'check',
    evidence: ['#1'],
    recorded_at: '2026-11-10',
  });
  const stale = parseProposal({
    text: 'Stale lesson nobody disposed.',
    kind: 'prose',
    evidence: ['#2'],
    recorded_at: '2026-10-01',
  });
  const disposed = parseProposal({
    text: 'Disposed lesson.',
    kind: 'check',
    evidence: ['#3'],
    recorded_at: '2026-09-01',
  });
  const enforced = new Set([normalizeText('Disposed lesson.')]);
  // A retro that commits its proposal the same day passes the repository check.
  assert.deepEqual(overdueProposals([fresh], enforced, '2026-11-10'), []);
  assert.deepEqual(overdueProposals([fresh], enforced, '2026-11-24'), []);
  assert.deepEqual(
    overdueProposals([fresh, stale, disposed], enforced, '2026-11-25').map(
      (p) => p.text,
    ),
    ['Fresh lesson from this slice.', 'Stale lesson nobody disposed.'],
  );
});

// The plainest hand-written candidate: the contract fields plus a reuse line.
const plainCandidate = `{
  "schema": "krn.candidate/v1",
  "id": "c-1",
  "source": { "url": "https://example.com/paper" },
  "pillar": "brain",
  "claim": "Rank records by hidden-test gain.",
  "motivated_by": "hidden test h-12 failed",
  "reuse": "ripgrep https://github.com/BurntSushi/ripgrep",
  "recorded_at": "2026-11-01"
}`;

test('parseResearchCandidate accepts reuse, build_because or neither and refuses both', () => {
  const base = () => JSON.parse(plainCandidate) as Record<string, unknown>;
  assert.equal(parseResearchCandidate(base()).id, 'c-1');
  const built = base();
  delete built.reuse;
  built.build_because = 'no existing tool reads the ledger';
  assert.equal(
    parseResearchCandidate(built).build_because,
    'no existing tool reads the ledger',
  );
  const neither = base();
  delete neither.reuse;
  assert.equal(parseResearchCandidate(neither).reuse, undefined);
  const both = { ...base(), build_because: 'x' };
  const noUrl = { ...base(), reuse: 'ripgrep' };
  const noFailure = base();
  delete noFailure.motivated_by;
  for (const [bad, pattern] of [
    [both, /at most one of reuse/u],
    [noUrl, /candidate\.reuse/u],
    [noFailure, /candidate\.motivated_by/u],
  ] as const)
    assert.throws(
      () => parseResearchCandidate(bad),
      (error: unknown) =>
        error instanceof StandardsDataError && pattern.test(error.message),
    );
});

test('staleResearch lists candidates older than 7 days without a merged PR or retire verdict', () => {
  const make = (extra: object, recorded_at = '2026-11-01') =>
    parseResearchCandidate({
      ...JSON.parse(plainCandidate),
      recorded_at,
      ...extra,
    });
  const rows = staleResearch(
    [
      make({ id: 'old' }),
      make({ id: 'merged', merged_pr: '#5' }),
      make({ id: 'retired', retire: 'superseded' }),
      make({ id: 'fresh' }, '2026-11-10'),
    ],
    '2026-11-16',
  );
  assert.deepEqual(
    rows.map((c) => c.id),
    ['old'],
  );
});
