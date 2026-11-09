import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const path = '../../src/outcome/ledger.ts';
const ledger = await import(path).catch(() => ({}));
const fixture = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/outcome-ledger/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

test('accepted outcome evidence and collectors', async () => {
  for (const name of [
    'reviewTotals',
    'workerTotals',
    'parseTranscript',
    'attributeSession',
    'gateTotals',
    'collectLedger',
    'renderLedger',
  ])
    assert.equal(typeof ledger[name], 'function', name);
  const review = await fixture('review-record');
  assert.equal(
    ledger.reviewTotals([review, review], 'krn-works/krn', 240).attempts,
    1,
  );
  assert.equal(
    ledger.reviewTotals([review], 'krn-works/krn', 240).input,
    658190,
  );
  const bad = structuredClone(review);
  bad.judges[0].usage = null;
  assert.equal(ledger.reviewTotals([bad], 'krn-works/krn', 240).input, null);
  const empty = structuredClone(review);
  empty.judges = [];
  assert.equal(ledger.reviewTotals([empty], 'krn-works/krn', 240).input, 0);
  const metrics = await fixture('worker-metrics');
  assert.deepEqual(ledger.workerTotals([[metrics]]), {
    rounds: 1,
    input: 988510,
    cached: 926208,
    output: 11100,
  });
  assert.equal(
    ledger.workerTotals([
      [
        metrics,
        {
          ...metrics,
          round: 2,
          cumulative: { input: 1000000, cached: 930000, output: 12000 },
        },
      ],
    ]).input,
    1000000,
  );
  const transcript = await readFile(
    new URL('../fixtures/outcome-ledger/transcript.jsonl', import.meta.url),
    'utf8',
  );
  const session = ledger.parseTranscript(transcript.split('\n'));
  assert.deepEqual(session.tokens, {
    input: 4,
    cache_read: 179094,
    cache_creation: 1242,
    output: 730,
  });
  assert.deepEqual(session.launches, [0]);
  assert.deepEqual(session.launchPrs, [181]);
  assert.equal(
    ledger.attributeSession(session, [
      { number: 231, title: '' },
      { number: 181, title: '' },
    ]),
    null,
  );
  assert.equal(
    ledger.attributeSession(session, [{ number: 181, title: '' }]),
    181,
  );
  const gates = ledger.gateTotals([await fixture('check-runs-rerun')]);
  assert.deepEqual(gates, { runs: 2, reruns: 1, minutes: 25 });
  assert.equal(
    ledger.gateTotals([await fixture('check-runs-pending')]).minutes,
    null,
  );
  assert.equal(ledger.gateTotals([{ check_runs: [] }]).runs, null);
  const root = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const put = async (name: string, value: string) => {
      await mkdir(join(root, name, '..'), { recursive: true });
      await writeFile(join(root, name), value);
    };
    await put(
      '.krn/runs/review-series/a/records/2.json',
      JSON.stringify(review),
    );
    await put(
      '.krn/archive/review-series-a/records/2.json',
      JSON.stringify(review),
    );
    await put(
      '.krn/runs/slice/t-dwkrwej/journal.json',
      JSON.stringify({
        brief: join(root, '.krn/runs/worker/t-dwkrwej/brief.md'),
      }),
    );
    await put(
      '.krn/runs/worker/t-dwkrwej/rounds/001/metrics.json',
      JSON.stringify(metrics),
    );
    await put(
      '.krn/runs/worker/t-dwkrwej/rounds-final/metrics.json',
      JSON.stringify(metrics),
    );
    await put('.krn/runs/slice/t-dwkrwej/landing.exit', '7');
    await put('transcripts/session.jsonl', transcript);
    await put('transcripts/subagents/ignored.jsonl', transcript);
    await put('transcripts/bad.jsonl', '{bad');
    await put('.krn/runs/review-series/a/records/bad.json', '{bad');
    const prs = await fixture('pr-list');
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      if (cmd === 'git') throw new Error('no repository');
      assert.equal(cmd, 'gh');
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args[0] === 'pr')
        return JSON.stringify({ commits: [{ oid: 'head' }] });
      return JSON.stringify({ check_runs: [] });
    };
    const report = await ledger.collectLedger({
      root,
      transcripts: join(root, 'transcripts'),
      repo: 'krn-works/krn',
      limit: 2,
      run,
      now: Date.parse('2027-01-01'),
    });
    assert.deepEqual(
      report.rows.map((r: { number: number }) => r.number),
      [240, 241],
    );
    assert.equal(report.rows[0].review.input, 658190);
    assert.equal(report.rows[0].worker.input, 988510);
    assert.deepEqual(report.rows[0].deliver, [7]);
    assert.equal(report.rows[1].review.attempts, null);
    assert.equal(report.rows[1].worker.rounds, null);
    assert.equal(report.rows[1].lead.input, null);
    assert.equal(report.rows[1].deliver, null);
    assert.equal(report.rows[1].prGate.minutes, null);
    assert.ok(report.rows[1].mergeToMergeMinutes > 0);
    const text = ledger.renderLedger(report);
    assert.match(text, /unknown/);
    assert.match(text, /## Medians/);
    assert.match(text, /\| 1 \(7×1\) \|/);
    assert.match(text, /n=2/);
    assert.match(JSON.stringify(report), /null/);
    assert.ok(calls.some((a) => a.includes('22')));
    assert.deepEqual(report.rows[0].outcome, { status: 'unknown' });
    const filtered = await ledger.collectLedger({
      root,
      transcripts: '',
      repo: 'krn-works/krn',
      pr: 241,
      run,
    });
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].number, 241);
    await assert.rejects(
      ledger.collectLedger({
        root,
        repo: 'krn-works/krn',
        run: () => {
          throw new Error('failure');
        },
      }),
      { exitCode: 70 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects invalid flags with usage exit', () => {
  for (const args of [
    ['--pr', 'abc'],
    ['--bogus'],
    ['--limit', '0'],
    ['--since', '2026-02-30'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['src/cli/main.ts', 'ledger', ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 64, result.stderr);
  }
});

test('unknown evidence, attribution and output boundaries', async () => {
  assert.equal(typeof ledger.parseTranscript, 'function');
  const message = (id: string, command: string, extra = {}) =>
    JSON.stringify({
      message: {
        id,
        role: 'assistant',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
        content: [
          { type: 'tool_use', id, name: 'Bash', input: { command, ...extra } },
        ],
      },
    });
  const result = (id: string, content: string, is_error = false) =>
    JSON.stringify({
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content, is_error }],
      },
    });
  const session = ledger.parseTranscript([
    '{bad',
    message('a', 'krn deliver --pr 12', { run_in_background: true }),
    result('a', 'started'),
    message('b', 'krn deliver --pr 12'),
    result('b', 'Exit code 8', true),
    message('c', 'krn deliver --pr 12'),
    result('c', 'exit=2 deliver=3 exit=4'),
    message('d', 'echo t-aaaaaaa t-aaaaaaa #123'),
    JSON.stringify({
      isSidechain: true,
      message: { id: 'skip', role: 'assistant', usage: { input_tokens: 9999 } },
    }),
  ]);
  assert.deepEqual(session.launches, [null, 8, 4]);
  // The malformed first line makes the session totals unknown, never a partial sum.
  assert.equal(session.tokens.input, null);
  assert.equal(
    ledger.parseTranscript([message('z', 'true'), '']).tokens.input,
    10,
  );
  assert.equal(
    ledger.attributeSession(session, [
      { number: 12, title: '(t-bbbbbbb)' },
      { number: 123, title: '(t-aaaaaaa)' },
    ]),
    null,
  );
  assert.equal(
    ledger.attributeSession(session, [{ number: 1, title: '(t-aaaaaaa)' }]),
    1,
  );
  assert.equal(
    ledger.attributeSession(session, [{ number: 2, title: '' }]),
    null,
  );
  assert.deepEqual(ledger.workerTotals([]), {
    rounds: null,
    input: null,
    cached: null,
    output: null,
  });
  assert.deepEqual(ledger.reviewTotals([], 'krn-works/krn', 1), {
    attempts: null,
    input: null,
    cached: null,
    output: null,
  });
  const gate = await fixture('check-runs-rerun');
  gate.check_runs.forEach((r: { app: { id: number } }) => {
    r.app.id = 1;
  });
  assert.deepEqual(ledger.gateTotals([gate]), {
    runs: null,
    reruns: null,
    minutes: null,
  });
  const root = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
  try {
    const prs = await fixture('pr-list');
    prs[1].title = 'escaped | title\nprivate second line (t-dwkrwej)';
    // A journal brief outside the root is not scanned for worker metrics.
    const outside = await mkdtemp(join(tmpdir(), 'ledger-outside-'));
    await mkdir(join(outside, 'rounds/001'), { recursive: true });
    await writeFile(
      join(outside, 'rounds/001/metrics.json'),
      JSON.stringify(await fixture('worker-metrics')),
    );
    await mkdir(join(root, '.krn/runs/slice/t-dwkrwej'), { recursive: true });
    await writeFile(
      join(root, '.krn/runs/slice/t-dwkrwej/journal.json'),
      JSON.stringify({ brief: join(outside, 'brief.md') }),
    );
    // A deliver launch without --pr belongs to the session's attributed PR.
    await writeFile(
      join(root, 'session.jsonl'),
      [
        message('p', 'bin/krn task claim t-dwkrwej'),
        message('q', 'bin/krn deliver --task t-dwkrwej'),
        result('q', 'deliver=5'),
      ].join('\n'),
    );
    const run = (_cmd: string, args: string[]) =>
      args[1] === 'list' ? JSON.stringify(prs) : '{}';
    const report = await ledger.collectLedger({
      root,
      transcripts: root,
      repo: 'krn-works/krn',
      run,
      since: '2026-11-06',
    });
    assert.equal(report.rows.length, 3);
    const row240 = report.rows.find(
      (r: { number: number }) => r.number === 240,
    );
    assert.equal(row240.worker.rounds, null);
    assert.deepEqual(row240.deliver, [5]);
    assert.equal(row240.lead.input, 20);
    await rm(outside, { recursive: true, force: true });
    assert.equal(report.rows[2].mergeToMergeMinutes, null);
    assert.match(ledger.renderLedger(report), /escaped \\\| title/);
    assert.doesNotMatch(ledger.renderLedger(report), /private second line/);
    assert.equal(report.medians.judgeInput.n, 0);
    assert.equal(report.medians.judgeInput.value, null);
    // Exercise the actual command receiver with a fixed local gh executable.
    const gh = join(root, 'gh');
    await writeFile(
      gh,
      `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('list') ? ${JSON.stringify(JSON.stringify(prs))} : '{}');\n`,
      { mode: 0o700 },
    );
    for (const json of [false, true]) {
      const cli = spawnSync(
        process.execPath,
        [
          'src/cli/main.ts',
          'ledger',
          '--repo',
          'krn-works/krn',
          '--root',
          root,
          '--transcripts',
          root,
          ...(json ? ['--json'] : []),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        },
      );
      assert.equal(cli.status, 0, cli.stderr);
      if (json) assert.equal(JSON.parse(cli.stdout).rows[0].number, 240);
      else assert.match(cli.stdout, /## Medians/);
    }
    await writeFile(gh, `#!${process.execPath}\nprocess.exitCode = 1;\n`, {
      mode: 0o700,
    });
    const fail = spawnSync(
      process.execPath,
      ['src/cli/main.ts', 'ledger', '--repo', 'krn-works/krn'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      },
    );
    assert.equal(fail.status, 70, fail.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transcriptDirs finds the root and its worktree project directories only', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'krn-projects-'));
  try {
    for (const name of [
      '-r-krn',
      '-r-krn--krn-worktrees-lane-a',
      '-r-krn--krn-worktrees-lane-b',
      '-r-krn-betting',
      '-r-krn--claude-worktrees-x',
      '-other',
    ])
      await mkdir(join(projects, name));
    const dirs = await ledger.transcriptDirs('/r/krn', projects);
    assert.deepEqual(
      dirs.map((d: string) => d.slice(projects.length + 1)),
      [
        '-r-krn',
        '-r-krn--krn-worktrees-lane-a',
        '-r-krn--krn-worktrees-lane-b',
      ],
    );
    assert.deepEqual(
      await ledger.transcriptDirs('/r/krn', join(projects, 'none')),
      [join(projects, 'none', '-r-krn')],
    );
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});
