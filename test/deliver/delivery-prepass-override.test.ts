import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeliveryFailure, deliver } from '../../src/deliver/delivery.ts';
import { type Runner, run } from '../../src/deliver/transport.ts';
import { reserveReviewAttempt } from '../../src/flow/series.ts';
import { newReviewRecordSchema } from '../../src/flow/types.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'krn-delivery-prepass-override-'));
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
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('checkout', '-qb', 'feature/prepass-override');
  writeFileSync(join(main, 'value.txt'), 'head\n');
  git('add', '.');
  git(
    'commit',
    '-qm',
    'feat: prepass fixture\n\nTicket: t-example\nChange-contract: test/prepass.test.ts:red->green',
  );
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const worktree = join(root, 'worktree');
  git('worktree', 'add', '-q', worktree, 'feature/prepass-override');
  const pull = JSON.parse(
    readFileSync(new URL('./fixtures/pull.fixture', import.meta.url), 'utf8'),
  );
  Object.assign(pull, { state: 'open', merged: false, merge_commit_sha: null });
  pull.head = { sha: head, ref: 'feature/prepass-override' };
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
    record,
    calls,
    run: (value: unknown = record) => {
      writeFileSync(recordPath, JSON.stringify(value));
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

function prepassOnly(
  record: object,
  severity: 'BLOCKING' | 'NON_BLOCKING' = 'BLOCKING',
) {
  return {
    ...record,
    panelVerdict: undefined,
    panel: undefined,
    judges: [],
    prepass: {
      state: 'complete' as const,
      findings: [
        {
          severity,
          title: 'Empty input fails',
          path: 'src/index.ts',
          line: 1,
          defect: 'An empty input throws instead of returning zero.',
          fix: 'Return zero for an empty input.',
        },
      ],
      sessionId: 'prepass-session',
    },
  };
}

const override = {
  reason: 'Lead accepts the recorded defect',
  evidence: 'Observed receiver proof',
  appendedAt: '2026-10-26T11:00:00Z',
};

test('deliver admits an overridden blocking prepass-only record', async (t) => {
  const f = fixture(t);
  const record = newReviewRecordSchema.parse({
    ...prepassOnly(f.record),
    override,
  });
  const outcome = await f.run(record).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  assert.equal(
    outcome.ok,
    true,
    outcome.ok
      ? ''
      : `delivery rejected the valid override: ${String(outcome.error)}`,
  );
  if (!outcome.ok) return;
  assert.equal(outcome.value.status, 'dry-run');
  assert.ok(f.calls.some(([command]) => command?.endsWith('/bin/krn')));
});

test('deliver refuses a blocking prepass-only record without override', async (t) => {
  const f = fixture(t);
  const record = newReviewRecordSchema.parse(prepassOnly(f.record));
  await assert.rejects(f.run(record), (error: unknown) => {
    assert.ok(error instanceof DeliveryFailure);
    assert.match(error.message, /review requires PASS or recorded override/u);
    return true;
  });
  assert.equal(
    f.calls.some(([command]) => command?.endsWith('/bin/krn')),
    false,
  );
});

test('deliver refuses an override on an advisory-only prepass', async (t) => {
  const f = fixture(t);
  const record = { ...prepassOnly(f.record, 'NON_BLOCKING'), override };
  assert.equal(newReviewRecordSchema.safeParse(record).success, false);
  await assert.rejects(f.run(record), (error: unknown) => {
    assert.ok(error instanceof DeliveryFailure);
    return true;
  });
  assert.equal(
    f.calls.some(([command]) => command?.endsWith('/bin/krn')),
    false,
  );
});
