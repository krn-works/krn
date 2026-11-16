import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  judge,
  parseClaim,
  parseOutsideRows,
  planOf,
  predictionScorecard,
  type Records,
  scoreTasks,
} from '../../src/brain/exposures.ts';
import { metricReader, readMetricRegistry } from '../../src/brain/metrics.ts';
import { ledgerCommand } from '../../src/cli/ledger.ts';
import { allTaskQualityFailures } from '../../src/task/quality.ts';

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
  assert.equal(
    planOf(
      'Why: .krn/runs/overnight/fable-direction-1115c.md slice 1. Outcome: rows run.',
    ),
    '.krn/runs/overnight/fable-direction-1115c.md',
  );
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
      'plan | hit | miss | unmeasured | unpredicted\nFable 1115g | 1 | 0 | 2 | 0\n',
    );
  } finally {
    process.stdout.write = write;
    rmSync(root, { recursive: true, force: true });
  }
});

test('clause 9 and clause 10: the Fable plan brief template and the lead rules require a Predicted line and the scorecard', async () => {
  const { readFileSync } = await import('node:fs');
  const brief = readFileSync('docs/program/fable-plan-brief.md', 'utf8');
  assert.match(brief, /Predicted:/u);
  assert.match(brief, /krn ledger --predictions/u);
  assert.match(brief, /\.krn\/runs\/outside\/summary\.txt/u);
  const skill = readFileSync('docs/program/lead-rules.md', 'utf8');
  assert.match(skill, /docs\/program\/fable-plan-brief\.md/u);
});

const ROWS_AFTER_MERGE = `krn-works/outside-py outside/py | py | 0 | ooooooo | 0 | ooooooo (all merged) | 1 | $5.00 | pass | ooooooo | 3/3 | none | 0 | 8
krn-works/outside-py outside/py | py | 0 | aaaaaaa | 0 | aaaaaaa (all merged) | 1 | $0.20 | pass | aaaaaaa | 3/3 | none | 0 | 8
krn-works/outside-py outside/py | py | 0 | bbbbbbb | 0 | bbbbbbb (all merged) | 1 | $0.30 | fail | bbbbbbb | 3/3 | none | 0 | 8
krn-works/outside-py outside/py | py | 0 | ccccccc | 0 | ccccccc (all merged) | 1 | $9.00 | none | skew ccccccc != ddddddd
`;
const order = ['ooooooo', 'merge00', 'aaaaaaa', 'bbbbbbb'];
const afterMerge: Records = {
  proofs: new Map(),
  outside: parseOutsideRows(ROWS_AFTER_MERGE),
  merges: new Map([['t-x', 'merge00']]),
  descends: (ancestor, commit) =>
    order.includes(ancestor) &&
    order.indexOf(commit) >= order.indexOf(ancestor),
};

test('clause 7: outside predictions score only rows whose hook commit is at or after the merge', () => {
  const claim = parseClaim('Predicted: outside usd <= 1 in >= 2 rows');
  const both = parseClaim('Predicted: outside usd <= 1 in >= 3 rows');
  assert.ok(claim && both);
  assert.equal(judge(claim, 't-x', afterMerge), 'hit');
  assert.equal(judge(both, 't-x', afterMerge), 'miss');
  assert.equal(judge(claim, 't-unmerged', afterMerge), 'unmeasured');
  const none = { ...afterMerge, merges: new Map([['t-x', 'zzzzzzz']]) };
  assert.equal(judge(claim, 't-x', none), 'unmeasured');
});

test('clause 6: the hidden field counts pass as 1, fail as 0 and skips none', () => {
  const pass = parseClaim('Predicted: outside hidden == 1 in >= 1 rows');
  const fail = parseClaim('Predicted: outside hidden == 0 in >= 1 rows');
  assert.ok(pass && fail);
  assert.equal(judge(pass, 't-x', afterMerge), 'hit');
  assert.equal(judge(fail, 't-x', afterMerge), 'hit');
  assert.equal(judge(pass, 't-x', records), 'unmeasured');
});

test('clause 8: the scorecard prints hit or miss for a task merged in a real git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'predictions-merge-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'a');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    git('commit', '-q', '--allow-empty', '-m', 'fix\n\nTicket: t-aaaaaaa');
    const merge = git('rev-parse', '--short', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'later');
    const later = git('rev-parse', '--short', 'HEAD');
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, '.krn/runs/outside'), { recursive: true });
    writeFileSync(
      join(root, 'tasks/t-aaaaaaa.json'),
      JSON.stringify({
        id: 't-aaaaaaa',
        status: 'closed',
        resolution: 'done',
        created: '2026-11-15',
        priority: 1,
        title: 't',
        after: [],
        body: [
          'Source: plan.md slice 1\nPredicted: outside usd <= 1 in >= 1 rows',
        ],
      }),
    );
    writeFileSync(
      join(root, '.krn/runs/outside/summary.txt'),
      `krn-works/o outside/py | py | 0 | ${merge} | 0 | ${merge} (all merged) | 1 | $0.20 | pass | ${later}\n`,
    );
    assert.equal(
      predictionScorecard(root),
      'plan | hit | miss | unmeasured | unpredicted\nplan.md | 1 | 0 | 0 | 0\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a metric prediction parses the plainest line and judges the registered metric value', () => {
  const claim = parseClaim('Predicted: metric src-lines <= 27300');
  assert.ok(claim);
  const at = (value: number | undefined): Records => ({
    proofs: new Map(),
    outside: undefined,
    metric: (name) => (name === 'src-lines' ? value : undefined),
  });
  assert.equal(judge(claim, 't-x', at(27000)), 'hit');
  assert.equal(judge(claim, 't-x', at(32000)), 'miss');
  assert.equal(judge(claim, 't-x', at(undefined)), 'unmeasured');
  const unregistered = parseClaim('Predicted: metric not-registered >= 1');
  assert.ok(unregistered);
  assert.equal(judge(unregistered, 't-x', at(5)), 'unmeasured');
});

test('metric predictions run the command of spec/metrics.json and a failing command stays unmeasured', () => {
  const root = mkdtempSync(join(tmpdir(), 'predictions-metric-'));
  try {
    mkdirSync(join(root, 'spec'));
    writeFileSync(
      join(root, 'spec/metrics.json'),
      JSON.stringify({
        metrics: {
          'five-things': { command: 'echo 5' },
          'broken-thing': { command: 'exit 3' },
          'wordy-thing': { command: 'echo many' },
        },
      }),
    );
    const read = metricReader(root);
    assert.equal(read('five-things'), 5);
    assert.equal(read('broken-thing'), undefined);
    assert.equal(read('wordy-thing'), undefined);
    assert.equal(read('absent-thing'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every metric named by a plan.md prediction is registered with a command', async () => {
  const { readFileSync } = await import('node:fs');
  const plan = readFileSync('docs/program/plan.md', 'utf8');
  const named = [...plan.matchAll(/Predicted: metric ([a-z][a-z0-9-]*)/gu)].map(
    (m) => m[1] as string,
  );
  assert.ok(named.length > 0);
  const registry = readMetricRegistry('.');
  assert.deepEqual(
    named.filter((name) => registry[name] === undefined),
    [],
  );
});
