import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_STALE_EXIT,
  staleClaimsReport,
} from '../../src/cli/doctor-claims.ts';

const hour = 3_600_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doctor-claims-'));
  const git = (...args: string[]) => {
    const run = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a'), 'a');
  git('add', 'a');
  git('commit', '-q', '-m', 'base');
  git('branch', 'idle-lane');
  git('checkout', '-q', '-b', 'busy-lane');
  writeFileSync(join(root, 'b'), 'b');
  git('add', 'b');
  git('commit', '-q', '-m', 'work');
  git('checkout', '-q', 'main');
  const claims = join(root, '.krn', 'task-claims');
  mkdirSync(claims, { recursive: true });
  const claim = (id: string, branch: string, claimed: number) =>
    writeFileSync(
      join(claims, `${id}.json`),
      JSON.stringify({
        id,
        actor: 'lane',
        worktree: join(root, branch),
        branch,
        claimed: new Date(claimed).toISOString(),
        reason: null,
      }),
    );
  return { root, claim };
}

test('doctor flags a claim older than N hours whose branch has no commit', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const { root, claim } = fixture();
  claim('t-stale00', 'idle-lane', now - 9 * hour);
  claim('t-fresh00', 'idle-lane', now - 1 * hour);
  claim('t-worked0', 'busy-lane', now - 9 * hour);
  claim('t-nobranch', 'gone-lane', now - 9 * hour);
  const report = staleClaimsReport(root, { hours: 6, now });
  assert.equal(report.exitCode, CLAIM_STALE_EXIT);
  assert.match(report.text, /^claim-stale=t-stale00 claimed 9\.0h ago/mu);
  assert.match(report.text, /^claim-stale=t-nobranch /mu);
  assert.doesNotMatch(report.text, /t-fresh00|t-worked0/u);
});

test('doctor reports live claims and exit 0 when none is stale', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const { root, claim } = fixture();
  claim('t-worked0', 'busy-lane', now - 9 * hour);
  const report = staleClaimsReport(root, { hours: 6, now });
  assert.equal(report.text, 'claims=live\n');
  assert.equal(report.exitCode, 0);
});

test('the real krn doctor prints the claim section', () => {
  const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));
  const run = spawnSync(krn, ['doctor', '--claim-hours', '100000'], {
    encoding: 'utf8',
  });
  assert.match(run.stdout, /^claims=live$/mu);
});
