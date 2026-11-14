import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  doctorReport,
  isFresh,
  isUnfetched,
  readEntryPin,
  staleEntryExit,
} from '../../src/cli/entry-pin.ts';

const script = fileURLToPath(
  new URL('../../scripts/product-release.sh', import.meta.url),
);
const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function productClone(root: string): Promise<string> {
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  await mkdir(join(work, 'bin'));
  await writeFile(join(work, 'bin', 'krn'), '#!/bin/sh\n');
  await chmod(join(work, 'bin', 'krn'), 0o755);
  git(work, 'add', 'bin/krn');
  git(work, 'commit', '-qm', 'one');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return work;
}

test('doctor reports the pinned entry commit and goes stale when origin/main moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-entry-pin-'));
  try {
    const work = await productClone(root);
    const entry = execFileSync('bash', [script, '--entry'], {
      cwd: work,
      encoding: 'utf8',
    }).trim();
    const release = join(work, '.krn', 'product-release');
    assert.equal(entry, join(release, 'bin', 'krn'));
    const first = git(work, 'rev-parse', 'HEAD');

    const fresh = doctorReport(release);
    assert.equal(fresh.exitCode, 0);
    assert.match(fresh.text, new RegExp(`^entry-commit=${first}$`, 'mu'));
    assert.match(fresh.text, /^status=fresh$/mu);

    // A merge moves origin/main; the pinned checkout is now stale until refreshed.
    await writeFile(join(work, 'a'), '2');
    git(work, 'add', 'a');
    git(work, 'commit', '-qm', 'two');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin');
    const second = git(work, 'rev-parse', 'HEAD');
    const stale = doctorReport(release);
    assert.equal(stale.exitCode, staleEntryExit);
    assert.match(stale.text, /^status=stale$/mu);
    assert.ok(stale.text.includes(`runs ${first.slice(0, 12)}`));
    assert.ok(stale.text.includes(`origin/main is ${second.slice(0, 12)}`));
    assert.match(stale.text, /product-release\.sh --entry/u);
    assert.match(stale.text, /which -a krn/u);

    execFileSync('bash', [script], { cwd: work });
    assert.equal(doctorReport(release).exitCode, 0);

    // The working checkout on a branch is never a fresh entry.
    git(work, 'checkout', '-q', '-b', 'feature');
    const working = readEntryPin(work);
    assert.equal(working.pinned, false);
    assert.equal(isFresh(working), false);
    assert.match(doctorReport(work).text, /^pinned=no$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor without a configured entry fails with the fix', () => {
  const report = doctorReport(null);
  assert.equal(report.exitCode, staleEntryExit);
  assert.match(report.text, /^entry=unconfigured$/mu);
});

test('a forwarded krn task from an unpinned checkout fails closed', () => {
  const result = spawnSync(krn, ['task', 'ready'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_FORWARDED: '1' },
  });
  assert.equal(result.status, staleEntryExit);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /stale Product entry: .* is not the pinned/u);
});

test('krn doctor reads the configured entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-entry-pin-cli-'));
  try {
    const work = await productClone(root);
    const entry = execFileSync('bash', [script, '--entry'], {
      cwd: work,
      encoding: 'utf8',
    }).trim();
    const result = spawnSync(krn, ['doctor'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_PRODUCT_ENTRY: entry },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^entry=${entry}$`, 'mu'));
    assert.match(result.stdout, /^status=fresh$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function freshClone(root: string): Promise<string> {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const work = join(root, 'work');
  await mkdir(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  await cp(join(repo, 'src'), join(work, 'src'), { recursive: true });
  await cp(join(repo, 'package.json'), join(work, 'package.json'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'one');
  await writeFile(join(work, 'a'), '2');
  git(work, 'add', 'a');
  git(work, 'commit', '-qm', 'two');
  git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return work;
}

function forwardedTask(work: string) {
  return spawnSync(
    process.execPath,
    [join(work, 'src', 'cli', 'krn.mjs'), 'task', 'ready'],
    {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, KRN_FORWARDED: '1' },
    },
  );
}

test('a forwarded krn task in a fresh clone that never fetched warns once and runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-entry-pin-fresh-'));
  try {
    const work = await freshClone(root);
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(isUnfetched(readEntryPin(work)), true);
    const result = forwardedTask(work);
    assert.notEqual(result.status, staleEntryExit, result.stderr);
    assert.equal(
      result.stderr.match(/has not fetched origin\/main/gu)?.length,
      1,
    );
    assert.doesNotMatch(result.stderr, /stale Product entry/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a forwarded krn task whose pin exists but mismatches still fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-entry-pin-mismatch-'));
  try {
    const work = await freshClone(root);
    git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    const result = forwardedTask(work);
    assert.equal(result.status, staleEntryExit);
    assert.match(result.stderr, /stale Product entry/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
