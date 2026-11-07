import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type * as ShipModule from '../../src/deliver/ship.ts';

// Base has no native ship: a dynamic import keeps that red an assertion.
const shipModule: Partial<typeof ShipModule> = await import(
  '../../src/deliver/ship.ts'
).catch(() => ({}));
const ship: typeof ShipModule.ship = (...args) => {
  assert.equal(typeof shipModule.ship, 'function', 'native ship is missing');
  return (shipModule.ship as typeof ShipModule.ship)(...args);
};

test('native ship exports the merge authority', () => {
  assert.equal(typeof shipModule.ship, 'function');
});
test('ship usage exits 64 through native dispatch', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli/main.ts', 'ship', '--json'],
    { encoding: 'utf8', env: { ...process.env, KRN_LEGACY_ENTRY: '/missing' } },
  );
  assert.equal(result.status, 64, 'native ship usage must exit 64');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { ShipRunner } from '../../src/deliver/ship.ts';

export function shipFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krn-native-ship-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captured = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/ship-dry-run.fixture', import.meta.url),
      'utf8',
    ),
  );
  const { base, head, precheckedMerge, precheckedTree } = captured;
  const published = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
  const messageFile = path.join(root, 'message');
  const text =
    'feat(deliver): native ship (#138)\n\nBody.\n\nTicket: t-tm9ytff\nChange-contract: ship:red->green\n';
  fs.writeFileSync(messageFile, text);
  const record = path.join(root, '.krn/runs/ship/pr-138.json');
  const config = {
    judges: true,
    checks: true,
    origin: 'https://github.com/krn-works/krn.git',
    movedHead: false,
    movedBase: false,
    response: '200',
    transport: false,
    readback: true,
    parents: `${base} ${head}`,
    tree: precheckedTree,
    contained: true,
    policy: true,
    merged: false,
  };
  let prReads = 0;
  let puts = 0;
  const verifierCalls: { command: string; args: string[]; cwd: string }[] = [];
  const run: ShipRunner = (command, args, options) => {
    const ok = (out = '') => ({ ok: true, out });
    if (command === 'git') {
      const a = args.slice(2);
      const op = a.join(' ');
      if (op === 'rev-parse --show-toplevel') return ok(root);
      if (a[0] === 'config' || a[0] === 'remote') return ok(config.origin);
      if (op === 'ls-remote --symref origin HEAD')
        return ok('ref: refs/heads/main\tHEAD\n');
      if (op === 'check-ref-format --branch main') return ok('main');
      if (op.includes('refs/pull/138/head') && a[0] === 'ls-remote')
        return ok(`${head}\trefs/pull/138/head`);
      if (op === 'ls-remote --refs origin refs/heads/main')
        return ok(`${base}\trefs/heads/main`);
      if (op === 'rev-parse --verify refs/remotes/origin/main^{commit}')
        return ok(base);
      if (op === 'rev-parse --verify FETCH_HEAD^{commit}')
        return ok(config.merged ? published : head);
      if (a[0] === 'ls-tree')
        return ok(
          config.policy
            ? `100644 blob ${'c'.repeat(40)}\tspec/ci-admission.json`
            : '',
        );
      if (a[0] === 'cat-file')
        return ok('{"schemaVersion":1,"checkRunName":"Check","appId":15368}');
      if (op === `show ${base}:krn.ship.json`)
        return ok('{"version":1,"verify":["scripts/pr-preflight.mjs"]}\n');
      if (a[0] === 'worktree' && a[1] === 'add') {
        assert.equal(a[4], base, 'verifier checkout must use base');
        fs.writeFileSync(
          path.join(a[3] ?? '', '.node-version'),
          fs.readFileSync('.node-version'),
        );
        return ok();
      }
      if (op === 'rev-parse --verify HEAD^{commit}') return ok(precheckedMerge);
      if (op === 'rev-parse HEAD^{tree}') return ok(precheckedTree);
      if (op === `rev-parse --verify ${published}^{tree}`)
        return ok(config.tree);
      if (a[0] === 'show') return ok(config.parents);
      if (a[0] === 'merge-base') return { ok: config.contained, out: '' };
      if (['fetch', 'merge', 'worktree', 'check-ignore'].includes(a[0] ?? ''))
        return ok();
      throw new Error(`unexpected git ${op}`);
    }
    if (command.endsWith('/bin/node')) {
      verifierCalls.push({ command, args, cwd: options.cwd });
      assert.ok(args.includes(base));
      assert.ok(args.includes(head));
      return ok(
        JSON.stringify({
          verdict: 'pass',
          head,
          base,
          reasons: [],
          reviewRecords: captured.repositoryEvidence.reviewRecords,
          gateCheckRun: captured.repositoryEvidence.gateCheckRun,
        }),
      );
    }
    assert.equal(command, 'gh');
    if (args.includes('PUT')) {
      puts++;
      const pending = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(pending.status, 'pending');
      assert.equal(pending.head, head);
      config.merged = true;
      if (config.transport) throw new Error('connection reset');
      const body = fs.readFileSync(
        new URL(
          `./fixtures/ship-merge-api/${config.response}.json`,
          import.meta.url,
        ),
        'utf8',
      );
      return ok(
        `HTTP/2.0 ${config.response} Status\r\nContent-Type: application/json\r\n\r\n${body}`,
      );
    }
    const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
    if (endpoint.includes('/statuses?'))
      return ok(
        JSON.stringify([
          config.judges
            ? ['krn/judge-standards', 'krn/judge-spec'].map((context) => ({
                context,
                state: 'success',
                created_at: '2026-01-01',
              }))
            : [],
        ]),
      );
    if (endpoint.includes('/check-runs?'))
      return ok(
        JSON.stringify([
          {
            check_runs: (config.policy ? [1] : [3, 2, 1]).map((id) => ({
              id,
              name: config.policy ? 'Check' : `check-${id}`,
              head_sha: head,
              status: 'completed',
              conclusion: config.checks ? 'success' : 'failure',
              app: { id: 15368 },
            })),
          },
        ]),
      );
    if (endpoint.endsWith('/pulls/138'))
      return ok(
        JSON.stringify({
          merged: config.readback,
          merge_commit_sha: published,
        }),
      );
    if (args.includes('state,mergeCommit')) return ok('{"state":"MERGED"}');
    if (args.includes('headRefName,headRepository,isCrossRepository'))
      return ok(
        '{"headRefName":"feature","isCrossRepository":true,"headRepository":null}',
      );
    if (args[0] === 'pr') {
      prReads++;
      return ok(
        JSON.stringify({
          state: 'OPEN',
          baseRefName: 'main',
          baseRefOid: config.movedBase && prReads > 1 ? 'd'.repeat(40) : base,
          headRefOid: config.movedHead && prReads > 1 ? 'e'.repeat(40) : head,
          mergeable: 'MERGEABLE',
        }),
      );
    }
    throw new Error(`unexpected gh ${args}`);
  };
  return {
    root,
    config,
    record,
    messageFile,
    text,
    verifierCalls,
    puts: () => puts,
    invoke: (
      dry = false,
      extra: { pinnedNode?: (version: string) => string | undefined } = {},
    ) =>
      ship(
        [
          '--repo',
          'krn-works/krn',
          '--pr',
          '138',
          '--message-file',
          messageFile,
          '--json',
          ...(dry ? ['--dry-run'] : []),
        ],
        {
          root,
          run,
          now: () => captured.startedAt,
          pinnedNode: () => process.execPath,
          ...extra,
        },
      ),
  };
}

for (const [name, prefix, newline] of [
  ['LF', '', '\n'],
  ['CRLF', '', '\r\n'],
  ['BOM', '\uFEFF', '\n'],
]) {
  test(`dry run parses ${name}, runs base verifier and writes no record`, async (t) => {
    const f = shipFixture(t);
    fs.writeFileSync(
      f.messageFile,
      `${prefix}${f.text.replace(/\n/g, newline ?? '\n')}`,
    );
    const result = await f.invoke(true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(f.record), false);
    assert.equal(f.puts(), 0);
    assert.equal(f.verifierCalls.length, 1);
    if (result.ok) {
      const fixture = JSON.parse(
        fs.readFileSync(
          new URL('./fixtures/ship-dry-run.fixture', import.meta.url),
          'utf8',
        ),
      );
      assert.deepEqual(
        Object.keys(result.record).sort(),
        Object.keys(fixture).sort(),
      );
    }
  });
}
test('missing pinned Node refuses before the verifier runs', async (t) => {
  const f = shipFixture(t);
  const result = await f.invoke(true, { pinnedNode: () => undefined });
  assert.equal(result.ok, false);
  assert.match(
    JSON.stringify(result),
    /repository verifier pinned Node \d+\.\d+\.\d+ is unavailable/,
  );
  assert.equal(f.verifierCalls.length, 0);
  assert.equal(f.puts(), 0);
});
for (const subject of ['feat: missing number', 'feat: wrong number (#139)'])
  test(`subject refusal: ${subject}`, async (t) => {
    const f = shipFixture(t);
    fs.writeFileSync(
      f.messageFile,
      f.text.replace('feat(deliver): native ship (#138)', subject),
    );
    assert.equal(
      `${JSON.stringify(await f.invoke(), null, 2)}\n`,
      fs.readFileSync(
        new URL(
          './fixtures/ship-subject-refusal.stdout.fixture',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  });
test('pending judges refusal matches verbatim capture', async (t) => {
  const f = shipFixture(t);
  f.config.judges = false;
  assert.equal(
    `${JSON.stringify(await f.invoke(), null, 2)}\n`,
    fs.readFileSync(
      new URL('./fixtures/ship-pending-judges.stdout.fixture', import.meta.url),
      'utf8',
    ),
  );
});
for (const moved of ['movedHead', 'movedBase'] as const)
  test(`${moved} refuses before PUT`, async (t) => {
    const f = shipFixture(t);
    f.config[moved] = true;
    assert.equal((await f.invoke()).ok, false);
    assert.equal(f.puts(), 0);
  });
test('origin mismatch refuses', async (t) => {
  const f = shipFixture(t);
  f.config.origin = 'https://github.com/other/repo';
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason: 'origin does not match --repo',
  });
});
for (const target of ['message', 'directory', 'record'] as const)
  test(`refuses ${target} symlink`, async (t) => {
    const f = shipFixture(t);
    if (target === 'message') {
      fs.renameSync(f.messageFile, `${f.messageFile}.real`);
      fs.symlinkSync(`${f.messageFile}.real`, f.messageFile);
    } else {
      fs.mkdirSync(path.dirname(f.record), { recursive: true });
      if (target === 'directory') {
        fs.rmdirSync(path.dirname(f.record));
        fs.symlinkSync(f.root, path.dirname(f.record));
      } else fs.symlinkSync(f.messageFile, f.record);
    }
    assert.equal((await f.invoke()).ok, false);
    assert.equal(f.puts(), 0);
  });
test('malformed record refuses recovery', async (t) => {
  const f = shipFixture(t);
  fs.mkdirSync(path.dirname(f.record), { recursive: true });
  fs.writeFileSync(f.record, '{');
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason: 'delivery record is malformed',
  });
});

test('failed checks refusal matches verbatim legacy capture', async (t) => {
  const f = shipFixture(t);
  f.config.checks = false;
  f.config.policy = false;
  assert.equal(
    `${JSON.stringify(await f.invoke(), null, 2)}\n`,
    fs.readFileSync(
      new URL('./fixtures/ship-failed-checks.stdout.fixture', import.meta.url),
      'utf8',
    ),
  );
});
test('required Check failure refuses even with passing judges', async (t) => {
  const f = shipFixture(t);
  f.config.checks = false;
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason:
      'required check Check (app 15368) is not completed successfully (status completed, conclusion failure)',
  });
  assert.equal(f.puts(), 0);
});
test('pending record from another head is overwritten', async (t) => {
  const f = shipFixture(t);
  fs.mkdirSync(path.dirname(f.record), { recursive: true });
  fs.writeFileSync(
    f.record,
    JSON.stringify({ status: 'pending', head: 'f'.repeat(40) }),
  );
  assert.equal((await f.invoke()).ok, true);
});
test('final record from another head refuses', async (t) => {
  const f = shipFixture(t);
  fs.mkdirSync(path.dirname(f.record), { recursive: true });
  fs.writeFileSync(
    f.record,
    JSON.stringify({ status: 'published', head: 'f'.repeat(40) }),
  );
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason: 'final delivery record belongs to another head',
  });
  assert.equal(f.puts(), 0);
});
test('subject refusal stdout stderr and exit match CLI capture', (t) => {
  const f = shipFixture(t);
  fs.writeFileSync(f.messageFile, 'feat: missing number\n\nbody\n');
  const result = spawnSync(
    process.execPath,
    [
      'src/cli/main.ts',
      'ship',
      '--repo',
      'krn-works/krn',
      '--pr',
      '138',
      '--message-file',
      f.messageFile,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  for (const stream of ['stdout', 'stderr'] as const)
    assert.equal(
      result[stream],
      fs.readFileSync(
        new URL(
          `./fixtures/ship-subject-refusal.${stream}.fixture`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  assert.equal(
    result.status,
    Number(
      fs
        .readFileSync(
          new URL(
            './fixtures/ship-subject-refusal.exit.fixture',
            import.meta.url,
          ),
          'utf8',
        )
        .trim()
        .replace('exit=', ''),
    ),
  );
});

test('head-only admission and verifier edits cannot change base policy', async (t) => {
  const f = shipFixture(t);
  assert.equal((await f.invoke(true)).ok, true);
  assert.equal(f.verifierCalls.length, 1);
  assert.ok(f.verifierCalls[0]?.args.includes('scripts/pr-preflight.mjs'));
  assert.ok(f.verifierCalls[0]?.command.endsWith('/bin/node'));
});
test('message larger than 64 KiB refuses before PUT', async (t) => {
  const f = shipFixture(t);
  fs.writeFileSync(f.messageFile, 'x'.repeat(65537));
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason: 'message file unavailable',
  });
  assert.equal(f.puts(), 0);
});
test('trailers must comprise the final contiguous paragraph', async (t) => {
  const f = shipFixture(t);
  fs.writeFileSync(f.messageFile, f.text + 'Unstructured final line\n');
  assert.deepEqual(await f.invoke(), {
    ok: false,
    reason: 'message must end in one contiguous trailer block',
  });
});
