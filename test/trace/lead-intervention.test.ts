import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as trace from '../../src/trace/index.ts';

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

test('trace namespace exposes leadIntervention before API calls', () => {
  assert.equal(typeof trace.leadIntervention, 'function');
});

test('krn note records a lead intervention in trace.jsonl', async () => {
  const f = await fixture();
  const job = `lead-intervention-${process.pid}`;
  const tracePath = join(f.directory, '.krn/runs/foreman', job, 'trace.jsonl');
  try {
    const result = runNote(f.directory, f.legacy, job, 'resumed after handoff');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(tracePath),
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
    const rows = (await readFile(tracePath, 'utf8'))
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
  const tracePath = join(directory, 'trace.jsonl');
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
    await symlink(target, tracePath);
    await assert.rejects(trace.intent(job, 1), {
      message: 'unsafe trace path',
    });
    assert.equal((await lstat(tracePath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), 'preserve this trace');
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace append rejects a symlinked state directory', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-state-symlink-${process.pid}`;
  const parent = join(f.directory, '.krn/runs/foreman');
  const directory = join(parent, jobId);
  const target = join(f.directory, 'outside-state');
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  try {
    await mkdir(parent, { recursive: true });
    await mkdir(target);
    await symlink(target, directory);
    await assert.rejects(trace.intent(job, 1), {
      message: 'unsafe trace path',
    });
    assert.equal(existsSync(join(target, 'trace.jsonl')), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace append rejects a symlinked .krn before creating files outside the worktree', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-krn-symlink-${process.pid}`;
  const outside = await mkdtemp(join(tmpdir(), 'krn-trace-outside-'));
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  try {
    await symlink(outside, join(f.directory, '.krn'), 'dir');
    await assert.rejects(trace.intent(job, 1), {
      message: 'unsafe trace path',
    });
    assert.equal(existsSync(join(outside, 'runs')), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('trace append rejects a parent symlink installed between validation and open', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-parent-race-${process.pid}`;
  const parent = join(f.directory, '.krn/runs/foreman');
  const directory = join(parent, jobId);
  const parkedDirectory = join(parent, `${jobId}-parked`);
  const outside = await mkdtemp(join(tmpdir(), 'krn-trace-outside-'));
  const tracePath = join(directory, 'trace.jsonl');
  const target = join(outside, 'trace.jsonl');
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  const originalOpenSync = fs.openSync;
  let replaced = false;
  let directoryParked = false;
  let symlinkInstalled = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, 'preserve this trace');
    fs.openSync = new Proxy(originalOpenSync, {
      apply(open, thisArg, args) {
        if (!replaced && args[0] === tracePath) {
          replaced = true;
          fs.renameSync(directory, parkedDirectory);
          directoryParked = true;
          fs.symlinkSync(outside, directory, 'dir');
          symlinkInstalled = true;
        }
        return Reflect.apply(open, thisArg, args);
      },
    });
    syncBuiltinESMExports();

    await assert.rejects(trace.intent(job, 1), {
      message: 'unsafe trace path',
    });
    assert.equal(replaced, true);
    assert.equal(await readFile(target, 'utf8'), 'preserve this trace');
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    if (symlinkInstalled) fs.unlinkSync(directory);
    if (directoryParked) fs.renameSync(parkedDirectory, directory);
    await rm(outside, { recursive: true, force: true });
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace append removes a new empty file created outside after a parent symlink race', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-parent-race-new-${process.pid}`;
  const parent = join(f.directory, '.krn/runs/foreman');
  const directory = join(parent, jobId);
  const parkedDirectory = join(parent, `${jobId}-parked`);
  const outside = await mkdtemp(join(tmpdir(), 'krn-trace-outside-'));
  const tracePath = join(directory, 'trace.jsonl');
  const target = join(outside, 'trace.jsonl');
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  const originalOpenSync = fs.openSync;
  let replaced = false;
  let directoryParked = false;
  let symlinkInstalled = false;
  try {
    await mkdir(directory, { recursive: true });
    fs.openSync = new Proxy(originalOpenSync, {
      apply(open, thisArg, args) {
        if (!replaced && args[0] === tracePath) {
          replaced = true;
          fs.renameSync(directory, parkedDirectory);
          directoryParked = true;
          fs.symlinkSync(outside, directory, 'dir');
          symlinkInstalled = true;
        }
        return Reflect.apply(open, thisArg, args);
      },
    });
    syncBuiltinESMExports();

    await assert.rejects(trace.intent(job, 1), {
      message: 'unsafe trace path',
    });
    assert.equal(replaced, true);
    assert.equal(existsSync(target), false);
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    if (symlinkInstalled) fs.unlinkSync(directory);
    if (directoryParked) fs.renameSync(parkedDirectory, directory);
    await rm(outside, { recursive: true, force: true });
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('lead intervention rejects credentials without writing trace events', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-credentials-${process.pid}`;
  const tracePath = join(
    f.directory,
    '.krn/runs/foreman',
    jobId,
    'trace.jsonl',
  );
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  try {
    const rejectedNotes = [
      ['Stripe live secret', 'sk_live_short'],
      ['Stripe test secret', 'sk_test_short'],
      ['Stripe restricted live key', 'rk_live_short'],
      ['Stripe restricted test key', 'rk_test_short'],
      ['Stripe publishable live key', 'pk_live_short'],
      ['Stripe publishable test key', 'pk_test_short'],
      ['Stripe webhook secret', 'whsec_short'],
      ['generic sk dash prefix', 'sk-short'],
      ['generic sk underscore prefix', 'sk_short'],
      ['existing key/value pattern', 'token: abc'],
      ['existing AWS key', 'AWS key AKIA1234567890ABCDEF'],
      ['existing AWS session key', 'AWS session key ASIA1234567890ABCDEF'],
      [
        'existing Google API key',
        'Google API key AIza0123456789abcdefghijklmnopqrstuvwxy',
      ],
      ['Basic auth', 'Basic YWJjZGVmZ2hpamts'],
      ['case-insensitive Bearer auth', 'bearer abc...'],
      ['GitLab token', `glpat-${'a'.repeat(20)}`],
      ['JWT', 'eyJabcdefgh.ijklmnop.qrstuvwx'],
      ['mixed-class token', 'aB123456789012345678'],
      ['lowercase and digit token', 'abcdefghijklmnopqrst1234'],
      ['segmented mixed-class token', 'aaaa-bbbb-ccccdddd11112222'],
      ['40-character hexadecimal token', 'a1'.repeat(20)],
    ] as const;
    const outcomes: string[] = [];
    for (const [label, note] of rejectedNotes) {
      try {
        await trace.leadIntervention(job, 'intervention', note);
        outcomes.push(`${label}: accepted`);
      } catch (error) {
        outcomes.push(`${label}: ${(error as Error).message}`);
      }
    }
    assert.deepEqual(
      outcomes,
      rejectedNotes.map(
        ([label]) =>
          `${label}: lead intervention note must not contain credentials`,
      ),
    );
    assert.equal(existsSync(tracePath), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('lead intervention accepts ordinary prose with short commit SHAs', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-sha-${process.pid}`;
  const tracePath = join(
    f.directory,
    '.krn/runs/foreman',
    jobId,
    'trace.jsonl',
  );
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  const note =
    'Reviewed LON-269 TASK-12345678901234567890 krn-LON-269-r1-06-metric 1fe45953 1fe459533fb2 after handoff';
  try {
    await trace.leadIntervention(job, 'intervention', note);
    const rows = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.data, { kind: 'intervention', note });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('lead intervention accepts a UUID in ordinary prose', async () => {
  const f = await fixture();
  const jobId = `lead-intervention-uuid-${process.pid}`;
  const tracePath = join(
    f.directory,
    '.krn/runs/foreman',
    jobId,
    'trace.jsonl',
  );
  const job = {
    id: jobId,
    issue: 'LON-269',
    worktree: f.directory,
    repoRoot: f.directory,
  };
  const note = 'Resumed from checkpoint 550e8400-e29b-41d4-a716-446655440000';
  try {
    await trace.leadIntervention(job, 'intervention', note);
    const rows = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.data, { kind: 'intervention', note });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
