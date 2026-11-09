import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCaseRepo } from './fixture-repo.ts';

// KRN-12: every writer output is judged by the real receivers, `krn state check`
// and scripts/claude/handoff-requests.ts.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const requests = fileURLToPath(
  new URL('../../scripts/claude/handoff-requests.ts', import.meta.url),
);

function krn(root: string, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'krn-state-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KRN_STATE_ENTRY;
  try {
    return spawnSync(
      process.execPath,
      [cli, 'state', ...args, '--root', root],
      {
        encoding: 'utf8',
        env,
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('set, accept and handoff round-trip through state check and handoff-requests', () => {
  const root = realpathSync(buildCaseRepo('active'));
  const memory = mkdtempSync(join(tmpdir(), 'krn-state-memory-'));
  try {
    const set = krn(
      root,
      'set',
      'next',
      'lead: deliver t-fixture1, then rescan',
      'evidence',
      'ran\nthe check, twice',
    );
    assert.equal(set.status, 0, set.stderr);
    const accept = krn(
      root,
      'accept',
      'check, with a comma; and a semicolon',
      'todo',
    );
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(
      krn(root, 'accept', 'check with a comma and a semicolon', 'pass').status,
      0,
    );
    assert.equal(
      krn(root, 'accept', 'second criterion', 'drop:not needed, moved').status,
      0,
    );
    const capsule = readFileSync(
      join(root, '.krn/runs/delivery-loop/main/state.md'),
      'utf8',
    );
    assert.match(
      capsule,
      /^Outcome and observable acceptance: \[.*check with a comma and a semicolon; pass, second criterion; drop:not needed moved\]$/m,
    );
    const check = krn(root, 'check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /^state clean: /);
    assert.doesNotMatch(check.stderr, /malformed/);

    const handoff = krn(
      root,
      'handoff',
      '--task',
      't-abc1234',
      '--request',
      'closed: delivered t-fixture1',
      '--priority',
      'deliver t-fixture1',
    );
    assert.equal(handoff.status, 0, handoff.stderr);
    const again = krn(
      root,
      'handoff',
      '--task',
      't-abc1234',
      '--sha',
      'main abcdef1',
    );
    assert.equal(again.status, 0, again.stderr);
    const path = join(root, '.krn/runs/delivery-loop/main/handoff.md');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /- SHAs: main abcdef1/);
    assert.match(text, /- closed: delivered t-fixture1/);
    assert.match(text, /1\. deliver t-fixture1/);
    const verdict = spawnSync(
      process.execPath,
      [requests, path, '--root', root, '--memory', memory],
      { encoding: 'utf8' },
    );
    assert.equal(verdict.status, 0, verdict.stdout + verdict.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(memory, { recursive: true, force: true });
  }
});

test('set refuses values state check would reject', () => {
  const root = realpathSync(buildCaseRepo('active'));
  try {
    const state = krn(root, 'set', 'outcome state', 'DONE');
    assert.equal(state.status, 64);
    assert.match(state.stderr, /Outcome state must be one of/);
    const ledger = krn(root, 'set', 'acceptance', '[a, b; todo]');
    assert.equal(ledger.status, 64);
    assert.match(ledger.stderr, /krn state accept/);
    const drop = krn(root, 'accept', 'x', 'drop:');
    assert.equal(drop.status, 64);
    for (const bare of ['main da62997 clean', 'a'.repeat(40)]) {
      const fixed = krn(root, 'set', 'fingerprint', bare);
      assert.equal(fixed.status, 64, fixed.stderr);
      assert.match(fixed.stderr, /HEAD=<sha>/);
    }
    const anchored = krn(root, 'set', 'fingerprint', 'HEAD=abcdef1 clean');
    assert.equal(anchored.status, 0, anchored.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
