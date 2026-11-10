import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLane } from '../../src/cli/lane.ts';
import { laneRunCommand, parseSessionResult } from '../../src/cli/lane-run.ts';

// KRN-12: the session result is a verbatim `claude -p --output-format json` capture;
// a stand-in claude executable prints it, the repositories are real git repositories.
const capture = readFileSync(
  fileURLToPath(
    new URL('../fixtures/claude/headless-session-result.json', import.meta.url),
  ),
  'utf8',
);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(action: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-run-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane run test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(
    join(repo, 'tasks', 't-abc1234.json'),
    `${JSON.stringify(
      {
        id: 't-abc1234',
        status: 'open',
        resolution: null,
        created: '2026-11-09',
        priority: 3,
        title: 'Lane run task',
        after: [],
        body: ['Outcome: o'],
      },
      null,
      2,
    )}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const claude = join(base, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\n${action}\ncat <<'JSON'\n${capture}\nJSON\n`,
  );
  chmodSync(claude, 0o755);
  return { base, repo, claude };
}

async function run(action: string, ship = async () => 'unreachable') {
  const { base, repo, claude } = fixture(action);
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship,
      },
    );
    return { verdict, repo };
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
}

test('parseSessionResult reads the captured result', () => {
  const result = parseSessionResult(capture);
  assert.deepEqual(result, {
    ok: true,
    detail: 'session success',
    cost: 0.08594,
  });
  assert.equal(parseSessionResult('not json').ok, false);
  assert.equal(
    parseSessionResult(
      JSON.stringify({ ...JSON.parse(capture), is_error: true }),
    ).ok,
    false,
  );
});

test('lane run ships a committed task and prints the ship verdict', async () => {
  const { verdict } = await run(
    'git commit -q --allow-empty -m "feat(x): done (t-abc1234)"',
    async () => 'merged\nverdict: merged abc1234',
  );
  assert.equal(verdict.exitCode, 0);
  assert.match(
    verdict.line,
    /^lane t-abc1234: shipped verdict: merged abc1234 cost \$0\.09$/u,
  );
});

test('lane run reports no commit and keeps the worktree', async () => {
  const { verdict } = await run('true');
  assert.equal(verdict.exitCode, 74);
  assert.match(
    verdict.line,
    /^lane t-abc1234: no commit \(worktree .+\) cost \$0\.09$/u,
  );
});

test('lane run reports a dirty tree and does not ship', async () => {
  const { verdict } = await run('echo x > stray.txt');
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /^lane t-abc1234: dirty tree /u);
});
