import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appliesTo,
  checkStandards,
  type Enforce,
  parseStandards,
  reference,
  type Standard,
  StandardsDataError,
  toBrainRecord,
} from '../../src/brain/standards.ts';

// The plainest hand-written record, exactly the fields the pack format names.
const plain = `[
  {
    "id": "s-example",
    "area": "tests",
    "layer": "universal",
    "audience": "worker",
    "text": "The repository tracks automated tests.",
    "why": "Untested code has no statement of what it must do.",
    "evidence": ["#12"],
    "enforcement": { "kind": "command", "run": "test -d tests" },
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
  assert.equal(record?.layer, 'universal');
  assert.deepEqual(record?.enforcement, {
    kind: 'command',
    run: 'test -d tests',
  });
  assert.deepEqual(record?.applies, { stacks: [], needs: [] });
  assert.equal(record?.valid_to, null);
});

test('parseStandards accepts krn and advisory enforcement in their layers', () => {
  const [krn, advisory] = parseStandards([
    {
      ...base(),
      id: 's-tasks',
      layer: 'krn-delivery',
      enforcement: { kind: 'krn', args: ['task', 'check'] },
    },
    { ...base(), id: 's-names', enforcement: { kind: 'advisory' } },
  ]);
  assert.deepEqual(krn?.enforcement, { kind: 'krn', args: ['task', 'check'] });
  assert.deepEqual(advisory?.enforcement, { kind: 'advisory' });
});

test('parseStandards refuses malformed records and names the field', () => {
  assert.throws(() => parseStandards({}), /expected a JSON array/u);
  rejects((r) => delete r.why, /fields must be exactly/u);
  rejects((r) => (r.extra = 1), /fields must be exactly/u);
  rejects((r) => (r.id = 'r-example'), /\.id: expected s-/u);
  rejects((r) => (r.audience = 'everyone'), /\.audience: expected one of/u);
  rejects((r) => (r.layer = 'krn'), /\.layer: expected one of/u);
  rejects(
    (r) => (r.enforcement = { kind: 'hope' }),
    /enforcement\.kind: expected one of command, krn, advisory/u,
  );
  // A path#fragment reference is provenance, never enforcement.
  rejects(
    (r) => (r.enforcement = { kind: 'command', ref: 'scripts/check.ts' }),
    /enforcement: fields must be exactly kind, run/u,
  );
  rejects(
    (r) => (r.enforcement = { kind: 'command', run: ' ' }),
    /enforcement\.run: expected a non-empty string/u,
  );
  rejects(
    (r) => (r.enforcement = { kind: 'advisory', run: 'true' }),
    /enforcement: fields must be exactly kind$/u,
  );
  rejects(
    (r) => (r.enforcement = { kind: 'krn', args: ['task', 'check'] }),
    /krn enforcement is valid only for layer krn-delivery/u,
  );
  rejects((r) => {
    r.layer = 'krn-delivery';
    r.enforcement = { kind: 'krn', args: [] };
  }, /enforcement\.args: expected a krn subcommand/u);
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

const standard = (change: Partial<Standard>): Standard => ({
  ...(parseStandards(JSON.parse(plain))[0] as Standard),
  ...change,
});

test('appliesTo matches the stack family, every need, and krn-delivery only where adopted', () => {
  const needs = new Set(['tracker'] as const);
  const repo = { adopted: false, needs };
  const applies = (stacks: string[], want: 'tracker'[] = []) =>
    standard({ applies: { stacks, needs: want } });
  assert.ok(appliesTo(applies([]), repo));
  assert.ok(appliesTo(applies(['node']), { ...repo, stack: 'node/npm' }));
  assert.ok(!appliesTo(applies(['node']), { ...repo, stack: 'python' }));
  assert.ok(!appliesTo(applies(['node']), repo));
  assert.ok(appliesTo(applies([], ['tracker']), repo));
  assert.ok(
    !appliesTo(applies([], ['tracker']), { adopted: true, needs: new Set() }),
  );
  const delivery = standard({ layer: 'krn-delivery' });
  assert.ok(!appliesTo(delivery, repo));
  assert.ok(appliesTo(delivery, { ...repo, adopted: true }));
});

test('checkStandards runs enforced standards, counts advisory ones and names each failure with its exit', () => {
  const ran: string[] = [];
  const enforce: Enforce = (enforcement) => {
    const name =
      enforcement.kind === 'command'
        ? enforcement.run
        : enforcement.args.join(' ');
    ran.push(name);
    return name === 'false'
      ? { exit: 1, detail: 'it broke' }
      : name === 'sleep'
        ? { exit: null, detail: 'timed out after 5 ms' }
        : { exit: 0, detail: '' };
  };
  const standards = [
    standard({ id: 's-holds', enforcement: { kind: 'command', run: 'true' } }),
    standard({
      id: 's-broken',
      enforcement: { kind: 'command', run: 'false' },
    }),
    standard({ id: 's-slow', enforcement: { kind: 'command', run: 'sleep' } }),
    standard({
      id: 's-tasks',
      layer: 'krn-delivery',
      enforcement: { kind: 'krn', args: ['task', 'check'] },
    }),
    standard({ id: 's-names', enforcement: { kind: 'advisory' } }),
    standard({ id: 's-retired', valid_to: '2026-11-13' }),
  ];
  const report = checkStandards(standards, { asOf: '2026-11-14', enforce });
  assert.deepEqual(ran, ['true', 'false', 'sleep', 'task check']);
  assert.equal(report.enforced, 4);
  assert.equal(report.advisory, 1);
  assert.deepEqual(report.failures, [
    { id: 's-broken', message: 'exit 1 from false: it broke' },
    { id: 's-slow', message: 'exit none from sleep: timed out after 5 ms' },
    {
      id: 's-retired',
      message: 'outside its dates on 2026-11-14 (valid 2026-11-13..2026-11-13)',
    },
  ]);
});

test('toBrainRecord projects a standard onto the ADR 0002 record', () => {
  const [record] = parseStandards(JSON.parse(plain));
  assert.deepEqual(toBrainRecord(record as Standard), {
    id: 's-example',
    type: 'tests',
    text: 'The repository tracks automated tests.',
    recorded_at: '2026-11-13',
    valid_from: '2026-11-13',
    valid_to: null,
    source: '#12',
  });
});

test('the shipped pack holds 15-25 valid standards in both layers, with evidence that resolves in KRN', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pack = parseStandards(
    JSON.parse(readFileSync(`${root}standards/records.json`, 'utf8')),
  );
  assert.ok(pack.length >= 15 && pack.length <= 25, `${pack.length} records`);
  const layers = new Set(pack.map((record) => record.layer));
  assert.deepEqual([...layers].sort(), ['krn-delivery', 'universal']);
  const enforced = pack.filter((r) => r.enforcement.kind !== 'advisory');
  assert.ok(
    enforced.length / pack.length >= 0.6,
    `${enforced.length} of ${pack.length} enforced`,
  );
  for (const record of pack) {
    // Evidence is provenance: a KRN path must exist here and hold its fragment.
    for (const entry of record.evidence) {
      const form = reference(entry);
      if (form?.kind !== 'path') continue;
      const full = `${root}${form.path}`;
      assert.ok(existsSync(full), `${record.id}: ${entry}`);
      if (form.fragment !== undefined && !statSync(full).isDirectory())
        assert.ok(
          readFileSync(full, 'utf8').includes(form.fragment),
          `${record.id}: ${entry}`,
        );
    }
    // Enforcement never names a path that only the KRN repository has.
    const run =
      record.enforcement.kind === 'command' ? record.enforcement.run : '';
    assert.doesNotMatch(
      run,
      /\b(src|scripts|docs|evals|standards)\/|AGENTS\.md#|KRN-\d/u,
      record.id,
    );
    assert.doesNotMatch(record.text, /\bKRN-\d+|src\/|scripts\//u, record.id);
  }
});
