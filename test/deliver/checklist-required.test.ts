import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeliveryFailure, deliver } from '../../src/deliver/delivery.ts';
import { type Runner, run } from '../../src/deliver/transport.ts';
import { reserveReviewAttempt } from '../../src/flow/series.ts';

const api = await import('../../src/deliver/checklist.ts').catch(
  () => undefined,
);
const path = 'docs/program/hardening-checklist.md';
const bytes = Buffer.from('\uFEFF- `symlink`: old text\r\n  ');
const digest = createHash('sha256').update(bytes).digest('hex');

function fixture(
  t: { after(fn: () => void): void },
  baseHas: boolean,
  headKind:
    | 'regular'
    | 'executable'
    | 'symlink'
    | 'absent'
    | 'directory'
    | 'changed'
    | 'binary',
) {
  assert.equal(typeof api?.requireReviewChecklist, 'function');
  const root = mkdtempSync(join(tmpdir(), 'krn-delivery-checklist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  mkdirSync(main);
  const git = (...args: string[]) => {
    const result = run('git', args, main);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(main, '.node-version'),
    run('node', ['--version'], main).stdout,
  );
  mkdirSync(join(main, 'docs/program'), { recursive: true });
  if (baseHas) writeFileSync(join(main, path), bytes);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('checkout', '-qb', 'feature/checklist');
  if (baseHas) rmSync(join(main, path));
  if (headKind === 'regular' || headKind === 'executable')
    writeFileSync(join(main, path), bytes, {
      mode: headKind === 'executable' ? 0o755 : 0o644,
    });
  if (headKind === 'changed')
    writeFileSync(join(main, path), 'new checklist bytes\n');
  if (headKind === 'binary')
    writeFileSync(join(main, path), Buffer.from([0xff, 0x0d, 0x0a]));
  if (headKind === 'symlink')
    symlinkSync('../../../value.txt', join(main, path));
  if (headKind === 'directory') {
    mkdirSync(join(main, path));
    writeFileSync(join(main, path, 'value.txt'), 'nested');
  }
  writeFileSync(join(main, 'value.txt'), 'head\n');
  git('add', '.');
  git(
    'commit',
    '-qm',
    'feat: checklist\n\nTicket: t-example\nChange-contract: test/checklist.test.ts:red->green',
  );
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const worktree = join(root, 'worktree');
  git('worktree', 'add', '-q', worktree, 'feature/checklist');
  const pull = JSON.parse(
    readFileSync(new URL('./fixtures/pull.fixture', import.meta.url), 'utf8'),
  );
  Object.assign(pull, { state: 'open', merged: false, merge_commit_sha: null });
  pull.head = { sha: head, ref: 'feature/checklist' };
  pull.base.sha = base;
  const attempt = reserveReviewAttempt(
    main,
    {
      schemaVersion: 1,
      repository: pull.base.repo.full_name,
      pr: pull.number,
      baseRef: pull.base.ref,
    },
    base,
    head,
  );
  const record = {
    ...JSON.parse(
      readFileSync(
        new URL('../flow/fixtures/review-record-v1.fixture', import.meta.url),
        'utf8',
      ),
    ),
    base,
    headSha: head,
    toolSha: base,
    redFirst: [],
    contracts: [],
    redFirstCauses: [],
    attempt,
  };
  const recordPath = join(root, 'record.json');
  const calls: string[][] = [];
  const runner: Runner = (command, args, cwd, input) => {
    calls.push([command, ...args]);
    assert.notEqual(command, 'krn', 'deliver must not run krn from PATH');
    if (command === 'gh') {
      assert.deepEqual(args, [
        'api',
        `repos/${pull.base.repo.full_name}/pulls/${pull.number}`,
      ]);
      return { code: 0, stdout: JSON.stringify(pull), stderr: '' };
    }
    if (command.endsWith('/bin/krn')) {
      assert.equal(args[0], 'ship');
      assert.ok(args.includes('--dry-run'));
      return { code: 0, stdout: '{}', stderr: '' };
    }
    return run(command, args, cwd, input);
  };
  return {
    root,
    main,
    worktree,
    record,
    calls,
    run: () => {
      writeFileSync(recordPath, JSON.stringify(record));
      return deliver(
        {
          repo: pull.base.repo.full_name,
          pr: pull.number,
          record: recordPath,
          dryRun: true,
          timeoutMs: 100,
          pollMs: 10,
        },
        { cwd: worktree, run: runner, contracts: async () => {} },
      );
    },
  };
}

test('deliver refuses missing or stale digests, symlinks, deletion and directories at bind', async (t) => {
  for (const scenario of [
    { base: false, head: 'regular', sha256: undefined },
    { base: false, head: 'regular', sha256: '0'.repeat(64) },
    { base: true, head: 'changed', sha256: digest },
    { base: false, head: 'symlink', sha256: digest },
    { base: true, head: 'absent', sha256: digest },
    { base: false, head: 'directory', sha256: digest },
  ] as const) {
    const f = fixture(t, scenario.base, scenario.head);
    if (scenario.sha256) f.record.checklist = { sha256: scenario.sha256 };
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof DeliveryFailure);
      assert.equal(error.stage, 'bind');
      assert.equal(error.exitCode, 71);
      assert.ok(error.message.includes(path));
      return true;
    });
    assert.equal(
      f.calls.some(([command]) => command?.endsWith('/bin/krn')),
      false,
    );
  }
});

async function assertChecklistEvidenceRefused(f: ReturnType<typeof fixture>) {
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof DeliveryFailure);
    assert.equal(error.stage, 'bind');
    assert.equal(error.exitCode, 71);
    assert.ok(error.message.includes(path));
    return true;
  });
  assert.equal(
    f.calls.some(([command]) => command?.endsWith('/bin/krn')),
    false,
  );
}

test('deliver refuses an incomplete prepass when a checklist is required', async (t) => {
  const f = fixture(t, false, 'regular');
  f.record.checklist = { sha256: digest };
  f.record.prepass = {
    state: 'incomplete',
    findings: [],
    sessionId: 'prepass-session',
    reason: 'invalid_verdict',
  };
  await assertChecklistEvidenceRefused(f);
});

test('deliver refuses a checklist record without prepass or prior evidence', async (t) => {
  const f = fixture(t, false, 'regular');
  f.record.checklist = { sha256: digest };
  await assertChecklistEvidenceRefused(f);
});

test('deliver accepts matching bytes and legacy trees without a checklist', async (t) => {
  for (const kind of ['regular', 'executable', 'absent', 'binary'] as const) {
    const f = fixture(t, false, kind);
    if (kind !== 'absent') {
      f.record.checklist = {
        sha256:
          kind === 'binary'
            ? createHash('sha256')
                .update(Buffer.from([0xff, 0x0d, 0x0a]))
                .digest('hex')
            : digest,
      };
      f.record.prepass = {
        state: 'complete',
        findings: [],
        sessionId: 'prepass-session',
      };
    }
    // A rejected delivery stays an assertion failure, not a thrown error.
    const result = await f
      .run()
      .catch((error: unknown) => ({ status: String(error) }));
    assert.equal(result.status, 'dry-run');
    assert.ok(f.calls.some(([command]) => command?.endsWith('/bin/krn')));
  }
});

test('checklist binding reads exact commit objects rather than worktree bytes', (t) => {
  const f = fixture(t, true, 'changed');
  assert.ok(api);
  assert.throws(
    () =>
      api.requireReviewChecklist({ ...f.record, base: 'HEAD' }, f.main, run),
    /exact commit SHAs/u,
  );
  writeFileSync(join(f.worktree, path), bytes);
  f.record.checklist = { sha256: digest };
  f.record.prepass = {
    state: 'complete',
    findings: [],
    sessionId: 'prepass-session',
  };
  assert.throws(
    () => api.requireReviewChecklist(f.record, f.main, run),
    /hardening-checklist\.md/u,
  );
  f.record.checklist = {
    sha256: createHash('sha256').update('new checklist bytes\n').digest('hex'),
  };
  assert.doesNotThrow(() => api.requireReviewChecklist(f.record, f.main, run));
});
