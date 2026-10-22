import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const gateLocal = fileURLToPath(
  new URL('../scripts/gate-local.mjs', import.meta.url),
);
const head = 'a'.repeat(40);
const fixtureRoot = resolve(process.cwd(), '.krn/tmp');
const summary = {
  version: 1,
  success: true,
  counts: {
    tests: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  },
  files: [
    {
      file: 'fixture.test.mjs',
      tests: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
      cancelled: 0,
    },
  ],
};

async function makeFixture(name, { failures, error }) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, `${name}-`));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const ghLog = join(root, 'gh-calls.jsonl');

  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
if (process.argv[2] === 'rev-parse' && process.argv[3] === 'HEAD') {
  process.stdout.write('${head}\\n');
} else if (process.argv[2] !== 'status') {
  process.stderr.write('unexpected fake git command\\n');
  process.exitCode = 1;
}
`,
  );
  await writeFile(
    join(bin, 'npm'),
    `#!/usr/bin/env node
process.stdout.write('Isolation-dependent tests skipped: 0\\n');
process.stdout.write('KRN_TEST_SUMMARY_JSON=' + ${JSON.stringify(JSON.stringify(summary))} + '\\n');
`,
  );
  await writeFile(
    join(bin, 'gh'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const log = process.env.KRN_FAKE_GH_LOG;
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const callCount = Number((await import('node:fs')).readFileSync(log, 'utf8').trim().split('\\n').length);
if (callCount <= Number(process.env.KRN_FAKE_GH_FAILURES)) {
  process.stderr.write(process.env.KRN_FAKE_GH_ERROR + '\\n');
  process.exitCode = 1;
}
`,
  );
  for (const binary of ['git', 'npm', 'gh'])
    await chmod(join(bin, binary), 0o755);

  return {
    root,
    ghLog,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      KRN_FAKE_GH_LOG: ghLog,
      KRN_FAKE_GH_FAILURES: String(failures),
      KRN_FAKE_GH_ERROR: error,
    },
  };
}

function runGateLocal(root, env) {
  const result = spawnSync(process.execPath, [gateLocal], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(
    result.error,
    undefined,
    `gate-local did not complete: ${result.error?.message}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

async function ghCalls(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('gate-local retries transient status failures with an identical payload', async (t) => {
  await t.test('TLS timeout then success retries once and passes', async () => {
    const fixture = await makeFixture('gate-local-status-retry-success', {
      failures: 1,
      error: 'net/http: TLS handshake timeout',
    });
    try {
      const result = runGateLocal(fixture.root, fixture.env);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await ghCalls(fixture.ghLog);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], calls[0]);
      assert.deepEqual(calls[0], [
        'api',
        `repos/krn-works/krn/statuses/${head}`,
        '-f',
        'state=success',
        '-f',
        'context=krn/gate-local',
        '-f',
        'description=Gate passed: 1 tests, 0 isolation skips',
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test(
    'three HTTP 503 failures fail after the final attempt',
    async () => {
      const fixture = await makeFixture('gate-local-status-retry-exhausted', {
        failures: 3,
        error: 'HTTP 503 Service Unavailable',
      });
      try {
        const result = runGateLocal(fixture.root, fixture.env);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /Unable to post gate-local status/u);
        const calls = await ghCalls(fixture.ghLog);
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[1], calls[0]);
        assert.deepEqual(calls[2], calls[0]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  for (const status of [401, 422]) {
    await t.test(`HTTP ${status} fails without retry`, async () => {
      const fixture = await makeFixture(`gate-local-status-${status}`, {
        failures: 3,
        error: `HTTP ${status} request rejected`,
      });
      try {
        const result = runGateLocal(fixture.root, fixture.env);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /Unable to post gate-local status/u);
        assert.equal((await ghCalls(fixture.ghLog)).length, 1);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
