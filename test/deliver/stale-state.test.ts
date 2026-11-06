import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DeliveryFailure, deliver } from '../../src/deliver/delivery.ts';
import { type Runner, run as runCommand } from '../../src/deliver/transport.ts';
import { reserveReviewAttempt } from '../../src/flow/series.ts';

const source = fileURLToPath(new URL('../..', import.meta.url));
const reviewFixture = join(
  source,
  'test/flow/fixtures/review-record-v1.fixture',
);
const repoName = 'krn-works/krn';
const pr = 138;
const task = 't-sbyye51';

function git(cwd: string, ...args: string[]) {
  const result = runCommand('git', args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-deliver-stale-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const worktree = join(root, 'delivery');
  const branch = 'feature/stale-state';
  mkdirSync(main);
  git(root, 'init', '--quiet', '--initial-branch=main', main);
  git(main, 'config', 'user.name', 'Delivery Test');
  git(main, 'config', 'user.email', 'delivery@example.test');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  const nodeVersion = runCommand('node', ['--version'], main).stdout;
  writeFileSync(join(main, '.node-version'), nodeVersion);
  writeFileSync(join(main, 'value.txt'), 'base\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'chore: fixture base');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'update-ref', 'refs/remotes/origin/main', base);
  git(main, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(main, 'value.txt'), 'head\n');
  git(main, 'add', 'value.txt');
  git(
    main,
    'commit',
    '--quiet',
    '-m',
    `feat: fixture delivery (${task})`,
    '-m',
    `Ticket: ${task}\nChange-contract: test/value.test.ts:red->green`,
  );
  const head = git(main, 'rev-parse', 'HEAD');
  const tree = git(main, 'rev-parse', `${head}^{tree}`);
  git(main, 'checkout', '--quiet', 'main');
  git(main, 'worktree', 'add', '--quiet', worktree, branch);

  const attempt = reserveReviewAttempt(
    main,
    { schemaVersion: 1, repository: repoName, pr, baseRef: 'main' },
    base,
    head,
  );
  const review = JSON.parse(readFileSync(reviewFixture, 'utf8'));
  const record = {
    ...review,
    headSha: head,
    base,
    toolSha: base,
    redFirst: [],
    contracts: [],
    redFirstCauses: [],
    attempt,
  };
  const recordPath = join(root, 'review.json');
  writeFileSync(recordPath, JSON.stringify(record));

  const key = createHash('sha256').update(`${repoName}\0${pr}`).digest('hex');
  const directory = join(main, '.krn', 'runs', 'deliver', key);
  const statePath = join(directory, 'state.json');
  const mergeMessagePath = join(directory, 'merge-message.txt');
  mkdirSync(directory, { recursive: true });
  const staleState = {
    repo: repoName,
    pr,
    head: 'c'.repeat(40),
    base,
    worktree,
    branch,
    message: 'old stale message\n\nTicket: t-oldstate',
  };
  const staleStateBytes = `${JSON.stringify(staleState, null, 2)}\n`;
  const staleMessage = 'old stale message\n\nTicket: t-oldstate\n';
  writeFileSync(statePath, staleStateBytes);
  writeFileSync(mergeMessagePath, staleMessage);

  const pull = {
    number: pr,
    title: `feat: fixture delivery (${task})`,
    draft: false,
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    head: { sha: head, ref: branch },
    base: { sha: base, ref: 'main', repo: { full_name: repoName } },
  };
  const checkRuns = [
    {
      id: 1,
      name: 'gate',
      head_sha: head,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
    },
  ];
  const runner: Runner = (command, args, cwd, input) => {
    if (command === 'gh') {
      const resource = args.find((arg) => arg.startsWith('repos/')) ?? '';
      if (resource.includes('/pulls/'))
        return { code: 0, stdout: JSON.stringify(pull), stderr: '' };
      if (resource.includes('/statuses?'))
        return { code: 0, stdout: '[[]]', stderr: '' };
      if (resource.includes('/statuses/'))
        return { code: 0, stdout: '{}', stderr: '' };
      if (resource.includes('/check-runs?'))
        return {
          code: 0,
          stdout: JSON.stringify([{ check_runs: checkRuns }]),
          stderr: '',
        };
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (command.endsWith('/bin/krn')) {
      if (args.includes('--dry-run'))
        return {
          code: 0,
          stdout: JSON.stringify({ head, dryRun: true, precheckedTree: tree }),
          stderr: '',
        };
      return {
        code: 1,
        stdout: '{"ok":false,"reason":"ship refused X"}\n',
        stderr: '',
      };
    }
    if (command === 'git' && args[0] === 'fetch')
      return { code: 0, stdout: '', stderr: '' };
    return runCommand(command, args, cwd, input);
  };
  let clock = 0;
  const options = {
    repo: repoName,
    pr,
    record: recordPath,
    task,
    dryRun: false,
    timeoutMs: 100,
    pollMs: 10,
  };
  const runtime = {
    cwd: worktree,
    run: runner,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    contracts: async () => {},
  };
  return {
    main,
    worktree,
    head,
    options,
    runtime,
    statePath,
    mergeMessagePath,
    staleStateBytes,
    staleMessage,
  };
}

test('delivery replaces stale unmerged state after binding the current record and PR head', async (t) => {
  const value = fixture(t);
  await assert.rejects(
    deliver(value.options, value.runtime),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryFailure);
      assert.equal(error.stage, 'ship');
      assert.match(error.message, /ship refused X/u);
      return true;
    },
  );
  const state = JSON.parse(readFileSync(value.statePath, 'utf8'));
  assert.equal(state.head, value.head);
  const message = readFileSync(value.mergeMessagePath, 'utf8');
  assert.notEqual(message, value.staleMessage);
  assert.match(message, new RegExp(task, 'u'));
});

test('dry-run ignores stale state without changing either persisted file', async (t) => {
  const value = fixture(t);
  const beforeState = readFileSync(value.statePath, 'utf8');
  const beforeMessage = readFileSync(value.mergeMessagePath, 'utf8');
  const result = await deliver(
    { ...value.options, dryRun: true },
    value.runtime,
  );
  assert.equal(result.status, 'dry-run');
  assert.equal(existsSync(value.statePath), true);
  assert.equal(readFileSync(value.statePath, 'utf8'), beforeState);
  assert.equal(readFileSync(value.mergeMessagePath, 'utf8'), beforeMessage);
  assert.equal(beforeState, value.staleStateBytes);
});
