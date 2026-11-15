import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  judge,
  parseClaim,
  parseOutsideRows,
  planOf,
  type Records,
  scoreTasks,
} from '../../src/brain/exposures.ts';
import { allTaskQualityFailures } from '../../src/brain/task-quality.ts';
import { ledgerCommand } from '../../src/cli/ledger.ts';

// Verbatim from .krn/runs/outside/summary.txt (clean drains and a no-drain row).
const OUTSIDE = `krn-works/krn outside/php | php | 0 | none | 73 | none | 1 | $0.00
krn-works/krn outside/php | php | 0 | 52c9dd5 | 0 | 52c9dd5 (all merged) | 1 | $0.12
krn-works/krn outside/py | py | 0 | 53e0c32 | 0 | 53e0c32 (all merged) | 1 | $0.16
krn-works/krn outside/npm | npm | 0 | c6f42f7 | 0 | c6f42f7 (all merged) | 1 | $0.17
krn-works/krn outside/npm | npm | 1 | none | not run | none | 0 | $0.00 | ENOENT: no such file or directory
`;
// Verbatim proof lines from .krn/brain/exposures.jsonl.
const records: Records = {
  proofs: new Map([
    [
      't-hit',
      'proof: clauses 2/3, red-first 0, precedent 5 modules, stop refusals 1',
    ],
    [
      't-miss',
      'proof: clauses 0/3, red-first 0, precedent 10 modules, stop refusals 1',
    ],
  ]),
  outside: parseOutsideRows(OUTSIDE),
};

test('clause 6: a proof-line prediction scores one hit, one miss and one unmeasured', () => {
  const claim = parseClaim('Predicted: proof clauses >= 2');
  assert.ok(claim);
  assert.equal(judge(claim, 't-hit', records), 'hit');
  assert.equal(judge(claim, 't-miss', records), 'miss');
  assert.equal(judge(claim, 't-none', records), 'unmeasured');
});

test('clause 7: outside-row predictions read verbatim summary rows and skip rows that did not run', () => {
  assert.equal(records.outside?.length, 5);
  const three = parseClaim('Predicted: outside drain == 0 in >= 3 rows');
  const four = parseClaim('Predicted: outside drain == 0 in >= 4 rows');
  assert.ok(three && four);
  assert.equal(judge(three, 't-x', records), 'hit');
  assert.equal(judge(four, 't-x', records), 'miss');
  assert.equal(
    judge(three, 't-x', { proofs: new Map(), outside: undefined }),
    'unmeasured',
  );
});

test('clause 4 and clause 5: tasks group into plans by their Source line, else their Why line without the slice number', () => {
  assert.equal(
    planOf(
      'Why: Fable 1115g slice 3; src/brain/precedent.ts reads only TS.\nOutcome: x',
    ),
    'Fable 1115g',
  );
  assert.equal(planOf('Source: Fable 1116a\nWhy: slice 2; y'), 'Fable 1116a');
  const card = scoreTasks(
    [
      {
        id: 't-hit',
        status: 'closed',
        text: 'Why: Fable 1115g slice 1; a\nPredicted: proof clauses >= 2',
      },
      {
        id: 't-miss',
        status: 'closed',
        text: 'Why: Fable 1115g slice 2; a\nPredicted: proof clauses >= 2',
      },
      {
        id: 't-none',
        status: 'closed',
        text: 'Why: Fable 1115g slice 3; a\nPredicted: proof clauses >= 2',
      },
      { id: 't-old', status: 'closed', text: 'Why: Fable 1115g slice 4; a' },
      {
        id: 't-open',
        status: 'open',
        text: 'Why: Fable 1115g slice 5; a\nPredicted: proof clauses >= 2',
      },
    ],
    records,
  );
  assert.deepEqual(card.get('Fable 1115g'), {
    hit: ['t-hit'],
    miss: ['t-miss'],
    unmeasured: ['t-none'],
    unpredicted: ['t-old'],
  });
});

test('clause 8 and clause 12: a Predicted line is optional and never fails the task-quality rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'predictions-quality-'));
  try {
    mkdirSync(join(root, 'tasks'));
    const body = [
      'Outcome: krn ledger prints 1 scorecard row.',
      'Files: src/outcome/predictions.ts',
      'Proof: a ledger test scores one hit',
    ];
    for (const [id, extra] of [
      ['t-aaaaaaa', ['Predicted: proof clauses >= 2']],
      ['t-bbbbbbb', []],
    ] as const)
      writeFileSync(
        join(root, 'tasks', `${id}.json`),
        JSON.stringify({
          id,
          status: 'open',
          resolution: null,
          created: '2026-11-15',
          priority: 1,
          title: 't',
          after: [],
          body: [...body, ...extra],
        }),
      );
    assert.deepEqual(allTaskQualityFailures(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clause 9, clause 10 and clause 11: krn ledger --predictions prints the scorecard from task, exposure and outside records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'predictions-cli-'));
  const write = process.stdout.write;
  try {
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, '.krn/brain'), { recursive: true });
    mkdirSync(join(root, '.krn/runs/outside'), { recursive: true });
    writeFileSync(join(root, '.krn/runs/outside/summary.txt'), OUTSIDE);
    writeFileSync(
      join(root, '.krn/brain/exposures.jsonl'),
      `${JSON.stringify({ run: 'r', task: 't-hit', channel: 'lane', served: [], withheld: [], outcome: {}, lane_ok: true, rework: 0, proof: 'proof: clauses 2/3, red-first 0, precedent 5 modules, stop refusals 1' })}\n`,
    );
    for (const [id, line] of [
      ['t-hit', 'Predicted: proof clauses >= 2'],
      ['t-out', 'Predicted: outside drain == 0 in >= 9 rows'],
      ['t-gone', 'Predicted: proof red-first >= 1'],
    ])
      writeFileSync(
        join(root, 'tasks', `${id}.json`),
        JSON.stringify({
          id,
          status: 'closed',
          resolution: null,
          created: '2026-11-15',
          priority: 1,
          title: 't',
          after: [],
          body: ['Why: Fable 1115g slice 1; z', line],
        }),
      );
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    await ledgerCommand(['--predictions', '--root', root]);
    assert.equal(
      out,
      'plan | hit | miss | unmeasured | unpredicted\nFable 1115g | 1 | 1 | 1 | 0\n',
    );
  } finally {
    process.stdout.write = write;
    rmSync(root, { recursive: true, force: true });
  }
});

test('clause 9 and clause 10: the Fable plan brief template and the krn-lead skill require a Predicted line and the scorecard', async () => {
  const { readFileSync } = await import('node:fs');
  const brief = readFileSync('docs/program/fable-plan-brief.md', 'utf8');
  assert.match(brief, /Predicted:/u);
  assert.match(brief, /krn ledger --predictions/u);
  assert.match(brief, /\.krn\/runs\/outside\/summary\.txt/u);
  const skill = readFileSync('.agents/skills/krn-lead/SKILL.md', 'utf8');
  assert.match(skill, /docs\/program\/fable-plan-brief\.md/u);
});
