import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

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
