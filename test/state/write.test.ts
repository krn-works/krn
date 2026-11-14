import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setFields } from '../../src/state/write.ts';
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

function openRoadmap(root: string) {
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'tasks/t-open000.json'), '{"status":"open"}');
  mkdirSync(join(root, 'docs/program'), { recursive: true });
  writeFileSync(
    join(root, 'docs/program/roadmap.md'),
    '| Id | Task |\n|---|---|\n| R1 | t-open000 |\n',
  );
}

test('set, accept and handoff round-trip through state check and handoff-requests', () => {
  const root = realpathSync(buildCaseRepo('active'));
  const memory = mkdtempSync(join(tmpdir(), 'krn-state-memory-'));
  openRoadmap(root);
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

test('handoff lists merged commits since the previous SHA and retro measures the task', () => {
  const root = realpathSync(buildCaseRepo('active'));
  const memory = mkdtempSync(join(tmpdir(), 'krn-state-memory-'));
  openRoadmap(root);
  const commit = (subject: string) => {
    const result = spawnSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        subject,
        '-m',
        'Ticket: t-abc1234',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    const first = krn(root, 'handoff', '--task', 't-abc1234');
    assert.equal(first.status, 0, first.stderr);
    const path = join(root, '.krn/runs/delivery-loop/main/handoff.md');
    assert.doesNotMatch(readFileSync(path, 'utf8'), /## Merged/);
    commit('feat(cli): first slice (t-abc1234) (#12)');
    commit('fix(cli): operator requests wording (t-abc1234) (#13)');
    const second = krn(root, 'handoff', '--task', 't-abc1234');
    assert.equal(second.status, 0, second.stderr);
    const text = readFileSync(path, 'utf8');
    assert.match(
      text,
      /## Merged\n- [0-9a-f]{7,} fix\(cli\): operator asks wording \(t-abc1234\) \(#13\)\n- [0-9a-f]{7,} feat\(cli\): first slice/,
    );
    const verdict = spawnSync(
      process.execPath,
      [requests, path, '--root', root, '--memory', memory],
      { encoding: 'utf8' },
    );
    assert.equal(verdict.status, 0, verdict.stdout + verdict.stderr);
    const third = krn(root, 'handoff', '--task', 't-abc1234');
    assert.equal(third.status, 0, third.stderr);
    assert.match(readFileSync(path, 'utf8'), /## Merged\n- none since /);

    const retro = krn(root, 'retro', '--task', 't-abc1234');
    assert.equal(retro.status, 0, retro.stderr);
    assert.match(retro.stdout, /- commits: 2 on HEAD name t-abc1234, /);
    assert.match(retro.stdout, /- merged PRs: #12 #13\n/);
    assert.match(retro.stdout, /- tool economy:\n/);
    assert.equal(krn(root, 'retro', '--task', 'nope').status, 64);
    assert.equal(krn(root, 'retro').status, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(memory, { recursive: true, force: true });
  }
});

test('capsule writes replace the file whole instead of rewriting it in place', () => {
  const directory = mkdtempSync(join(tmpdir(), 'krn-state-atomic-'));
  try {
    const file = join(directory, 'state.md');
    const alias = join(directory, 'alias.md');
    writeFileSync(file, 'Next bounded owner and action: draft\n');
    linkSync(file, alias);
    setFields(directory, [['next bounded', 'done']]);
    // An in-place rewrite would reach the hard link; a rename leaves it alone.
    assert.equal(
      readFileSync(alias, 'utf8'),
      'Next bounded owner and action: draft\n',
    );
    assert.match(readFileSync(file, 'utf8'), /done/);
    assert.deepEqual(readdirSync(directory).sort(), ['alias.md', 'state.md']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
