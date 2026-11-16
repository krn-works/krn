import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { parseRows } from '../../evals/replay/screen.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Two fixture units over one local clone; the stub claude fixes only the unit whose prompt names "alpha". */
function fixture(root: string) {
  const clone = join(root, 'sources', 'o__r');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'n');
  writeFileSync(join(clone, 'a.txt'), '1');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const base = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'a.txt'), '2');
  git(clone, 'commit', '-q', '-am', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const units = join(root, 'units');
  for (const [id, word] of [
    ['t-aaaaaaa', 'alpha'],
    ['t-bbbbbbb', 'beta'],
    ['t-ccccccc', 'alpha'],
  ] as const) {
    mkdirSync(join(units, id), { recursive: true });
    writeFileSync(join(units, id, 'hidden.txt'), 'present\n');
    writeFileSync(
      join(units, id, 'unit.json'),
      JSON.stringify({
        id,
        repo: 'o/r',
        base,
        reference,
        task: { title: `Fix ${word}`, body: `Why: ${word} is broken` },
        spec: 's',
        hidden: { file: 'hidden.txt', dest: 'hidden.check' },
        install: 'true',
        test: 'test -f fixed.txt',
        committed: id === 't-ccccccc' ? '2026-01-01' : '2026-08-01',
        issue: `https://github.com/o/r/issues/${id.charCodeAt(2)}`,
      }),
    );
  }
  const log = join(root, 'sessions.log');
  const stub = join(root, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprompt=$(cat)\necho +1 >> ${log}\necho "$CLAUDE_CONFIG_DIR|$KRN_PROBE|$*" >> ${join(root, 'env.log')}\nsleep 0.4\nif echo "$prompt" | grep -q alpha; then touch fixed.txt; fi\necho "$prompt" > ${join(root, 'prompt-')}$$\necho -1 >> ${log}\necho '{"result":"ok","total_cost_usd":0.25}'\n`,
  );
  chmodSync(stub, 0o755);
  return { units, stub, log };
}

const peak = (log: string) => {
  let live = 0;
  let max = 0;
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    live += Number(l);
    max = Math.max(max, live);
  }
  return max;
};

test('--screen runs one arm-A session per unit under the slot cap and records graded rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub, log } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_PROBE: 'leak',
          KRN_EVAL_MAX_SESSIONS: '1',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.equal(rows.length, 2);
    const byUnit = Object.fromEntries(rows.map((x) => [x.unit, x]));
    assert.equal(byUnit['t-aaaaaaa']?.pass, true);
    assert.equal(byUnit['t-bbbbbbb']?.pass, false);
    for (const x of rows) {
      assert.equal(x.arm, 'A');
      assert.equal(x.cost, 0.25);
    }
    assert.equal(peak(log), 1);
    // Arm A: private config dir, no KRN variable, project settings only.
    for (const l of readFileSync(join(root, 'env.log'), 'utf8')
      .split('\n')
      .filter(Boolean)) {
      const [cfg, probe, args] = l.split('|');
      assert.equal(cfg, join(root, 'scratch', 'claude-config'));
      assert.equal(probe, '');
      assert.match(args as string, /--setting-sources project/);
    }
    assert.match(r.stdout, /verdict: no-go \(2 eligible units, 70 required\)/);
    assert.match(r.stdout, /^A pass rate: 50\.0% \(2 screened\)/m);
    // A second run grades nothing again; --reps 2 adds only the missing rep of each eligible unit.
    const again = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: '/nonexistent',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(parseRows(readFileSync(rowsFile, 'utf8')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--reps 2 records two graded rows per eligible unit and a unit passes when any rep passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub, log } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--reps',
        '2',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_EVAL_MAX_SESSIONS: '2',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.deepEqual(rows.map((x) => `${x.unit}/${x.rep}`).sort(), [
      't-aaaaaaa/1',
      't-aaaaaaa/2',
      't-bbbbbbb/1',
      't-bbbbbbb/2',
    ]);
    assert.ok(peak(log) <= 2);
    assert.match(r.stdout, /A pass rate: 50\.0% \(2 screened\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
