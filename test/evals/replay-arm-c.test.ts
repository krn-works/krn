import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { driveSession } from '../../evals/replay/session.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** One unit over a local clone; the hidden test passes once fixed.txt exists. */
function fixture(root: string) {
  const clone = join(root, 'sources', 'o__r');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'n');
  writeFileSync(join(clone, 'a.txt'), '1\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const base = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'fixed.txt'), 'x\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const units = join(root, 'units');
  const id = 't-aaaaaaa';
  mkdirSync(join(units, id), { recursive: true });
  writeFileSync(join(units, id, 'hidden.txt'), 'present\n');
  writeFileSync(
    join(units, id, 'unit.json'),
    JSON.stringify({
      id,
      repo: 'o/r',
      base,
      reference,
      task: { title: 'Fix alpha', body: 'Why: alpha is broken' },
      spec: 's',
      hidden: { file: 'hidden.txt', dest: 'hidden.check' },
      install: 'true',
      test: 'test -f fixed.txt',
      committed: '2026-08-01',
      issue: 'https://github.com/o/r/issues/1',
    }),
  );
  return { units };
}

/**
 * A recorded `claude -p --output-format json` result (shape of a real lane session). The stub fixes the unit only when
 * the checkout carries KRN's adopted Stop hook and the brief names the task, so a pass proves both reached the session.
 */
function stub(root: string, fixes: boolean): string {
  const path = join(root, fixes ? 'claude' : 'claude-limit');
  const result = fixes
    ? '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.25}'
    : '{"type":"result","subtype":"success","is_error":true,"result":"usage limit","total_cost_usd":0}';
  writeFileSync(
    path,
    `#!/bin/sh\ngrep -q '"Stop"' .claude/settings.json || exit 3\ncase "$*" in *alpha*) ;; *) exit 4;; esac\n${fixes ? 'printf "x\\n" > fixed.txt\n' : ''}echo '${result}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function live(root: string, units: string, claude: string) {
  return spawnSync(
    'node',
    [
      'evals/replay/run.ts',
      '--arms',
      'C',
      '--units',
      '1',
      '--units-dir',
      units,
      '--sources',
      join(root, 'sources'),
      '--scratch',
      join(root, 'scratch'),
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_EVAL_CLAUDE: claude,
        KRN_EVAL_SLOT_DIR: join(root, 'slots'),
      },
    },
  );
}

test('a live arm-C row adopts KRN, runs the session through the driver and grades it', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-arm-c-'));
  try {
    const { units } = fixture(root);
    const r = live(root, units, stub(root, true));
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(r.stdout.split('\n')[0] as string);
    assert.deepEqual(
      [row.unit, row.arm, row.pass, row.cost],
      ['t-aaaaaaa', 'C', true, 0.25],
    );
    assert.match(r.stdout, /^verdict: 1 rows, 1 graded, 1 pass$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session that ended in an error result leaves its arm-C row ungraded and exits 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-arm-c-'));
  try {
    const { units } = fixture(root);
    const r = live(root, units, stub(root, false));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout.split('\n')[0] as string).pass, null);
    assert.match(r.stdout, /^verdict: 1 rows, 0 graded, 0 pass$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live rows refuse arms A and B with exit 69', () => {
  const r = spawnSync('node', ['evals/replay/run.ts', '--arms', 'A,C'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(r.status, 69);
});

test('the driver kills a session at its time limit and reports a timeout', async () => {
  const s = await driveSession({
    command: 'sh',
    argv: ['-c', 'sleep 30 & sleep 30'],
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 200,
    claude: 'sh',
  });
  assert.equal(s.timedOut, true);
  assert.equal(s.notStarted, false);
  assert.match(s.result.detail, /^session timeout after 0s/u);
});

test('the driver reports a missing claude as not started', async () => {
  const s = await driveSession({
    command: '/nonexistent/claude',
    argv: [],
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 5000,
    claude: '/nonexistent/claude',
  });
  assert.equal(s.notStarted, true);
  assert.match(s.result.detail, /not found/u);
});
