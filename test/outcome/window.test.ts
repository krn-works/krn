import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { turnDollars, usageOf } from '../../src/outcome/slice-cost.ts';
import { collectWindow, renderWindow } from '../../src/outcome/window.ts';

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
