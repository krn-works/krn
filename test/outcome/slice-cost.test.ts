import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectLedger } from '../../src/outcome/ledger.ts';
import {
  addedLines,
  segmentTurns,
  sliceCosts,
  survivingLines,
  type Transcript,
  type Turn,
  turnDollars,
  usageOf,
} from '../../src/outcome/slice-cost.ts';

const turn = (text: string, extra: Partial<Turn> = {}): Turn => ({
  model: 'claude-opus-5-5',
  usage: usageOf({ input_tokens: 1_000_000 }),
  at: null,
  text,
  tools: [],
  ...extra,
});
const prs = [
  { number: 10, title: 'First (t-aaaaaaa)', mergedAt: '2026-11-01T10:00:00Z' },
  { number: 11, title: 'Second (t-bbbbbbb)', mergedAt: '2026-11-01T12:00:00Z' },
];

test('a session splits into slices bounded by the first and last pre-merge reference of each PR', () => {
  const at = (h: number) =>
    Date.parse(`2026-11-01T${String(h).padStart(2, '0')}:00:00Z`);
  const turns = [
    turn('git status', { at: at(9) }),
    turn('krn task claim t-aaaaaaa', { at: at(9) }),
    turn('bin/krn ci wait --pr 10', { at: at(10) }),
    // A turn between slices starts the next one.
    turn('npm run fast', { at: at(11) }),
    turn('gh pr merge 11 --auto', { at: at(11) }),
    // A mention after both merges (a handoff naming #10) moves no boundary.
    turn('echo next t-ccccccc', { at: at(13) }),
    turn('echo merged #10 t-aaaaaaa', { at: at(13) }),
  ];
  assert.deepEqual(segmentTurns(turns, prs), [
    null,
    10,
    10,
    11,
    11,
    null,
    null,
  ]);
  assert.deepEqual(segmentTurns([turn('ls')], prs), [null]);
});

test('turns are priced per model, cache write duration and Haiku long-prompt tier', () => {
  assert.equal(turnDollars(turn('')), 4);
  const split = usageOf({
    cache_creation_input_tokens: 2_000_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 1_000_000,
      ephemeral_1h_input_tokens: 1_000_000,
    },
    cache_read_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(turnDollars(turn('', { usage: split })), 5 + 8 + 0.2 + 20);
  assert.equal(turnDollars(turn('', { model: 'gpt-5' })), null);
  assert.equal(
    turnDollars(
      turn('', {
        model: 'claude-haiku-5-5',
        usage: usageOf({ input_tokens: 200_000 }),
      }),
    ),
    0.1,
  );
});

test('subagents bill to their own referenced PR, else to the slice that launched them', () => {
  const lead: Transcript = {
    role: 'lead',
    malformed: false,
    turns: [
      turn('krn task claim t-aaaaaaa', { tools: ['launch-reader'] }),
      turn('gh pr merge 10'),
    ],
  };
  const reader: Transcript = {
    role: 'subagent:Explore',
    malformed: false,
    parentTool: 'launch-reader',
    turns: [turn('rg foo', { model: 'claude-haiku-4-5' })],
  };
  const lane: Transcript = {
    role: 'subagent:general-purpose',
    malformed: false,
    parentTool: 'launch-reader',
    turns: [
      turn('git commit -m "x (t-bbbbbbb)"', { model: 'claude-sonnet-5-5' }),
      turn('bin/krn ci wait --pr 11', {
        model: 'claude-sonnet-5-5',
        usage: usageOf({ output_tokens: 10 }),
      }),
    ],
  };
  const costs = sliceCosts([lead], [reader, lane], prs);
  assert.deepEqual(costs.get(10), {
    dollars: 9,
    leadDollars: 8,
    subagentDollars: 1,
    turns: 2,
    subagentTurns: 1,
    unpricedTurns: 0,
    leadTokens: {
      input: 2_000_000,
      cache_read: 0,
      cache_creation: 0,
      output: 0,
    },
    author: { role: 'lead', model: 'claude-opus-5-5' },
  });
  assert.equal(costs.get(11)?.leadTokens, null);
  assert.deepEqual(costs.get(11)?.author, {
    role: 'subagent:general-purpose',
    model: 'claude-sonnet-5-5',
  });
  const broken = sliceCosts([{ ...lead, malformed: true }], [], prs);
  assert.equal(broken.get(10)?.dollars, null);
});

test('git evidence parsers count added and surviving lines', () => {
  assert.deepEqual(
    [...addedLines('3\t1\ta.ts\n-\t-\tlogo.png\n0\t4\tb.ts\n2\t0\tc => d\n')],
    [['a.ts', 3]],
  );
  const sha = 'a'.repeat(40);
  assert.equal(
    survivingLines(
      `${sha} 1 1 2\nfilename a.ts\n${'b'.repeat(40)} 3 3 1\n${sha} 4 4 1\n`,
      sha,
    ),
    3,
  );
});

test('the ledger reads a seven-day outcome from real git history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-outcome-'));
  const git = (date: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  try {
    git('2026-10-01T00:00:00Z', 'init', '-q', '-b', 'main');
    const commit = async (date: string, body: string, subject: string) => {
      await writeFile(join(root, 'a.ts'), body);
      git(date, 'add', 'a.ts');
      git(date, 'commit', '-q', '-m', subject);
      return git(date, 'rev-parse', 'HEAD');
    };
    await commit('2026-10-01T00:00:00Z', 'base\n', 'base');
    const kept = await commit(
      '2026-10-02T00:00:00Z',
      'base\nk1\nk2\n',
      'Kept (#1)',
    );
    const changed = await commit(
      '2026-10-03T00:00:00Z',
      'base\nk1\nk2\nc1\nc2\n',
      'Changed (#2)',
    );
    await commit('2026-10-04T00:00:00Z', 'base\nk1\nk2\nc1\nnew\n', 'Edit c2');
    // Lines rewritten after the seven-day window do not count.
    await commit('2026-10-20T00:00:00Z', 'base\nx\nk2\nc1\nnew\n', 'Late edit');
    await mkdir(join(root, 'transcripts'));
    const list = [
      {
        number: 2,
        title: 'Changed',
        createdAt: '2026-10-03T00:00:00Z',
        mergedAt: '2026-10-03T00:00:00Z',
        mergeCommit: { oid: changed },
      },
      {
        number: 1,
        title: 'Kept',
        createdAt: '2026-10-02T00:00:00Z',
        mergedAt: '2026-10-02T00:00:00Z',
        mergeCommit: { oid: kept },
      },
    ];
    const report = await collectLedger({
      root,
      repo: 'krn-works/krn',
      transcripts: join(root, 'transcripts'),
      run: (cmd, args) => {
        if (cmd === 'git') return execFileSync(cmd, args, { encoding: 'utf8' });
        if (args[1] === 'list') return JSON.stringify(list);
        return '{}';
      },
    });
    assert.deepEqual(
      report.rows.map((r) => [r.number, r.outcome]),
      [
        [2, { status: 'changed', added: 2, surviving: 1 }],
        [1, { status: 'kept', added: 2, surviving: 2 }],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a PR number named before the PR existed is not a reference; its task id is', () => {
  const pr = {
    number: 10,
    title: 'First (t-aaaaaaa)',
    createdAt: '2026-11-01T09:00:00Z',
    mergedAt: '2026-11-01T10:00:00Z',
  };
  const early = Date.parse('2026-10-23T12:00:00Z');
  assert.deepEqual(
    segmentTurns(
      [
        turn('echo issue #10', { at: early }),
        turn('krn task claim t-aaaaaaa', { at: early }),
      ],
      [pr],
    ),
    [null, 10],
  );
});
