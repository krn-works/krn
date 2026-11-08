import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup, snapshot, until, worker } from './input-bounds-fixture.ts';

test('grammar-valid model text is redacted in the session and inbox', async (t) => {
  const s = setup(t);
  const release = join(s.root, 'initialize-release');
  s.env.CODEX_TEST_WORKER_INITIALIZE_GATE = release;
  const pending = s.turn('ok', true, ['--model', 'sk-synthetic-model']);
  try {
    const path = join(s.run, 'inbox/001.json');
    await until(() => fs.existsSync(path));
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).model, '[redacted]');
  } finally {
    fs.writeFileSync(release, 'release');
  }
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  const session = fs.readFileSync(join(s.run, 'session.json'), 'utf8');
  assert.equal(session.includes('sk-synthetic-model'), false);
  assert.equal(JSON.parse(session).model, '[redacted]');
  const metrics = fs.readFileSync(
    join(s.run, 'rounds/001/metrics.json'),
    'utf8',
  );
  assert.equal(metrics.includes('sk-synthetic-model'), false);
});

// The value grammar is owned by the schemas; the CLI cases below only prove
// each flag is checked before start or send writes anything.
test('model and effort schemas refuse malformed and credential-like values', () => {
  const { modelSchema, effortSchema } = worker();
  for (const value of [
    'Uppercase',
    'bad/model',
    'valid\n',
    'a'.repeat(65),
    'AUTH=synthetic-model',
  ])
    assert.equal(modelSchema.safeParse(value).success, false, value);
  assert.equal(modelSchema.safeParse('a'.repeat(64)).success, true);
  assert.equal(modelSchema.safeParse('gpt-6-luna').success, true);
  for (const value of ['extreme', 'TOKEN: synthetic-effort'])
    assert.equal(effortSchema.safeParse(value).success, false, value);
  assert.equal(effortSchema.safeParse('xhigh').success, true);
});

test('invalid model and effort refuse start and send before writing', {
  concurrency: 6,
}, async (t) => {
  for (const [key, value] of [
    ['--model', 'bad/model'],
    ['--effort', 'extreme'],
  ]) {
    t.test(`${key} ${value}`, async (t) => {
      const s = setup(t);
      const first = await s.turn('ok', true, [key ?? '', value ?? '']);
      assert.equal(first.code, 64, first.stderr);
      assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
      assert.equal((await s.turn('ok', true)).code, 0);
      const before = snapshot(s.run);
      const next = await s.turn('ok', false, [key ?? '', value ?? '']);
      assert.equal(next.code, 64, next.stderr);
      assert.deepEqual(snapshot(s.run), before);
    });
  }
});

test('a missing repo and absent send or stop refuse without creating state', async (t) => {
  const s = setup(t);
  {
    const missing = join(s.root, 'missing');
    const result = await s.command([
      'start',
      '--repo',
      missing,
      '--brief',
      join(s.root, 'brief'),
    ]);
    assert.equal(result.code, 64, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
    assert.equal(
      (await s.command(['send', '--message', join(s.root, 'message')])).code,
      65,
    );
    assert.equal((await s.command(['stop'])).code, 0);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  }
});

test('other CLI inputs and input files are validated before any writes', {
  concurrency: 6,
}, async (t) => {
  for (const extra of [
    ['--timeout-min', 'NaN'],
    ['--timeout-min', '1e300'],
    ['--allow', 'x'.repeat(4097)],
    Array.from({ length: 101 }, () => ['--allow', '**']).flat(),
    ['--allow', 'AUTH=synthetic-secret'],
  ]) {
    t.test(extra[0] ?? 'arguments', async (t) => {
      const s = setup(t);
      const result = await s.turn('ok', true, extra);
      assert.equal(result.code, 64, result.stderr);
      assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
    });
  }
  t.test('missing brief', async (t) => {
    const s = setup(t);
    assert.equal((await s.command(['start', '--repo', s.repo])).code, 64);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('oversized brief', async (t) => {
    const s = setup(t);
    assert.equal((await s.turn('x'.repeat(256 * 1024 + 1), true)).code, 65);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('missing input file', async (t) => {
    const s = setup(t);
    const result = await s.command([
      'start',
      '--repo',
      s.repo,
      '--brief',
      join(s.root, 'missing'),
    ]);
    assert.equal(result.code, 65, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('redaction expansion is bounded before publication', async (t) => {
    const s = setup(t);
    const result = await s.turn('AUTH=x\n'.repeat(18000), true);
    assert.equal(result.code, 65, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
});

test('unsafe inbox and temporary-directory ancestors are refused before partial start state', {
  concurrency: 6,
}, async (t) => {
  for (const name of ['inbox', 'tmp']) {
    t.test(name, async (t) => {
      const s = setup(t);
      const outside = join(s.root, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(s.run, { recursive: true });
      fs.symlinkSync(outside, join(s.run, name));
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      assert.deepEqual(fs.readdirSync(s.run), [name]);
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  }
});
