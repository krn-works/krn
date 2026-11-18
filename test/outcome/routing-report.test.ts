import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { Row } from '../../evals/replay/rows.ts';
import { policyReport, type Role } from '../../evals/routing/report.ts';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const turn = (id: string, model: string, command: string, tokens: number) =>
  line({
    type: 'assistant',
    timestamp: '2026-11-01T09:15:00Z',
    message: {
      id,
      role: 'assistant',
      model,
      usage: { input_tokens: tokens },
      content: [
        { type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command } },
      ],
    },
  });
const report = resolve('evals/routing/report.ts');

test('all-attempts report charges abandoned and retried work to accepted merges per role and model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-report-'));
  try {
    await mkdir(join(root, 'transcripts'));
    await mkdir(join(root, 'bin'));
    // Opus 5.5 input costs $4 per million tokens: accepted task $4 + retry $4, abandoned task $8.
    await writeFile(
      join(root, 'transcripts/lead-1.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'go' } }) +
        turn('a', 'claude-opus-5-5', 'krn task show t-aaaaaaa', 1_000_000) +
        turn('b', 'claude-opus-5-5', 'krn task show t-aaaaaaa', 1_000_000) +
        turn('c', 'claude-opus-5-5', 'krn task show t-bbbbbbb', 2_000_000),
    );
    const list = [
      {
        number: 7,
        title: 'fix: one (t-aaaaaaa)',
        createdAt: '2026-11-01T08:00:00Z',
        mergedAt: '2026-11-01T10:00:00Z',
        mergeCommit: { oid: '7'.repeat(40) },
      },
    ];
    await writeFile(
      join(root, 'bin/gh'),
      `#!/bin/sh\ncase "$2" in list) cat <<'EOF'\n${JSON.stringify(list)}\nEOF\n;; *) echo '{}';; esac\n`,
    );
    await chmod(join(root, 'bin/gh'), 0o755);
    const run = spawnSync(
      process.execPath,
      [
        report,
        '--all-attempts',
        '--json',
        '--root',
        root,
        '--transcripts',
        join(root, 'transcripts'),
        '--repo',
        'krn-works/krn',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.assigned, 2);
    assert.equal(out.accepted, 1);
    assert.equal(out.abandoned, 1);
    assert.equal(out.abandonedDollars, 8);
    assert.equal(out.totalDollars, 16);
    assert.equal(out.perAccepted, 16);
    assert.deepEqual(out.routes, [
      {
        role: 'lead',
        model: 'claude-opus-5-5',
        tasks: 2,
        accepted: 1,
        dollars: 16,
        perAccepted: 16,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const row = (
  unit: string,
  pass: boolean | null,
  cost: number | null,
  model: string,
) => line({ unit, arm: 'A', rep: 1, pass, cost, harness: 'h', model });

test('policy report prices Sonnet-first and Sol-first with Opus after a red first attempt, on paired units', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-routing-policy-'));
  try {
    // u1: both first attempts pass. u2: both red, Opus passes. u3: Sol only realized on another model, so unpaired.
    await writeFile(
      join(root, 'sonnet.jsonl'),
      row('u1', true, 1, 'claude-sonnet-5-5') +
        row('u2', false, 1, 'claude-sonnet-5-5') +
        row('u3', true, 1, 'claude-sonnet-5-5'),
    );
    await writeFile(
      join(root, 'sol.jsonl'),
      row('u1', true, 0.5, 'gpt-6.2-sol') +
        row('u2', false, 0.4, 'gpt-6.2-sol') +
        row('u3', true, 0.1, 'gpt-6.1-sol'),
    );
    await writeFile(
      join(root, 'opus.jsonl'),
      row('u2', true, 3, 'claude-opus-5-5'),
    );
    const args = [
      '--all-attempts',
      '--sonnet',
      join(root, 'sonnet.jsonl'),
      '--sol',
      join(root, 'sol.jsonl'),
      '--opus',
      join(root, 'opus.jsonl'),
    ];
    const json = spawnSync(process.execPath, [report, ...args, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(json.status, 0, json.stderr);
    const out = JSON.parse(json.stdout);
    assert.equal(out.n, 2);
    assert.equal(out.excluded.sol, 1);
    assert.equal(out.policies.sonnet.perMerge, 2.5);
    assert.equal(out.policies.sol.perMerge, 1.95);
    assert.equal(out.policies.sol.accepted, 2);
    assert.ok(Math.abs(out.ratio - 0.78) < 1e-9);
    const text = spawnSync(process.execPath, [report, ...args], {
      encoding: 'utf8',
    });
    assert.equal(text.status, 0, text.stderr);
    assert.match(
      text.stdout,
      /^sonnet-first \(Opus after red\): \$2\.500 per accepted merge, 2\/2 accepted/m,
    );
    assert.match(
      text.stdout,
      /^sol-first \(Opus after red\): \$1\.950 per accepted merge/m,
    );
    assert.match(
      text.stdout,
      /^verdict: inconclusive: 2 paired units, below 20$/m,
    );
    // Half the files is a usage error; no paired unit is 65.
    const half = spawnSync(
      process.execPath,
      [report, '--all-attempts', '--sol', join(root, 'sol.jsonl')],
      { encoding: 'utf8' },
    );
    assert.equal(half.status, 2);
    await writeFile(join(root, 'empty.jsonl'), '');
    const none = spawnSync(
      process.execPath,
      [
        report,
        '--all-attempts',
        '--sonnet',
        join(root, 'empty.jsonl'),
        '--sol',
        join(root, 'sol.jsonl'),
        '--opus',
        join(root, 'opus.jsonl'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(none.status, 65);
    assert.match(none.stdout, /^verdict: inconclusive: 0 paired units/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('policy verdict: Sol-first wins at n>=20 when its ratio CI is below 1 and it accepts no fewer', async () => {
  const rows: Record<Role, Row[]> = { sonnet: [], sol: [], opus: [] };
  for (let i = 0; i < 20; i++) {
    const unit = `u${String(i).padStart(2, '0')}`;
    const red = i % 4 === 0;
    rows.sonnet.push({
      unit,
      arm: 'A',
      rep: 1,
      pass: !red,
      cost: 1 + (i % 3) * 0.1,
      harness: 'h',
      model: 'claude-sonnet-5-5',
    });
    rows.sol.push({
      unit,
      arm: 'A',
      rep: 1,
      pass: !red,
      cost: 0.5 + (i % 3) * 0.05,
      harness: 'h',
      model: 'gpt-6.2-sol',
    });
    if (red)
      rows.opus.push({
        unit,
        arm: 'A',
        rep: 1,
        pass: true,
        cost: 2,
        harness: 'h',
        model: 'claude-opus-5-5',
      });
  }
  const r = policyReport(rows);
  assert.equal(r.n, 20);
  assert.ok(r.ci !== null && r.ci[1] < 1);
  assert.match(r.verdict, /^sol-first wins/);
});
