import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exposureOf, servedOverlap } from '../../src/brain/exposures.ts';
import {
  taskKey,
  taskQueryText,
  touchedPaths,
} from '../../src/brain/task-query.ts';
import { lanePacket } from '../../src/brain/worker-packet.ts';

const cli = new URL('../../src/cli/main.ts', import.meta.url).pathname;

const record = (id: string, text: string, audience = 'all') => ({
  id,
  type: 'standard',
  text,
  audience,
  tier: 'reflex',
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  enforcement: { kind: 'advisory' },
  provenance: { origin: 'test', evidence: [], proposals: [] },
  status: 'accepted',
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'task-query-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('a task keys retrieval by its title, Outcome, Files, stack and area, and a closed or absent task keys nothing', () => {
  const root = repository({
    'tasks/t-a.json': JSON.stringify({
      id: 't-a',
      status: 'open',
      title: 'Cache the widget',
      stack: 'node',
      area: 'widgets',
      body: [
        'Outcome: widgets render once\nFiles: src/widget.ts, test/widget.test.ts\nProof: x',
      ],
    }),
    'tasks/t-b.json': JSON.stringify({
      id: 't-b',
      status: 'closed',
      title: 'Old',
      body: [],
    }),
  });
  try {
    const key = taskKey(root, 't-a');
    assert.deepEqual(key?.files, ['src/widget.ts', 'test/widget.test.ts']);
    const text = taskQueryText(key as NonNullable<typeof key>, [
      'src/other.ts',
    ]);
    for (const word of [
      'Cache the widget',
      'widgets render once',
      'node',
      'widgets',
      'src/other.ts',
    ])
      assert.match(text, new RegExp(word, 'u'));
    assert.equal(taskKey(root, 't-b'), undefined);
    assert.equal(taskKey(root, 't-none'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a packet never serves a record AGENTS.md states, and serves a lead record to the lead only', () => {
  const stated = 'Always run the formatter before every commit.';
  const root = repository({
    '.krn/conventions.json': JSON.stringify([
      record('r-stated', stated),
      record('r-lead', 'The lead keeps context bounded with verdicts.', 'lead'),
      record('r-fresh', 'Prefer small commits per formatter change.'),
    ]),
    'AGENTS.md': `# Rules\n\n- ${stated}\n`,
  });
  try {
    const query = 'formatter commit context verdicts';
    const worker = lanePacket(root, query, '2026-06-01', 't-x', 600, false);
    assert.deepEqual(worker?.records, ['r-fresh']);
    const lead = lanePacket(
      root,
      query,
      '2026-06-01',
      't-x',
      600,
      false,
      'lead',
    );
    assert.deepEqual([...(lead?.records ?? [])].sort(), ['r-fresh', 'r-lead']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('served overlap is the mean Jaccard of different tasks and krn standards effect --overlap prints it', () => {
  const row = (task: string, served: string[]) =>
    exposureOf({
      run: `run-${task}`,
      task,
      channel: 'lane',
      served,
      withheld: [],
      laneOk: true,
    });
  const rows = [
    row('t-1', ['a', 'b']),
    row('t-2', ['b', 'c']),
    row('t-3', ['x']),
  ];
  const overlap = servedOverlap(rows);
  assert.equal(overlap?.pairs, 3);
  assert.ok(Math.abs((overlap?.mean ?? 0) - 1 / 9) < 1e-9);
  assert.equal(servedOverlap(rows.slice(0, 1)), null);
  const root = repository({
    '.krn/brain/exposures.jsonl': `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  });
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const done = spawnSync(
      process.execPath,
      [cli, 'standards', 'effect', '--overlap', '--root', root],
      {
        encoding: 'utf8',
        cwd: tmpdir(),
      },
    );
    assert.equal(done.status, 0, done.stderr);
    assert.equal(
      done.stdout,
      'overlap: mean Jaccard 0.11 over 3 pair(s) of 3 task(s)\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('touchedPaths lists what the working tree changed against HEAD in a real git repository', () => {
  const root = repository({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
  const git = (...args: string[]) =>
    spawnSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', ...args],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
  try {
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'x');
    assert.deepEqual(touchedPaths(root), []);
    writeFileSync(join(root, 'b.txt'), 'two\n');
    assert.deepEqual(touchedPaths(root), ['b.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
