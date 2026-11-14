import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appliesTo,
  BLOCK_END,
  BLOCK_START,
  briefStandards,
  checkStandards,
  type Enforce,
  formatStandards,
  INHERITED,
  parsePack,
  parseStandards,
  promotionFailures,
  reference,
  renderStandardsBlock,
  type Standard,
  StandardsDataError,
  seedStandards,
  toBrainRecord,
  upsertStandardsBlock,
} from '../../src/brain/standards.ts';

// The plainest hand-written record, exactly the fields the pack format names.
const plain = `[
  {
    "id": "s-example",
    "area": "tests",
    "layer": "universal",
    "audience": "worker",
    "tier": "floor",
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
    { id: 's-broken', tier: 'floor', message: 'exit 1 from false: it broke' },
    {
      id: 's-slow',
      tier: 'floor',
      message: 'exit none from sleep: timed out after 5 ms',
    },
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

test('the shipped pack holds 15-25 universal standards in both layers, with evidence that resolves in KRN', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pack = parseStandards(
    JSON.parse(readFileSync(`${root}standards/records.json`, 'utf8')),
  );
  // The universal layer is the budget every adopted repository inherits; krn-delivery
  // records apply only where KRN is adopted.
  const universal = pack.filter((r) => r.layer === 'universal').length;
  assert.ok(universal >= 15 && universal <= 25, `${universal} universal`);
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

// The plainest hand-written inherited record: the pack fields plus `"origin": "krn"`.
const inheritedPlain = `[
  {
    "id": "s-example",
    "area": "tests",
    "layer": "universal",
    "audience": "worker",
    "tier": "floor",
    "text": "The repository tracks automated tests.",
    "why": "Untested code has no statement of what it must do.",
    "evidence": ["#12"],
    "enforcement": { "kind": "command", "run": "test -d tests" },
    "applies": { "stacks": [], "needs": [] },
    "recorded_at": "2026-11-13",
    "valid_from": "2026-11-13",
    "valid_to": null,
    "origin": "krn"
  }
]`;

test('a project record may carry origin krn, any other origin is refused, and the pack carries none', () => {
  const [record] = parseStandards(JSON.parse(inheritedPlain));
  assert.equal(record?.origin, INHERITED);
  assert.equal(parseStandards(JSON.parse(plain))[0]?.origin, undefined);
  rejects((r) => {
    r.origin = 'elsewhere';
  }, /standards\[0\]\.origin: expected "krn"/u);
  assert.throws(
    () => parsePack(JSON.parse(inheritedPlain)),
    (error: unknown) =>
      error instanceof StandardsDataError &&
      /pack record s-example carries an origin/u.test(error.message),
  );
  // Written and read back, a seeded file keeps every field and the origin.
  const written = formatStandards(parseStandards(JSON.parse(inheritedPlain)));
  assert.deepEqual(JSON.parse(written), JSON.parse(inheritedPlain));
  assert.ok(written.endsWith('}\n]\n'));
});

const parsed = (change: Partial<Record<string, unknown>>): Standard => {
  const [record] = parseStandards([{ ...base(), ...change }]);
  assert.ok(record);
  return record;
};

test('seedStandards copies the universal pack records that apply, marks them inherited and keeps own records', () => {
  const pack = [
    parsed({ id: 's-any' }),
    parsed({ id: 's-node', applies: { stacks: ['node'], needs: [] } }),
    parsed({ id: 's-python', applies: { stacks: ['python'], needs: [] } }),
    parsed({ id: 's-tracked', applies: { stacks: [], needs: ['tracker'] } }),
    parsed({
      id: 's-delivery',
      layer: 'krn-delivery',
      enforcement: { kind: 'krn', args: ['task', 'check'] },
    }),
  ];
  const own = parsed({ id: 's-own', text: 'A project rule.' });
  const stale: Standard = {
    ...parsed({ id: 's-any', text: 'Old wording.' }),
    origin: INHERITED,
  };
  const python = { stack: 'python', adopted: false, needs: new Set<never>() };
  const seeded = seedStandards(pack, [stale, own], python, 'f.json');
  assert.deepEqual(
    seeded.map((s) => [s.id, s.origin ?? 'own']),
    [
      ['s-any', 'krn'],
      ['s-python', 'krn'],
      ['s-own', 'own'],
    ],
  );
  // An inherited copy is refreshed from the pack, never kept beside it.
  assert.equal(seeded[0]?.text, 'The repository tracks automated tests.');
  const tracked = seedStandards(
    pack,
    [],
    { stack: 'node/npm', adopted: false, needs: new Set(['tracker'] as const) },
    'f.json',
  );
  assert.deepEqual(
    tracked.map((s) => s.id),
    ['s-any', 's-node', 's-tracked'],
  );
  assert.throws(
    () => seedStandards(pack, [parsed({ id: 's-node' })], python, 'f.json'),
    (error: unknown) =>
      error instanceof StandardsDataError &&
      error.exitCode === 65 &&
      /^f\.json redefines pack standard s-node;/u.test(error.message),
  );
});

test('the standards block renders statement and enforcement and is replaced in place, never duplicated', () => {
  const checked = parsed({ id: 's-checked' });
  const advisory = parsed({
    id: 's-advisory',
    text: 'Name by role.',
    enforcement: { kind: 'advisory' },
  });
  const block = renderStandardsBlock([checked, advisory]);
  assert.ok(block.startsWith(`${BLOCK_START}\n`));
  assert.ok(block.endsWith(`${BLOCK_END}\n`));
  assert.match(
    block,
    /^- \*\*s-checked\*\* The repository tracks automated tests\. _\(checked by `krn standards check`: `test -d tests`\)_$/mu,
  );
  assert.match(
    block,
    /^- \*\*s-advisory\*\* Name by role\. _\(advisory, not checked\)_$/mu,
  );
  const first = upsertStandardsBlock('# Project\n\nOwn text.\n', block);
  assert.equal(first, `# Project\n\nOwn text.\n\n${block}`);
  assert.equal(upsertStandardsBlock(first, block), first);
  const shorter = renderStandardsBlock([checked]);
  const replaced = upsertStandardsBlock(`${first}Tail.\n`, shorter);
  assert.equal(replaced, `# Project\n\nOwn text.\n\n${shorter}Tail.\n`);
  assert.equal(replaced.split(BLOCK_START).length, 2);
  assert.equal(upsertStandardsBlock('', block), block);
});

test('briefStandards lists in-force worker standards and marks the inherited ones', () => {
  const records: Standard[] = [
    { ...parsed({ id: 's-inherited' }), origin: INHERITED },
    parsed({ id: 's-own', text: 'A project rule.' }),
    parsed({ id: 's-lead', audience: 'lead' }),
    parsed({
      id: 's-expired',
      recorded_at: '2020-01-01',
      valid_from: '2020-01-01',
      valid_to: '2020-12-31',
    }),
  ];
  const section = briefStandards(
    records,
    '2026-11-13',
    '.agents/standards.json',
  );
  assert.deepEqual(section.split('\n'), [
    'Repository standards (.agents/standards.json; `krn standards check` enforces the checked ones):',
    '- [s-inherited] (inherited from krn) The repository tracks automated tests.',
    '- [s-own] A project rule.',
  ]);
  assert.equal(briefStandards([records[2] as Standard], '2026-11-13', 'f'), '');
});

test('a harvested record keeps its origins and parses only with a consistent occurrence count', () => {
  const record = {
    ...base(),
    harvested: { origins: ['alpha', 'beta'], occurrences: 2 },
  };
  assert.deepEqual(parseStandards([record])[0]?.harvested, {
    origins: ['alpha', 'beta'],
    occurrences: 2,
  });
  rejects(
    (r) => Object.assign(r, { harvested: { origins: [], occurrences: 1 } }),
    /harvested\.origins: expected at least one/u,
  );
  rejects(
    (r) =>
      Object.assign(r, { harvested: { origins: ['a', 'b'], occurrences: 1 } }),
    /harvested\.occurrences: expected an integer of at least 2/u,
  );
  rejects(
    (r) => Object.assign(r, { harvested: { origins: ['a'] } }),
    /harvested: fields must be exactly origins, occurrences/u,
  );
});

test('promotionFailures holds a harvested record to recurrence and enforcement, and ignores the rest', () => {
  const harvested = (
    origins: string[],
    occurrences: number,
    extra: Record<string, unknown> = {},
  ) =>
    parseStandards([
      { ...base(), harvested: { origins, occurrences }, ...extra },
    ]);
  assert.deepEqual(promotionFailures(parseStandards([base()])), []);
  assert.deepEqual(promotionFailures(harvested(['alpha', 'beta'], 2)), []);
  assert.deepEqual(promotionFailures(harvested(['alpha'], 3)), []);
  assert.deepEqual(
    promotionFailures(
      harvested(['alpha'], 1, { evidence: ['https://example.com/source'] }),
    ),
    [],
  );
  const once = promotionFailures(harvested(['alpha'], 1));
  assert.equal(once.length, 1);
  assert.equal(once[0]?.id, 's-example');
  assert.match(
    once[0]?.message ?? '',
    /^promotion rule: .*origins alpha in 1 proposals; needs 2 repositories, 3 proposals or an https evidence source$/u,
  );
  const advisory = promotionFailures(
    harvested(['alpha', 'beta'], 2, { enforcement: { kind: 'advisory' } }),
  );
  assert.deepEqual(
    advisory.map((failure) => failure.message),
    [
      'promotion rule: a harvested standard needs a command or krn enforcement, not advisory',
    ],
  );
});

test('parseStandards refuses a record without a tier, with an unknown tier, or a waiver off reflex', () => {
  rejects((r) => delete r.tier, /fields must be exactly/u);
  rejects(
    (r) => (r.tier = 'optional'),
    /\.tier: expected one of floor, reflex, finish/u,
  );
  rejects(
    (r) => (r.waiver = 'later'),
    /only a reflex standard takes a waiver/u,
  );
  rejects((r) => {
    r.tier = 'reflex';
    r.waiver = ' ';
  }, /\.waiver: expected a non-empty string/u);
});

test('checkStandards counts per tier and blocks only floor and an unwaived reflex', () => {
  const failing: Enforce = () => ({ exit: 1, detail: '' });
  const standards = parseStandards([
    { ...base(), id: 's-floor', tier: 'floor' },
    { ...base(), id: 's-reflex', tier: 'reflex' },
    {
      ...base(),
      id: 's-waived',
      tier: 'reflex',
      waiver: 'migration in flight',
    },
    { ...base(), id: 's-finish', tier: 'finish' },
  ]);
  const report = checkStandards(standards, {
    asOf: '2026-11-14',
    enforce: failing,
  });
  assert.deepEqual(
    report.blocking.map((failure) => failure.id),
    ['s-floor', 's-reflex'],
  );
  assert.equal(report.failures.length, 4);
  assert.deepEqual(report.tiers.reflex, { enforced: 2, failed: 2 });
  assert.deepEqual(report.tiers.finish, { enforced: 1, failed: 1 });
});
