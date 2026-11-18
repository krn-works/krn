import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkOpenRedLimit, readOpenPrs } from '../../src/cli/lane-open-red.ts';
import {
  type CommandRun,
  gh,
  ghApiSync,
  ghPrListOpenSync,
  ghPrViewSync,
  ghRepoView,
} from '../../src/repo/gh.ts';

const capture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('gh runs the gh binary with the given argv and returns the captured reply', async () => {
  const calls: [string, string[]][] = [];
  const run: CommandRun = async (cmd, args) => {
    calls.push([cmd, args]);
    return capture('outcome-ledger/pr-list.json');
  };
  const reply = await gh(run, ['pr', 'list', '--state', 'merged']);
  assert.equal(reply, capture('outcome-ledger/pr-list.json'));
  assert.deepEqual(calls, [['gh', ['pr', 'list', '--state', 'merged']]]);
});

test('ghRepoView asks gh for the repository name as JSON', async () => {
  const calls: [string, string[]][] = [];
  const run: CommandRun = async (cmd, args) => {
    calls.push([cmd, args]);
    return capture('gh/repo-krn-works-krn.stdout.json');
  };
  assert.equal(
    await ghRepoView(run),
    capture('gh/repo-krn-works-krn.stdout.json'),
  );
  assert.deepEqual(calls, [
    ['gh', ['repo', 'view', '--json', 'nameWithOwner']],
  ]);
});

test('the open PR list read replays the captured gh reply and treats its PR with a Check still running as pending', () => {
  const bin = mkdtempSync(join(tmpdir(), 'krn-gh-'));
  const fixture = fileURLToPath(
    new URL('../fixtures/gh/pr-list-open-rollup.stdout.json', import.meta.url),
  );
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat '${fixture}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    const reply = ghPrListOpenSync(bin);
    assert.equal(reply.status, 0);
    assert.equal(reply.stdout, capture('gh/pr-list-open-rollup.stdout.json'));
    const prs = readOpenPrs(bin);
    assert.ok(prs && prs.length > 0);
    process.env.KRN_OPEN_RED_MAX = '1';
    assert.doesNotThrow(() => checkOpenRedLimit(bin));
  } finally {
    delete process.env.KRN_OPEN_RED_MAX;
    process.env.PATH = before;
  }
});

// The PATH gh is the App wrapper: its token reaches only KRN_APP_REPOSITORY (default the product
// repository), so a read of an outside root without that scope saw a 404 and doctor --root
// reported the App as not installed on a repository its installation covers.
test('gh reads of a root run with the App token scoped to that root’s origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-root-scope-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'gh');
  writeFileSync(fake, '#!/bin/sh\nprintf %s "$KRN_APP_REPOSITORY"\n');
  chmodSync(fake, 0o755);
  const root = join(dir, 'outside');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', [
    '-C',
    root,
    'remote',
    'add',
    'origin',
    'https://github.com/krn-works/seo-audit-harness.git',
  ]);
  const saved = {
    path: process.env.PATH,
    scope: process.env.KRN_APP_REPOSITORY,
  };
  process.env.PATH = `${bin}:${saved.path ?? ''}`;
  process.env.KRN_APP_REPOSITORY = 'krn-works/krn';
  try {
    for (const reply of [
      ghApiSync(root, 'repos/{owner}/{repo}'),
      ghPrViewSync(root, 'number'),
      ghPrListOpenSync(root),
    ])
      assert.equal(reply.stdout, 'krn-works/seo-audit-harness');
  } finally {
    process.env.PATH = saved.path;
    if (saved.scope === undefined) delete process.env.KRN_APP_REPOSITORY;
    else process.env.KRN_APP_REPOSITORY = saved.scope;
  }
});
