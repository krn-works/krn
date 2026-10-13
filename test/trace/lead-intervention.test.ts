import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { intent, leadIntervention } from '../../src/trace/index.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(): Promise<{ directory: string; legacy: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-lead-intervention-'));
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'gc.auto', '0');
  git(directory, 'config', 'maintenance.auto', 'false');
  const legacy = join(directory, 'legacy.mjs');
  await writeFile(legacy, 'process.exit(0);\n');
  return { directory, legacy };
}

function runNote(
  directory: string,
  legacy: string,
  job: string,
  text: string,
  kind: 'intervention' | 'reconstruction' = 'intervention',
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      'note',
      '--job',
      job,
      '--issue',
      'LON-269',
      '--worktree',
      directory,
      '--repo-root',
      directory,
      '--kind',
      kind,
      '--text',
      text,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_LEGACY_ENTRY: legacy,
        KRN_FORWARDED: '',
      },
    },
  );
}

test('krn note records a lead intervention in trace.jsonl', async () => {
  const f = await fixture();
  const job = `lead-intervention-${process.pid}`;
  const trace = join(f.directory, '.krn/runs/foreman', job, 'trace.jsonl');
  try {
    const result = runNote(f.directory, f.legacy, job, 'resumed after handoff');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(trace),
      true,
      'krn note must append an event instead of forwarding to legacy',
    );
    const reconstructionResult = runNote(
      f.directory,
      f.legacy,
      job,
      'reconstructed prior context',
      'reconstruction',
    );
    assert.equal(reconstructionResult.status, 0, reconstructionResult.stderr);
    const rows = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.kind, 'lead_intervention');
    assert.match(String(rows[0]?.key), /^lead-intervention:/u);
    assert.deepEqual(rows[0]?.data, {
      kind: 'intervention',
      note: 'resumed after handoff',
    });
    assert.deepEqual(rows[1]?.data, {
      kind: 'reconstruction_prompt',
      note: 'reconstructed prior context',
    });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('krn note rejects multiline or overlong notes', async () => {
  const f = await fixture();
  const job = `lead-intervention-invalid-${process.pid}`;
  try {
    for (const note of ['two\nlines', 'x'.repeat(201)]) {
      const result = runNote(f.directory, f.legacy, job, note);
      assert.equal(result.status, 64, result.stderr);
    }
    assert.equal(
      existsSync(join(f.directory, '.krn/runs/foreman', job, 'trace.jsonl')),
      false,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace append rejects a symlinked trace.jsonl', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-symlink-${process.pid}`;
  const directory = join(f.directory, '.krn/runs/foreman', jobId);
  const trace = join(directory, 'trace.jsonl');
  const target = join(f.directory, 'trace-target.jsonl');
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, 'preserve this trace');
    await symlink(target, trace);
    await assert.rejects(intent(job, 1), { message: 'unsafe trace path' });
    assert.equal((await lstat(trace)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), 'preserve this trace');
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('lead intervention rejects credentials without writing trace events', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-credentials-${process.pid}`;
  const trace = join(f.directory, '.krn/runs/foreman', jobId, 'trace.jsonl');
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  try {
    for (const note of ['sk-test1234567890abcdef', 'token: abc']) {
      await assert.rejects(leadIntervention(job, 'intervention', note), {
        message: 'lead intervention note must not contain credentials',
      });
    }
    assert.equal(existsSync(trace), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
