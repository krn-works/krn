import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ledgerProposals } from '../../src/brain/proposals.ts';
import { harvestWithLedger } from '../../src/cli/standards-ledger.ts';

// The host registry `krn adopt` writes and the harvest that reads it, run through the real CLI
// on generated repositories; the ledger rows are the plain shape `krn ledger --json` prints.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'krn-registry-'));

function repository(): string {
  const root = scratch();
  writeFileSync(
    join(root, 'package.json'),
    '{"name": "probe", "scripts": {"test": "node --test"}}\n',
  );
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  assert.equal(git.status, 0);
  return root;
}

function krn(args: string[], env: Record<string, string>, cwd = tmpdir()) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

test('adopt appends the repository to the host registry once and harvest with no arguments reads it', () => {
  const alpha = repository();
  const beta = repository();
  const host = scratch();
  const registry = join(host, 'adopted.json');
  const env = { KRN_ADOPTED_REGISTRY: registry };
  try {
    for (const root of [alpha, beta, alpha]) {
      const done = krn(['adopt', root, '--no-canary'], env);
      assert.equal(done.status, 0, done.stderr);
    }
    assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), [
      realpathSync(alpha),
      realpathSync(beta),
    ]);
    for (const [root, evidence] of [
      [alpha, '#7'],
      [beta, 'def5678'],
    ] as const) {
      const done = krn(
        [
          'standards',
          'propose',
          '--text',
          'Run the linter before every commit.',
          '--kind',
          'check',
          '--evidence',
          evidence,
        ],
        env,
        root,
      );
      assert.equal(done.status, 0, done.stderr);
    }
    const harvest = krn(['standards', 'harvest'], env);
    assert.equal(harvest.status, 0, harvest.stderr);
    assert.match(
      harvest.stdout,
      /^candidate count 2 in 2 repositories \(promotable\): Run the linter before every commit\./u,
    );
    assert.match(
      harvest.stdout,
      /harvest: 1 candidate from 2 proposals in 2 repositories, 1 promotable/u,
    );
  } finally {
    for (const dir of [alpha, beta, host])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('adopt leaves a scratch repository out of the unnamed host registry', () => {
  const root = repository();
  const home = scratch();
  try {
    const done = krn(['adopt', root, '--no-canary'], { HOME: home });
    assert.equal(done.status, 0, done.stderr);
    assert.doesNotMatch(done.stdout, /registered in the host registry/u);
    const listed = krn(['standards', 'harvest'], { HOME: home });
    assert.equal(listed.status, 66);
    assert.match(listed.stderr, /none registered/u);
  } finally {
    for (const dir of [root, home])
      rmSync(dir, { recursive: true, force: true });
  }
});

const rows = [
  { number: 11, prGate: { reruns: 0 }, outcome: { status: 'kept' } },
  { number: 12, prGate: { reruns: 2 }, outcome: { status: 'kept' } },
  { number: 13, prGate: { reruns: null }, outcome: { status: 'reverted' } },
  { number: 14, prGate: { reruns: 1 }, outcome: { status: 'changed' } },
];

test('a rework or CI-failed merged PR becomes one proposal with #PR evidence', () => {
  const proposals = ledgerProposals('alpha', '/alpha', rows, '2026-11-14');
  assert.deepEqual(
    proposals.map((p) => [
      p.proposal.evidence[0],
      p.proposal.text.slice(0, 20),
    ]),
    [
      ['#12', 'Run the full local c'],
      ['#13', 'Verify the change ag'],
      ['#14', 'Run the full local c'],
      ['#14', 'Verify the change ag'],
    ],
  );
});

test('harvest --from-ledger groups lessons across the registered repositories', async () => {
  const alpha = repository();
  const beta = repository();
  try {
    const lines = await harvestWithLedger(
      [alpha, beta],
      async (root) => (root === realpathSync(alpha) ? rows : rows.slice(1, 2)),
      '2026-11-14',
    );
    const a = basename(alpha);
    const b = basename(beta);
    assert.equal(
      lines[0],
      'candidate count 3 in 2 repositories (promotable): Run the full local checks before shipping: a merged pull request needed a rerun of the required CI check.',
    );
    assert.equal(
      lines[1],
      `  kinds: check; origins: ${a}, ${b}; evidence: ${a}:#12, ${a}:#14, ${b}:#12`,
    );
    assert.equal(
      lines.at(-1),
      'harvest: 2 candidates from 5 proposals in 2 repositories, 1 promotable',
    );
  } finally {
    for (const dir of [alpha, beta])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('the real harvest --from-ledger entry reads merged PRs through gh', () => {
  const root = repository();
  const bin = scratch();
  const host = scratch();
  const registry = join(host, 'adopted.json');
  writeFileSync(registry, JSON.stringify([root]));
  // A verbatim capture of the gh answers the ledger asks for: one merged PR whose check ran twice.
  const run = (n: number) => ({
    id: n,
    name: 'Check',
    app: { id: 15368 },
    started_at: '2026-11-01T10:00:00Z',
    completed_at: '2026-11-01T10:05:00Z',
  });
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
case "$*" in
  "repo view"*) echo '{"nameWithOwner":"o/r"}' ;;
  "pr list"*) echo '[{"number":5,"title":"fix: x","createdAt":"2026-11-01T09:00:00Z","mergedAt":"2026-11-01T11:00:00Z","headRefOid":"a","baseRefOid":"b","mergeCommit":{"oid":"c"}}]' ;;
  "pr view"*) echo '{"commits":[{"oid":"a"}]}' ;;
  api*) echo '${JSON.stringify({ check_runs: [run(1), run(2)] })}' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  try {
    const done = krn(['standards', 'harvest', '--from-ledger'], {
      KRN_ADOPTED_REGISTRY: registry,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /evidence: [^:]+:#5/u);
    assert.match(
      done.stdout,
      /harvest: 1 candidate from 1 proposal in 1 repository/u,
    );
  } finally {
    for (const dir of [root, bin, host])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('harvest --repos with no directory yields a candidate from the adopted repositories', () => {
  const alpha = repository();
  const beta = repository();
  const host = scratch();
  const env = { KRN_ADOPTED_REGISTRY: join(host, 'adopted.json') };
  try {
    for (const root of [alpha, beta]) {
      const done = krn(['adopt', root, '--no-canary'], env);
      assert.equal(done.status, 0, done.stderr);
    }
    const harvest = krn(['standards', 'harvest', '--repos'], env);
    assert.equal(harvest.status, 0, harvest.stderr);
    assert.match(harvest.stdout, /^candidate in 2 repositories: /mu);
    assert.match(
      harvest.stdout,
      /harvest: [1-9]\d* candidates? from instruction files of 2 repositories/u,
    );
  } finally {
    for (const dir of [alpha, beta, host])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('standards check --tasks turns a failing standard of an adopted repository into one ready task, once', () => {
  const root = repository();
  const host = scratch();
  const env = { KRN_ADOPTED_REGISTRY: join(host, 'adopted.json') };
  try {
    const adopted = krn(['adopt', root, '--no-canary'], env);
    assert.equal(adopted.status, 0, adopted.stderr);
    const standards = join(root, '.agents', 'standards.json');
    const own = JSON.parse(readFileSync(standards, 'utf8'));
    const records = Array.isArray(own) ? own : own.standards;
    records.push({
      id: 'r-always-red',
      type: 'standard',
      area: 'tests',
      layer: 'universal',
      audience: 'worker',
      tier: 'floor',
      text: 'The probe command always fails.',
      why: 'Proves a failing standard becomes a task.',
      provenance: { origin: 'test', evidence: ['package.json'], proposals: [] },
      enforcement: { kind: 'command', run: 'exit 1' },
      applies: { stacks: [], needs: [], paths: [], terms: [] },
      status: 'accepted',
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      supersedes: [],
    });
    writeFileSync(standards, JSON.stringify(own, null, 2));
    const first = krn(['standards', 'check', '--tasks'], env, root);
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.match(first.stderr, /task: Make standard r-always-red pass/u);
    const again = krn(['standards', 'check', '--tasks'], env, root);
    assert.doesNotMatch(again.stderr, /task: Make standard r-always-red/u);
    const ready = krn(['task', 'ready', '--json'], env, root);
    assert.match(ready.stdout, /Make standard r-always-red pass/u);
  } finally {
    for (const dir of [root, host])
      rmSync(dir, { recursive: true, force: true });
  }
});
