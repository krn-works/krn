import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import { taskBrief } from '../../src/cli/lane-run/brief.ts';
import { redCheckBrief } from '../../src/cli/lane-run/red-check.ts';
import { laneRunCommand } from '../../src/cli/lane-run.ts';

// A lane session exports these; the tests start lanes of their own and must not inherit its class.
for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
  delete process.env[name];

// KRN-12: `krn lane run` end to end on an outside-shaped repository, the shape of the first outside
// pilot: no root package.json, code in packages/x, a krn.json contract with npm --prefix, a local
// bare remote. The session is a script that does what Claude did there. Only the GitHub steps
// (App token mint, PR merge) are stand-ins; ship receives the real worktree.
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

function write(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

const task = 't-out1234';

function outsideRepository() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-outside-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'outside test');
  git(repo, 'config', 'user.email', 'outside@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  write(repo, {
    '.gitignore': '.krn\nnode_modules\n',
    'krn.json': `${JSON.stringify(
      {
        base: 'main',
        tracker: 'krn',
        install:
          'npm --prefix packages/x install --no-audit --no-fund --offline',
        test: 'npm --prefix packages/x test',
      },
      null,
      2,
    )}\n`,
    'packages/x/package.json': `${JSON.stringify(
      {
        name: 'x',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    )}\n`,
    'packages/x/index.js': 'export const answer = () => 41;\n',
    'packages/x/test/answer.test.js':
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { answer } from '../index.js';\ntest('answers', () => assert.ok(answer() > 40));\n",
    [`tasks/${task}.json`]: `${JSON.stringify(
      {
        id: task,
        status: 'open',
        resolution: null,
        created: '2026-11-13',
        priority: 2,
        title: 'Answer 42',
        after: [],
        body: ['Outcome: answer() returns 42.'],
      },
      null,
      2,
    )}\n`,
  });
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  // Another lane merged meanwhile: origin is ahead, so the start's fetch must update origin/main.
  const other = join(base, 'other');
  git(base, 'clone', '-q', origin, other);
  git(other, 'config', 'user.name', 'outside test');
  git(other, 'config', 'user.email', 'outside@example.invalid');
  write(other, { 'README.md': 'x\n' });
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'other lane');
  git(other, 'push', '-q', 'origin', 'main');

  // The session: the sandbox mounts empty placeholders, Claude edits, closes the task and commits
  // with a Ticket line, a blank line, then Co-Authored-By (Ticket outside git's trailer block).
  const message = join(base, 'message.txt');
  writeFileSync(
    message,
    `feat(x): answer returns 42 (${task})\n\nThe answer was one short.\n\nTicket: ${task}\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>\n`,
  );
  const close = `node -e "const fs = require('node:fs'); const f = 'tasks/${task}.json'; const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.status = 'closed'; t.resolution = { kind: 'done', ref: null, note: 'answered' }; fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\\n');"`;
  const claude = join(base, 'claude');
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'set -e',
      ': > package.json; : > package-lock.json; : > .npmrc; : > .gitmodules; : > .yarnrc; : > .yarnrc.yml; : > bunfig.toml; : > .env',
      "printf 'export const answer = () => 42;\\n' > packages/x/index.js",
      close,
      'git add packages tasks',
      `git commit -q -F '${message}'`,
      `cat <<'JSON'\n${capture}\nJSON`,
      '',
    ].join('\n'),
  );
  chmodSync(claude, 0o755);
  return { base, repo, claude };
}

test('lane run delivers on an outside-shaped repository and reaches the ship step', async () => {
  const { base, repo, claude } = outsideRepository();
  // A concurrent lane start holds the remote-tracking ref lock for a moment (the pilot's fetch race).
  const lock = join(repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
  writeFileSync(lock, '');
  const releaser = spawn('sh', ['-c', `sleep 0.8; rm -f '${lock}'`]);
  const released = new Promise((resolve) => releaser.on('close', resolve));
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: string[][] = [];
  try {
    const verdict = await laneRunCommand(['--task', task, '--root', repo], {
      start: startLane,
      mint: async () => undefined,
      ship: async (args) => {
        shipped.push(args);
        const worktree = args[args.indexOf('--worktree') + 1] as string;
        // What ship receives: a clean tree whose only new commit is the session's.
        assert.equal(git(worktree, 'status', '--porcelain'), '');
        assert.match(
          git(worktree, 'log', '-1', '--format=%B'),
          new RegExp(`Ticket: ${task}\\n\\nCo-Authored-By`, 'u'),
        );
        return 'verdict: merged 1234567';
      },
    });
    await released;
    assert.equal(verdict.exitCode, 0, verdict.line);
    assert.match(
      verdict.line,
      new RegExp(`^lane ${task}: shipped verdict: merged 1234567`, 'u'),
    );
    assert.equal(shipped.length, 1);
    const args = shipped[0] as string[];
    assert.equal(
      args[args.indexOf('--title') + 1],
      `feat(x): answer returns 42 (${task})`,
    );
    const body = readFileSync(
      args[args.indexOf('--body-file') + 1] as string,
      'utf8',
    );
    assert.match(body, /npm --prefix packages\/x test PASS on the final tree/u);
    assert.equal(existsSync(join(repo, 'package.json')), false);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the brief of an outside repository names neither bin/krn nor npm run fast', () => {
  const { base, repo } = outsideRepository();
  try {
    const brief = taskBrief(repo, task);
    assert.match(brief, /`krn task close t-out1234 --as done/u);
    assert.match(brief, /Run `npm --prefix packages\/x test`/u);
    assert.doesNotMatch(brief, /bin\/krn|npm run fast/u);
    const red = redCheckBrief(
      repo,
      { run: '7', sha: 'a'.repeat(40) },
      new Error('no log'),
    );
    assert.match(red, /krn ci logs --run 7/u);
    assert.doesNotMatch(red, /bin\/krn|npm run fast/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
