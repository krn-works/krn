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
import {
  adoptionTokens,
  inForceRecords,
  injectionTokens,
  renderStatic,
  STATIC_HEADER,
} from '../../evals/replay/arm-b.ts';
import { ARMS } from '../../evals/replay/arms.ts';
import { sessionArgv } from '../../evals/replay/session-args.ts';
import { adopt } from '../../src/adopt/adopt.ts';
import type { BrainRecord } from '../../src/brain/packet.ts';
import { tokens } from '../../src/brain/packet.ts';
import { lanePacket } from '../../src/brain/worker-packet.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const record = (
  id: string,
  text: string,
  tier?: 'floor' | 'reflex' | 'finish',
): BrainRecord => ({
  id,
  type: 'rule',
  text,
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
  source: 'test',
  ...(tier === undefined ? {} : { tier }),
});

test('A, B and C session argv differ only in the arm settings file', () => {
  const argv = (id: 'A' | 'B' | 'C') =>
    sessionArgv({
      bin: 'claude',
      prompt: 'Fix alpha\n\nWhy: alpha is broken',
      settings: `/scratch/arm-${ARMS[id].id.toLowerCase()}.json`,
    });
  const a = argv('A');
  for (const id of ['B', 'C'] as const) {
    const other = argv(id);
    assert.equal(other.length, a.length);
    const differing = other.filter((w, i) => w !== a[i]);
    assert.deepEqual(differing, [`/scratch/arm-${id.toLowerCase()}.json`]);
  }
  const text = a.join(' ');
  assert.match(text, /--model sonnet /);
  assert.match(text, /--max-budget-usd 5 /);
  assert.match(text, /--permission-mode bypassPermissions /);
  assert.match(text, /--disallowedTools WebFetch,WebSearch$/);
});

test('the static render adds whole records, floor first, until it reaches the target tokens', () => {
  const records = [
    record('r-b', 'b '.repeat(40), 'finish'),
    record('r-a', 'a '.repeat(40), 'floor'),
    record('r-c', 'c '.repeat(40), 'floor'),
  ];
  const r = renderStatic(records, 30);
  assert.deepEqual(r.records, ['r-a', 'r-c']);
  assert.ok(r.tokens >= 30);
  assert.ok(r.text.startsWith(`${STATIC_HEADER}\n\n- [r-a]`));
  assert.deepEqual(renderStatic(records, 0).records, []);
  assert.equal(renderStatic(records, 0).text, '');
  // Records that run out leave B below the target rather than inventing text.
  assert.equal(renderStatic(records, 10_000).records.length, 3);
});

test('the injection count of an unadopted checkout matches what adoption writes and the lane packet serves', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-arm-b-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"x","scripts":{"test":"true"}}\n',
    );
    git(root, 'init', '-q');
    const asOf = new Date().toISOString().slice(0, 10);
    const brief = 'Fix the commit message trailer and the agent state files';
    const before = inForceRecords(root, asOf);
    assert.ok(before.length > 0);
    const predicted = injectionTokens(before, root, 't-aaaaaaa', brief, asOf);
    adopt(root, {});
    const served = lanePacket(root, brief, asOf, 't-aaaaaaa');
    const written = tokens(readFileSync(join(root, 'AGENTS.md'), 'utf8'));
    assert.ok(Math.abs(written - adoptionTokens()) <= 2, `${written}`);
    assert.equal(predicted, adoptionTokens() + (served?.tokens ?? 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('a live arm-B row runs a plain checkout with a static CLAUDE.md, no hooks, and prints both token counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-arm-b-'));
  try {
    const { units } = fixture(root);
    const stub = join(root, 'claude');
    // Fixes the unit only when CLAUDE.md carries rendered records and no KRN hook is installed.
    writeFileSync(
      stub,
      `#!/bin/sh\ngrep -q '^# Repository conventions' CLAUDE.md || exit 3\ntest ! -e .claude/settings.json || exit 4\ncase "$*" in *alpha*) ;; *) exit 5;; esac\nprintf "x\\n" > fixed.txt\necho '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.25}'\n`,
    );
    chmodSync(stub, 0o755);
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--arms',
        'B',
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
          KRN_EVAL_CLAUDE: stub,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split('\n');
    const row = JSON.parse(out[0] as string);
    assert.deepEqual(
      [row.unit, row.arm, row.pass, row.cost],
      ['t-aaaaaaa', 'B', true, 0.25],
    );
    assert.match(
      out[1] as string,
      /^tokens: unit t-aaaaaaa B static \d+ C injection \d+/u,
    );
    assert.match(r.stdout, /^verdict: 1 rows, 1 graded, 1 pass$/mu);
    assert.ok(readFileSync(join(root, 'scratch', 't-aaaaaaa-B-1.log'), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
