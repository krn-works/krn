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
import { suiteCommand } from '../../evals/units/screening.ts';
import type { Unit } from '../../evals/units/unit.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** One local clone, three units; the stub claude fixes alpha cleanly, fixes beta but breaks the suite, and fails gamma. */
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
  writeFileSync(join(clone, 'fixed.txt'), '');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const units = join(root, 'units');
  for (const [id, word] of [
    ['t-aaaaaaa', 'alpha'],
    ['t-bbbbbbb', 'beta'],
    ['t-ccccccc', 'gamma'],
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
        // The wider suite: green at base, red once a.txt holds "broken".
        suite: 'test "$(cat a.txt)" != broken',
        committed: '2026-08-01',
        issue: `https://github.com/o/r/issues/${id.charCodeAt(2)}`,
      }),
    );
  }
  const stub = join(root, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh
prompt="$*"
if echo "$prompt" | grep -q alpha; then touch fixed.txt
elif echo "$prompt" | grep -q beta; then touch fixed.txt; echo broken > a.txt
else touch tried.txt; fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.25}'
`,
  );
  chmodSync(stub, 0o755);
  return { units, stub };
}

test('a graded row records regressed true only when the passing change breaks a test that passed at base', (t) => {
  requiresIsolation(t, 'live arm sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'replay-regress-'));
  try {
    const { units, stub } = fixture(root);
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
          KRN_EVAL_MAX_SESSIONS: '1',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = Object.fromEntries(
      parseRows(readFileSync(rowsFile, 'utf8')).map((x) => [x.unit, x]),
    );
    assert.equal(rows['t-aaaaaaa']?.pass, true);
    assert.equal(rows['t-aaaaaaa']?.regressed, false);
    assert.equal(rows['t-bbbbbbb']?.pass, true);
    assert.equal(rows['t-bbbbbbb']?.regressed, true);
    assert.equal(rows['t-ccccccc']?.pass, false);
    assert.equal(rows['t-ccccccc']?.regressed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the suite command is the unit suite, else its test widened past the hidden file', () => {
  const u = (test: string, suite?: string): Unit =>
    ({
      test,
      ...(suite ? { suite } : {}),
      hidden: { dest: 'pkg/x_test.go' },
    }) as Unit;
  assert.equal(suiteCommand(u('t', 'make check')), 'make check');
  assert.equal(
    suiteCommand(u('timeout 240 go test -count=1 ./pkg/')),
    'timeout 240 go test -count=1 ./...',
  );
  assert.equal(
    suiteCommand(u('timeout 240 npx --no-install vitest run pkg/x_test.go')),
    'timeout 240 npx --no-install vitest run',
  );
});
