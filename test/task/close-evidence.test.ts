import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture } from '../receivers/capture.ts';
import {
  cli,
  fixtureRepo,
  git,
  runCli,
  task,
  useScratch,
} from './claims-fixture.ts';

useScratch();

const clause = (id: string, text: string) => ({
  id,
  type: 'standard',
  text,
  audience: 'all',
  tier: 'reflex',
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  enforcement: { kind: 'advisory' },
  provenance: { origin: 'test', evidence: [], proposals: [] },
  status: 'accepted',
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
});

async function widgetRepo(): Promise<string> {
  const repo = await fixtureRepo('close-evidence-', [
    task('T-1', {
      title: 'Cache the widget renderer',
      stack: ['node'],
      area: 'widgets',
      body: [
        'Outcome: the widget renderer caches each rendered widget\nFiles: src/widget.ts',
      ],
    }),
  ]);
  await mkdir(join(repo, 'test'), { recursive: true });
  await mkdir(join(repo, '.krn'), { recursive: true });
  await writeFile(join(repo, 'test', 'widget.test.ts'), '// widget renderer\n');
  await writeFile(
    join(repo, '.krn', 'conventions.json'),
    JSON.stringify([
      clause('r-widget', 'Every widget renderer change carries a cache test.'),
      clause('r-unrelated', 'Release notes name the operator.'),
    ]),
  );
  git(repo, 'add', 'test');
  git(repo, 'commit', '-qm', 'add widget test');
  return repo;
}

/** A `gh` on PATH that replays a verbatim capture of `gh pr view --json number,statusCheckRollup`, or fails as gh does without a PR. */
async function ghReplaying(
  bin: string,
  replay: Buffer | undefined,
): Promise<void> {
  await mkdir(bin, { recursive: true });
  const reply = join(bin, 'reply.json');
  if (replay !== undefined) await writeFile(reply, replay);
  const shim = join(bin, 'gh');
  await writeFile(
    shim,
    replay === undefined
      ? '#!/bin/sh\necho "no pull requests found for branch" >&2\nexit 1\n'
      : `#!/bin/sh\ncat '${reply}'\n`,
  );
  chmodSync(shim, 0o755);
}

function close(repo: string, bin: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [cli, 'task', 'close', 'T-1', '--as', 'done', ...extra],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? '',
      },
      timeout: 20_000,
    },
  );
}

const rows = (repo: string) =>
  readFileSync(join(repo, '.krn', 'brain', 'exposures.jsonl'), 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test('closing a claimed task appends the PR, Check conclusion and hidden-test result to the rows of the clauses stored at claim', async () => {
  const repo = await widgetRepo();
  try {
    const claim = await runCli(repo, ['claim', 'T-1', '--actor', 'worker'], {
      spawn: true,
    });
    assert.equal(claim.status, 0, claim.stderr);
    const bin = join(repo, '.krn', 'tmp', 'bin');
    await ghReplaying(
      bin,
      capture('fixtures/gh', 'pr-1131-number-rollup').streams.stdout,
    );
    const closed = close(repo, bin, '--hidden', 'pass');
    assert.equal(closed.status, 0, closed.stderr);
    const [row, ...rest] = rows(repo);
    assert.equal(rest.length, 0);
    assert.equal(row?.schema, 'krn.exposure/v1');
    assert.equal(row?.task, 'T-1');
    assert.equal(row?.channel, 'close');
    assert.deepEqual(row?.served, ['r-widget']);
    assert.deepEqual(row?.evidence, {
      pr: 1131,
      ci: 'success',
      hidden: 'pass',
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a close without a PR or hidden result writes null for what is unknown', async () => {
  const repo = await widgetRepo();
  try {
    await runCli(repo, ['claim', 'T-1', '--actor', 'worker'], { spawn: true });
    const bin = join(repo, '.krn', 'tmp', 'bin');
    await ghReplaying(bin, undefined);
    const closed = close(repo, bin);
    assert.equal(closed.status, 0, closed.stderr);
    assert.deepEqual(rows(repo)[0]?.evidence, {
      pr: null,
      ci: null,
      hidden: null,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a task closed without a stored claim writes no row, and an unknown --hidden value exits 64', async () => {
  const repo = await widgetRepo();
  try {
    const bin = join(repo, '.krn', 'tmp', 'bin');
    await ghReplaying(bin, undefined);
    const bad = close(repo, bin, '--hidden', 'maybe');
    assert.equal(bad.status, 64, bad.stderr);
    const closed = close(repo, bin);
    assert.equal(closed.status, 0, closed.stderr);
    assert.throws(() => rows(repo), /ENOENT/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
