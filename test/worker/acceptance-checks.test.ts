import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

test('1: successful check records sandbox boundaries', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, ['--check', 'exit 0']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.json('rounds/001/result.json').acceptance[0].exit_code, 0);
  const call = s.requests().find((r) => r.kind === 'sandbox');
  assert.ok(call);
  assert.ok(call.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(
    call.args.some(
      (a: string) => a.includes(s.repo) && a.includes(join(s.run, 'tmp')),
    ),
  );
});
test('2: failed check overrides done and all entries run in order', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, [
    '--check',
    'exit 3',
    '--check',
    'exit 0',
  ]);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /acceptance: exit 3 exit 3/);
  assert.equal(s.json('rounds/001/report.json').status, 'done');
  assert.deepEqual(
    s
      .json('rounds/001/result.json')
      .acceptance.map((a: { exit_code: number }) => a.exit_code),
    [3, 0],
  );
  const p = await setup(t);
  const partial = await p.turn('partial-named', true, ['--check', 'exit 2']);
  assert.equal(partial.code, 4, partial.stderr);
  assert.match(partial.stderr, /worker report status partial/);
  assert.match(partial.stderr, /acceptance failed/);
  assert.equal(p.json('rounds/001/result.json').acceptance.length, 1);
  const blocked = await setup(t);
  assert.equal(
    (await blocked.turn('blocked-named', true, ['--check', 'exit 0'])).code,
    4,
  );
  assert.equal(blocked.json('rounds/001/result.json').acceptance.length, 1);
  for (const action of ['write AGENTS.md', 'crash']) {
    const skipped = await setup(t);
    assert.notEqual(
      (await skipped.turn(action, true, ['--check', 'exit 0'])).code,
      0,
    );
    assert.equal(
      skipped.requests().filter((r) => r.kind === 'sandbox').length,
      0,
    );
  }
});
