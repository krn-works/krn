import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  classify,
  type Expected,
  PR_STATES,
  PR_VIEW_FIELDS,
  type PrState,
} from '../../src/ci/github-state.ts';
import { capture } from '../receivers/capture.ts';

// KRN-12: each state fixture is a verbatim gh capture under test/fixtures/gh, projected to the
// fields the state reads, with only the fields and check-run rows it declares varied.
type Fixture = {
  state: PrState['kind'];
  about: string;
  expected: Expected;
  from: {
    view: { capture: string; varied: string[] };
    checkRuns?: { capture: string; varied: number[] };
    runs?: { capture: string };
  };
  snapshot: {
    view: Record<string, unknown>;
    checkRuns?: Row[];
    runs?: { status: string }[];
  };
};

const dir = new URL('../fixtures/github-state/', import.meta.url);
const fixtures = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({
    name: file,
    fixture: JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Fixture,
  }));

const captured = (name: string): unknown =>
  JSON.parse(
    capture('fixtures/gh', name).streams.stdout?.toString('utf8') ?? '',
  );

/** A `CHECK_FACT_FILTER` row: id, name, appId, startedAt, status, conclusion, detailsUrl. */
type Row = { id: number; [field: string]: unknown };

/** The fixture as gh prints it, with its check-run rows replaced when given. */
const answersOf = ({ snapshot }: Fixture, checkRuns = snapshot.checkRuns) => ({
  view: JSON.stringify(snapshot.view),
  checkRuns: checkRuns === undefined ? undefined : JSON.stringify(checkRuns),
  runs: snapshot.runs === undefined ? undefined : JSON.stringify(snapshot.runs),
});

const fixture = (name: string): Fixture => {
  const found = fixtures.find((f) => f.name === `${name}.json`);
  assert.ok(found, `fixture ${name}`);
  return found.fixture;
};

test('every state of the closed set has a fixture, and each fixture classifies to its state', () => {
  for (const kind of PR_STATES)
    assert.ok(
      fixtures.some(({ fixture }) => fixture.state === kind),
      `a fixture for ${kind}`,
    );
  for (const { name, fixture } of fixtures)
    assert.equal(
      classify(answersOf(fixture), fixture.expected).kind,
      fixture.state,
      `${name}: ${fixture.about}`,
    );
});

test('each fixture is its gh capture except the fields and check-run rows it declares varied', () => {
  const keys = PR_VIEW_FIELDS.split(',');
  for (const { name, fixture } of fixtures) {
    const { from, snapshot } = fixture;
    const view = captured(from.view.capture) as Record<string, unknown>;
    assert.deepEqual(Object.keys(snapshot.view).sort(), [...keys].sort());
    for (const key of keys)
      assert.equal(
        isDeepStrictEqual(snapshot.view[key], view[key]),
        !from.view.varied.includes(key),
        `${name}: view.${key} differs from ${from.view.capture} exactly when declared varied`,
      );
    if (from.checkRuns === undefined)
      assert.equal(snapshot.checkRuns, undefined, name);
    else {
      const rows = new Map(
        (captured(from.checkRuns.capture) as { id: number }[]).map((row) => [
          row.id,
          row,
        ]),
      );
      const mine = new Map(
        (snapshot.checkRuns ?? []).map((row) => [row.id, row]),
      );
      for (const id of new Set([...rows.keys(), ...mine.keys()]))
        assert.equal(
          isDeepStrictEqual(rows.get(id), mine.get(id)),
          !from.checkRuns.varied.includes(id),
          `${name}: check run ${id} differs from ${from.checkRuns.capture} exactly when declared varied`,
        );
    }
    if (from.runs === undefined) assert.equal(snapshot.runs, undefined, name);
    else
      assert.deepEqual(
        snapshot.runs,
        (captured(from.runs.capture) as { status: string }[]).map(
          ({ status }) => ({ status }),
        ),
        `${name}: runs are ${from.runs.capture} projected to status`,
      );
  }
});

test('each state carries what its caller prints: run, conclusion, merge commit and heads', () => {
  const state = (name: string) => {
    const f = fixture(name);
    return classify(answersOf(f), f.expected);
  };
  const head = fixture('merged').expected.head;
  assert.deepEqual(state('merged'), {
    kind: 'merged',
    mergeCommit: 'add3abc8a898d2289824da10a37b523ebbbfbe6a',
  });
  assert.deepEqual(state('head-moved-merged'), {
    kind: 'head-moved',
    at: head,
    merged: true,
  });
  assert.deepEqual(state('head-moved'), {
    kind: 'head-moved',
    at: head,
    merged: false,
  });
  assert.deepEqual(state('updating'), { kind: 'updating', shows: head });
  const red = state('red');
  assert.ok(red.kind === 'red');
  assert.equal(red.conclusion, 'FAILURE');
  assert.equal(red.run, '44620239603');
  assert.equal(red.check.id, 135902079232);
  const green = state('green');
  assert.ok(green.kind === 'green');
  assert.equal(green.check.id, 135080025160);
  assert.equal(green.run, '44381299774');
  const superseded = state('superseded');
  assert.ok(superseded.kind === 'superseded');
  assert.equal(superseded.check.conclusion, 'FAILURE');
  const running = state('running');
  assert.ok(running.kind === 'running');
  assert.equal(running.check.status, 'IN_PROGRESS');
});

test('the verbatim pr view ship asks for today classifies as is, and a malformed answer throws', () => {
  // `gh pr view 1131 --json state,headRefOid,mergeable,autoMergeRequest,mergeCommit,statusCheckRollup`:
  // fields beyond PR_VIEW_FIELDS (the rollup, null on a fresh head per #1188) are never read.
  const text =
    capture('fixtures/gh', 'pr-1131-merged-view').streams.stdout?.toString(
      'utf8',
    ) ?? '';
  const expected = {
    head: '211ffa184a97429853b53a6de11d13553b19bf17',
    context: 'Check',
    mergeRequested: true,
  };
  assert.equal(classify({ view: text }, expected).kind, 'merged');
  const fresh = JSON.stringify({
    ...JSON.parse(text),
    state: 'OPEN',
    mergeCommit: null,
    statusCheckRollup: null,
  });
  assert.equal(classify({ view: fresh }, expected).kind, 'no-check');
  assert.throws(() => classify({ view: '{"state":"DRAFT"}' }, expected));
  assert.throws(() => classify({ view: fresh, checkRuns: '[' }, expected));
});

test('only the required context of the required App decides the check state', () => {
  const base = fixture('green');
  const expected = base.expected;
  const rows = base.snapshot.checkRuns ?? [];
  const newer = '2026-11-19T00:00:00Z';
  // A newer red `Check` of another App, or a red `<caller> / Check`, never overrides the green one (#1354, #1514).
  for (const other of [
    { appId: 99, name: 'Check' },
    { appId: 15368, name: 'expected-red / Check' },
  ]) {
    const foreign = {
      ...other,
      id: 1,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      startedAt: newer,
      detailsUrl: null,
    };
    assert.equal(
      classify(answersOf(base, [...rows, foreign]), expected).kind,
      'green',
      other.name,
    );
  }
  // Another App's unfinished check is no evidence that the required Check will come.
  const elsewhere = {
    id: 2,
    name: 'Check',
    appId: 99,
    startedAt: newer,
    status: 'IN_PROGRESS',
    conclusion: '',
    detailsUrl: null,
  };
  assert.equal(
    classify(answersOf(base, [elsewhere]), expected).kind,
    'no-check',
  );
  // The context the branch rules name is the one judged.
  assert.equal(
    classify(answersOf(base), { ...expected, context: 'ci / Check' }).kind,
    'no-check',
  );
});

test('a completed required run without a conclusion is still running, and only SUCCESS is green', () => {
  const base = fixture('green');
  const vary = (conclusion: string) =>
    answersOf(
      base,
      (base.snapshot.checkRuns ?? []).map((row) =>
        row.id === 135080025160 ? { ...row, conclusion } : row,
      ),
    );
  assert.equal(classify(vary(''), base.expected).kind, 'running');
  for (const conclusion of ['CANCELLED', 'NEUTRAL', 'SKIPPED', 'STALE']) {
    const state = classify(vary(conclusion), base.expected);
    assert.ok(state.kind === 'red', conclusion);
    assert.equal(state.conclusion, conclusion);
  }
});
