import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { turnDollars, usageOf } from '../../src/outcome/slice-cost.ts';
import {
  collectWindow,
  isLanePr,
  nonDeliveryCeiling,
  renderWindow,
  windowHeadline,
} from '../../src/outcome/window.ts';

const dollars = (model: string, usage: Record<string, number>) =>
  turnDollars({ model, usage: usageOf(usage), at: null, text: '', tools: [] });

test('the one price table keeps the operator-checked values', () => {
  // Sonnet 5.5 cache read $0.10 per million.
  assert.equal(
    dollars('claude-sonnet-5-5', { cache_read_input_tokens: 1e6 }),
    0.1,
  );
  // Fable 5.2: $8 input, $40 output, $0.20 cache read.
  assert.equal(dollars('claude-fable-5-2', { input_tokens: 1e6 }), 8);
  assert.equal(dollars('claude-fable-5-2', { output_tokens: 1e6 }), 40);
  assert.equal(
    dollars('claude-fable-5-2', { cache_read_input_tokens: 1e6 }),
    0.2,
  );
  // Haiku 5.5 prompts over 100K tokens bill five times the base.
  assert.equal(dollars('claude-haiku-5-5', { input_tokens: 100_000 }), 0.01);
  assert.equal(dollars('claude-haiku-5-5', { input_tokens: 200_000 }), 0.1);
  assert.equal(dollars('claude-unknown-9', { input_tokens: 1 }), null);
});

const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 9, 21, minute)).toISOString();
const line = (id: string, model: string, minute: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(minute),
    uuid: id,
    message: {
      id,
      role: 'assistant',
      model,
      usage: { input_tokens: 1_000_000 },
    },
  });

test('the window ledger and spend-window.py price the same transcripts alike', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'window-'));
  try {
    await mkdir(join(dir, 'lead'), { recursive: true });
    await writeFile(
      join(dir, 'lead.jsonl'),
      [
        line('a', 'claude-fable-5-2', 5),
        line('b', 'claude-sonnet-5-5', 6),
        line('c', 'claude-fable-5-2', 59), // outside the window
      ].join('\n'),
    );
    const prs = [
      {
        number: 7,
        title: 'One (t-aaaaaaa)',
        createdAt: at(1),
        mergedAt: at(10),
        headRefName: 'one',
        files: [],
      },
      {
        number: 8,
        title: 'Two (t-aaaaaaa)',
        createdAt: at(2),
        mergedAt: at(12),
        headRefName: 'two',
        files: [],
      },
    ];
    const run = (_cmd: string, args: string[]) =>
      args[0] === 'pr' ? JSON.stringify(prs) : '[]';
    const report = await collectWindow({
      from: at(0),
      to: at(30),
      repo: 'o/r',
      root: dir,
      transcripts: dir,
      run,
    });
    assert.equal(report.dollars.lead, 10);
    assert.equal(report.dollars.unpricedTurns, 0);
    assert.deepEqual(report.prs, [7, 8]);
    assert.deepEqual(report.tasks, {
      count: 1,
      withMorePrs: 1,
      prsWithoutTask: 0,
    });
    assert.match(renderWindow(report), /lead \$10\.00/);
    const script = fileURLToPath(
      new URL('../../scripts/claude/spend-window.py', import.meta.url),
    );
    // The script reads first-parent history of origin/main; give it a throwaway repository.
    const repo = join(dir, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const out = execFileSync(
      'python3',
      ['-I', script, at(0), at(30), dir, repo],
      { encoding: 'utf8' },
    );
    assert.match(out, /lead \$10\.00 /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a linked worktree is refused with its reason, the main checkout is not, and an empty window says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'window-wt-'));
  try {
    const main = join(dir, 'main');
    const linked = join(dir, 'linked');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          cwd,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          ...args,
        ],
        { encoding: 'utf8' },
      );
    await mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'x (t-aaaaaaa)');
    git(main, 'worktree', 'add', '-q', linked, '-b', 'lane');
    const options = {
      from: at(0),
      to: at(30),
      repo: 'o/r',
      transcripts: dir,
      run: () => '[]',
    };
    await assert.rejects(collectWindow({ ...options, root: linked }), (e) => {
      assert.match(String(e), /linked worktree/);
      assert.ok(String(e).includes(main), 'names the main checkout');
      assert.equal((e as { exitCode?: number }).exitCode, 64);
      return true;
    });
    const report = await collectWindow({ ...options, root: main });
    assert.equal(report.dollars.transcriptTurns, 0);
    assert.match(renderWindow(report), /NO TRANSCRIPT TURNS.*not \$0\.00/);
    assert.doesNotMatch(renderWindow(report), /lead \$/);
    // The retro has no window and runs in the same linked worktree.
    const retro = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)),
        'state',
        'retro',
        '--task',
        't-aaaaaaa',
        '--root',
        linked,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(retro.status, 0, retro.stderr);
    assert.match(retro.stdout, /- commits: 1 on HEAD name t-aaaaaaa/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the window names who held its dollars and the lines sum to the total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'window-holdings-'));
  const user = (text: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(1),
      message: { role: 'user', content: text },
    });
  const bash = (id: string, minute: number, command: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at(minute),
      message: {
        id,
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 1_000_000 },
        content: [
          { type: 'tool_use', id: `u${id}`, name: 'Bash', input: { command } },
        ],
      },
    });
  const session = async (
    name: string,
    lines: string[],
    subs: [string, string[]][] = [],
  ) => {
    await writeFile(join(dir, `${name}.jsonl`), lines.join('\n'));
    for (const [sub, subLines] of subs) {
      const folder = join(dir, name, 'subagents');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `${sub}.jsonl`), subLines.join('\n'));
      await writeFile(
        join(folder, `${sub}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose' }),
      );
    }
  };
  try {
    // Marked delivery lead with a lane (by worktree path) and a reader; the first prompt is not the launcher's.
    await session(
      'marked',
      [user('Do the slice'), line('m1', 'claude-fable-5-2', 5)],
      [
        [
          'agent-lane',
          [bash('l1', 6, 'cd /r/.krn/worktrees/slug && npm test')],
        ],
        ['agent-read', [bash('r1', 7, 'ls /r')]],
      ],
    );
    // Unmarked history: the launcher's sentence is a delivery lead; the program prompt is outside the per-task figure.
    await session('old', [
      user('First run `node scripts/claude/successor-launch.ts` then ...'),
      line('o1', 'claude-sonnet-5-5', 8),
    ]);
    await session(
      'program',
      [
        user('Lead the krn-architecture-program'),
        line('p1', 'claude-sonnet-5-5', 9),
      ],
      [['agent-p', [bash('p2', 10, 'ls')]]],
    );
    await session('headless', [
      user('Run the task'),
      line('h1', 'claude-sonnet-5-5', 12),
    ]);
    await session('probe', [
      user('reply ok'),
      line('q1', 'claude-sonnet-5-5', 11),
    ]);
    await mkdir(join(dir, '.krn/operator'), { recursive: true });
    await writeFile(
      join(dir, '.krn/operator/sessions.jsonl'),
      `${JSON.stringify({ session: 'marked', class: 'delivery', time: at(0) })}\n${JSON.stringify({ session: 'headless', class: 'lane', time: at(0) })}\n`,
    );
    const run = (_cmd: string, args: string[]) =>
      args[0] === 'pr' ? '[]' : '[]';
    const report = await collectWindow({
      from: at(0),
      to: at(30),
      repo: 'o/r',
      root: dir,
      transcripts: dir,
      run,
    });
    const by = Object.fromEntries(
      report.dollars.holdings.map((h) => [h.name, h]),
    );
    const one = dollars('claude-sonnet-5-5', { input_tokens: 1_000_000 }) ?? 0;
    const big = dollars('claude-fable-5-2', { input_tokens: 1_000_000 }) ?? 0;
    assert.equal(by['delivery lead']?.dollars, big + one);
    assert.equal(by['delivery lead']?.estimated, 1);
    // A headless `krn lane run` session is lane cost: not lead, and not estimated.
    assert.equal(by['delivery lanes']?.dollars, 2 * one);
    assert.equal(report.dollars.lanes, one);
    assert.equal(report.dollars.byClass['lane:main']?.sessions, 1);
    assert.equal(by['delivery other subagents']?.dollars, one);
    assert.equal(by['non-delivery: architecture program']?.dollars, 2 * one);
    assert.equal(by['non-delivery: other']?.dollars, one);
    const sum = report.dollars.holdings.reduce((n, h) => n + h.dollars, 0);
    assert.equal(
      sum,
      report.dollars.lead + report.dollars.lanes + report.dollars.subagents,
    );
    assert.match(renderWindow(report), /estimated/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the window headline leads with total dollars and points per merged PR and the non-delivery share', () => {
  const report = {
    prs: [1, 2, 3, 4, 5],
    plan: { fiveHour: 10 },
    dollars: {
      transcriptTurns: 9,
      holdings: [
        { name: 'delivery lead', dollars: 10.01 },
        { name: 'delivery lane', dollars: 4.99 },
        { name: 'research', dollars: 40 },
        { name: 'other', dollars: 45 },
      ],
    },
  };
  const headline = windowHeadline(report) ?? '';
  // 100.00 over 5 PRs; 15.00 delivery; 85 of 100 outside it; the cents add up.
  assert.match(
    headline,
    /^\$20\.00\/merged PR \(window total \$100\.00 over 5 PRs\)/,
  );
  assert.match(headline, /2\.00 five-hour points\/PR/);
  assert.match(headline, /non-delivery 85% \(\$85\.00\)/);
  assert.match(headline, /delivery only \$3\.00\/PR/);
  assert.equal(windowHeadline({ ...report, prs: [] }), null);
});

test('the ceiling refuses a window whose non-delivery share is above it and passes one at it', () => {
  const window = (delivery: number, other: number) => ({
    dollars: {
      holdings: [
        { name: 'delivery lead', dollars: delivery },
        { name: 'research', dollars: other },
      ],
    },
  });
  const over = nonDeliveryCeiling(window(60, 40));
  assert.equal(over?.over, true);
  assert.equal(over?.share, 0.4);
  const at = nonDeliveryCeiling(window(70, 30));
  assert.equal(at?.over, false);
  assert.equal(nonDeliveryCeiling(window(0, 0)), null);
});

test('the window reports the rework rate and the lane and lead PR split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'window-rework-'));
  try {
    const pr = (
      number: number,
      title: string,
      minute: number,
      branch: string,
      path: string,
      body = '',
    ) => ({
      number,
      title,
      body,
      createdAt: at(minute - 1),
      mergedAt: at(minute),
      headRefName: branch,
      files: [{ path, additions: 1, deletions: 0 }],
      mergeCommit: { oid: `${number}`.repeat(40).slice(0, 40) },
    });
    const prs = [
      pr(
        1,
        'feat: a (t-aaaaaaa)',
        1,
        'a',
        'src/a.ts',
        'Agent: headless claude session x',
      ),
      pr(2, 'feat: b (t-bbbbbbb)', 2, 'b', 'src/b.ts'),
      pr(3, 'fix: a again (t-ccccccc)', 3, 'c', 'src/a.ts'),
      // Outside the window: it does not count against #2.
      pr(4, 'fix: b again (t-ddddddd)', 40, 'd', 'src/b.ts'),
    ];
    const run = (_cmd: string, args: string[]) =>
      args[0] === 'pr' ? JSON.stringify(prs) : '[]';
    const report = await collectWindow({
      from: at(0),
      to: at(30),
      repo: 'o/r',
      root: dir,
      transcripts: dir,
      run,
      blamed: async () => true,
    });
    assert.deepEqual(report.rework.prs, [1]);
    assert.equal(report.rework.rate, 1 / 3);
    assert.deepEqual(report.authors, { lane: [1], lead: [2, 3] });
    assert.match(
      renderWindow(report),
      /rework within 48h: 1 of 3 PRs \(33%\); lane PRs 1, lead PRs 2/,
    );
    assert.equal(isLanePr({ body: '', branch: 'x-y' }, new Set(['x-y'])), true);
    assert.equal(isLanePr({ body: '', branch: 'x/y' }, new Set(['x-y'])), true);
    assert.equal(
      isLanePr(
        { body: '## Task\n\nAgent: x\n\nLane: krn lane brief\n', branch: 'z' },
        new Set(),
      ),
      true,
    );
    assert.equal(
      isLanePr({ body: 'Agent: Claude Sonnet', branch: 'z' }, new Set()),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fix is rework only when it changes lines the earlier commit introduced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rework-blame-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    const commit = async (file: string, text: string) => {
      await writeFile(join(dir, file), text);
      git('add', '.');
      git('commit', '-q', '-m', text.slice(0, 8));
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    const base = await commit('a.txt', 'one\ntwo\nthree\n');
    const intro = await commit('a.txt', 'one\ntwo\nthree\nfour\n');
    // Edits line 2, which the base commit introduced: not rework of intro.
    const old = await commit('a.txt', 'one\nTWO\nthree\nfour\n');
    // Edits line 4, which intro introduced: rework of intro.
    const hit = await commit('a.txt', 'one\nTWO\nthree\nFOUR\n');
    // Only appends a line: no old line changes.
    const add = await commit('a.txt', 'one\nTWO\nthree\nFOUR\nfive\n');
    const { fixChangesIntroducedLines: blame } = await import(
      '../../src/outcome/rework-blame.ts'
    );
    assert.equal(await blame(dir, intro, hit, ['a.txt']), true);
    assert.equal(await blame(dir, intro, old, ['a.txt']), false);
    assert.equal(await blame(dir, base, old, ['a.txt']), true);
    assert.equal(await blame(dir, intro, add, ['a.txt']), false);
    assert.equal(await blame(dir, intro, 'f'.repeat(40), ['a.txt']), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
