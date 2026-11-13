import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  appliesTo,
  checkStandards,
  health,
  parseStandards,
  reference,
  type Standard,
  StandardsDataError,
  toBrainRecord,
} from '../../src/brain/standards.ts';
import { rootReader } from '../../src/brain/standards-cli.ts';

// The plainest hand-written record, exactly the fields the pack format names.
const plain = `[
  {
    "id": "s-example",
    "area": "tests",
    "audience": "worker",
    "text": "A fixed defect gets a regression test.",
    "why": "It stops the defect coming back.",
    "evidence": ["#12"],
    "enforcement": { "kind": "prose", "ref": "AGENTS.md" },
    "applies": { "stacks": [], "needs": [] },
    "recorded_at": "2026-11-13",
    "valid_from": "2026-11-13",
    "valid_to": null
  }
]`;

const base = (): Record<string, unknown> =>
  (JSON.parse(plain) as Record<string, unknown>[])[0] ?? {};

function rejects(
  change: (record: Record<string, unknown>) => void,
  pattern: RegExp,
) {
  const record = base();
  change(record);
  assert.throws(
    () => parseStandards([record]),
    (error: unknown) =>
      error instanceof StandardsDataError &&
      error.exitCode === 65 &&
      pattern.test(error.message),
  );
}

test('parseStandards accepts the plainest hand-written record', () => {
  const [record] = parseStandards(JSON.parse(plain));
  assert.equal(record?.id, 's-example');
  assert.deepEqual(record?.enforcement, { kind: 'prose', ref: 'AGENTS.md' });
  assert.deepEqual(record?.applies, { stacks: [], needs: [] });
  assert.equal(record?.valid_to, null);
});

test('parseStandards refuses malformed records and names the field', () => {
  assert.throws(() => parseStandards({}), /expected a JSON array/u);
  rejects((r) => delete r.why, /fields must be exactly/u);
  rejects((r) => (r.extra = 1), /fields must be exactly/u);
  rejects((r) => (r.id = 'r-example'), /\.id: expected s-/u);
  rejects((r) => (r.audience = 'everyone'), /\.audience: expected one of/u);
  rejects(
    (r) => (r.enforcement = { kind: 'hope', ref: 'AGENTS.md' }),
    /enforcement\.kind/u,
  );
  rejects(
    (r) => (r.enforcement = { kind: 'check', ref: '#12' }),
    /enforcement\.ref: expected a repository path/u,
  );
  rejects((r) => (r.evidence = []), /evidence: expected at least one/u);
  rejects((r) => (r.evidence = ['../outside.md']), /evidence\[0\]/u);
  rejects((r) => (r.evidence = ['/etc/passwd']), /evidence\[0\]/u);
  rejects(
    (r) => (r.applies = { stacks: [], needs: ['cloud'] }),
    /applies\.needs\[0\]/u,
  );
  rejects((r) => (r.valid_from = '2026-13-01'), /valid_from: expected/u);
  rejects((r) => (r.valid_to = '2026-01-01'), /valid_to precedes/u);
  assert.throws(
    () => parseStandards([base(), base()]),
    /duplicate id s-example/u,
  );
});

test('reference classifies every accepted evidence form', () => {
  assert.deepEqual(reference('#693'), { kind: 'pr', value: '#693' });
  assert.deepEqual(reference('7ab3529'), { kind: 'commit', value: '7ab3529' });
  assert.equal(reference('https://example.com/a')?.kind, 'url');
  assert.deepEqual(reference('AGENTS.md#KRN-12'), {
    kind: 'path',
    path: 'AGENTS.md',
    fragment: 'KRN-12',
  });
  assert.equal(reference('docs//x.md'), undefined);
  assert.equal(reference('AGENTS.md#'), undefined);
});

const standard = (applies: Standard['applies']): Standard => ({
  ...(parseStandards(JSON.parse(plain))[0] as Standard),
  applies,
});

test('appliesTo matches the stack family and every need', () => {
  const needs = new Set(['tracker'] as const);
  assert.ok(appliesTo(standard({ stacks: [], needs: [] }), { needs }));
  assert.ok(
    appliesTo(standard({ stacks: ['node'], needs: [] }), {
      stack: 'node/npm',
      needs,
    }),
  );
  assert.ok(
    !appliesTo(standard({ stacks: ['node'], needs: [] }), {
      stack: 'python',
      needs,
    }),
  );
  assert.ok(!appliesTo(standard({ stacks: ['node'], needs: [] }), { needs }));
  assert.ok(appliesTo(standard({ stacks: [], needs: ['tracker'] }), { needs }));
  assert.ok(
    !appliesTo(standard({ stacks: [], needs: ['tracker', 'ci'] }), { needs }),
  );
});

test('checkStandards reports stale dates and refs or evidence that do not resolve', () => {
  const files: Record<string, string> = { 'AGENTS.md': 'KRN-12 rule' };
  const read = (path: string) => files[path];
  const ok = parseStandards(JSON.parse(plain));
  assert.deepEqual(checkStandards(ok, { asOf: '2026-11-13', read }), []);
  assert.match(
    checkStandards(ok, { asOf: '2026-11-12', read })[0]?.message ?? '',
    /outside its dates on 2026-11-12/u,
  );
  const expired = parseStandards([{ ...base(), valid_to: '2026-11-14' }]);
  assert.equal(checkStandards(expired, { asOf: '2026-11-15', read }).length, 1);
  const broken = parseStandards([
    {
      ...base(),
      evidence: ['AGENTS.md#KRN-99', 'docs/missing.md'],
      enforcement: { kind: 'check', ref: 'scripts/missing.ts' },
    },
  ]);
  assert.deepEqual(
    checkStandards(broken, { asOf: '2026-11-13', read }).map((p) => p.message),
    [
      'enforcement scripts/missing.ts does not exist',
      'evidence AGENTS.md does not contain "KRN-99"',
      'evidence docs/missing.md does not exist',
    ],
  );
});

test('toBrainRecord projects a standard onto the ADR 0002 record', () => {
  const [record] = parseStandards(JSON.parse(plain));
  assert.deepEqual(toBrainRecord(record as Standard), {
    id: 's-example',
    type: 'tests',
    text: 'A fixed defect gets a regression test.',
    recorded_at: '2026-11-13',
    valid_from: '2026-11-13',
    valid_to: null,
    source: '#12',
  });
});

test('the shipped pack holds 15-25 valid standards with evidence and enforcement that resolve', () => {
  const root = new URL('../../', import.meta.url);
  const pack = parseStandards(
    JSON.parse(readFileSync(new URL('standards/records.json', root), 'utf8')),
  );
  assert.ok(pack.length >= 15 && pack.length <= 25, `${pack.length} records`);
  const asOf = '2026-11-13';
  assert.deepEqual(
    checkStandards(pack, { asOf, read: rootReader(root.pathname) }),
    [],
  );
  for (const record of pack) {
    assert.ok(record.evidence.length > 0, record.id);
    assert.doesNotMatch(record.text, /\bKRN-\d+|src\/|scripts\//u, record.id);
  }
  const pulse = health(pack, asOf);
  assert.equal(pulse.stale, 0);
  assert.ok(pulse.enforced >= 0.65, `check/template share ${pulse.enforced}`);
  assert.ok(pulse.workerProse <= 20);
});
