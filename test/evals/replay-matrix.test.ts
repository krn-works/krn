import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiskBudgetError } from '../../evals/replay/live.ts';
import { runMatrix } from '../../evals/replay/matrix.ts';
import { harnessSha } from '../../evals/replay/rows.ts';
import { loadUnits } from '../../evals/units/unit.ts';

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
  const prereg = join(root, 'prereg.md');
  writeFileSync(
    prereg,
    `reps: 1\nmodel: sonnet\ncontrasts: C-A, C-B\nalpha: 0.05\nmde-pp: 16\n\n- ${id}\n`,
  );
  const claude = join(root, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\nprintf "x\\n" > fixed.txt\necho '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.25}'\n`,
  );
  chmodSync(claude, 0o755);
  return { units, prereg, claude, sources: join(root, 'sources'), id };
}

const matrixRun = (
  root: string,
  f: ReturnType<typeof fixture>,
  extra: Record<string, string> = {},
) =>
  spawnSync(
    'node',
    [
      'evals/replay/run.ts',
      '--prereg',
      f.prereg,
      '--units-dir',
      f.units,
      '--sources',
      f.sources,
      '--scratch',
      join(root, 'scratch'),
      '--rows',
      join(root, 'rows.jsonl'),
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_EVAL_CLAUDE: f.claude,
        KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        ...extra,
      },
    },
  );

const lines = (file: string) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('--prereg runs arms A, B and C with no --screen, then resumes without rerunning a written row', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-matrix-'));
  try {
    const f = fixture(root);
    const first = matrixRun(root, f);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /verdict: 3 rows written, 3 graded, 3 pass/);
    const rowsFile = join(root, 'rows.jsonl');
    const rows = lines(rowsFile).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.arm).sort(), ['A', 'B', 'C']);
    assert.ok(rows.every((r) => r.pass === true && r.unit === f.id));
    assert.equal(new Set(rows.map((r) => r.harness)).size, 1);
    // a stop after the second row leaves two rows; the rerun runs only the missing cell
    writeFileSync(rowsFile, `${lines(rowsFile).slice(0, 2).join('\n')}\n`);
    const resumed = matrixRun(root, f);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /verdict: 1 rows written, 1 graded, 1 pass/);
    assert.equal(lines(rowsFile).length, 3);
    const again = matrixRun(root, f);
    assert.match(again.stdout, /verdict: 0 rows written/);
    assert.equal(lines(rowsFile).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--prereg refuses rows of another harness and a prereg pinned to another harness', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-matrix-'));
  try {
    const f = fixture(root);
    writeFileSync(
      join(root, 'rows.jsonl'),
      `${JSON.stringify({ unit: f.id, arm: 'A', rep: 1, pass: true, cost: 1, harness: 'otherharness' })}\n`,
    );
    const mixed = matrixRun(root, f);
    assert.equal(mixed.status, 69);
    assert.match(mixed.stderr, /holds rows of harness otherharness/);
    rmSync(join(root, 'rows.jsonl'));
    writeFileSync(
      f.prereg,
      `${readFileSync(f.prereg, 'utf8')}harness-sha: deadbeef0000\n`,
    );
    const pinned = matrixRun(root, f);
    assert.equal(pinned.status, 69);
    assert.match(pinned.stderr, /is not the preregistered deadbeef0000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the matrix path stops on the disk budget with exit 73 before any unit and keeps no row', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-matrix-'));
  try {
    const f = fixture(root);
    const r = matrixRun(root, f, { KRN_LANE_MIN_FREE_GB: '999999999' });
    assert.equal(r.status, 73);
    assert.match(r.stderr, /replay disk budget/);
    assert.equal(readdirSync(root).includes('rows.jsonl'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the budget is checked before each unit: rows written so far stay, the run throws, and no checkout is left', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-matrix-'));
  const saved = { ...process.env };
  try {
    const f = fixture(root);
    process.env.KRN_EVAL_CLAUDE = f.claude;
    process.env.KRN_EVAL_SLOT_DIR = join(root, 'slots');
    const rowsFile = join(root, 'rows.jsonl');
    const scratch = join(root, 'scratch');
    const units = loadUnits(f.units);
    // free space reads fine until the first row is on disk, then falls below the budget
    const freeGb = () => {
      try {
        return readFileSync(rowsFile, 'utf8').length > 0 ? 0.1 : 100;
      } catch {
        return 100;
      }
    };
    await assert.rejects(
      runMatrix(units, {
        rowsFile,
        reps: 1,
        sources: f.sources,
        scratch,
        harness: harnessSha(join(repo, 'evals/replay')),
        freeGb,
      }),
      DiskBudgetError,
    );
    assert.equal(lines(rowsFile).length, 1);
    assert.equal(JSON.parse(lines(rowsFile)[0] as string).arm, 'A');
    // the finished cell's checkout is gone with its row
    assert.deepEqual(
      readdirSync(scratch).filter((n) => n.startsWith('session-')),
      [],
    );
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
