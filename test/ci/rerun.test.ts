import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

type RerunModule = {
  rerun: (
    input: { pr: number; head: string; repo?: string },
    dependencies?: Record<string, unknown>,
  ) => Promise<string>;
  jenkinsPullHash: (job: unknown) => string | undefined;
};

async function load(): Promise<RerunModule> {
  let module: Partial<RerunModule> = {};
  try {
    module = (await import('../../src/ci/rerun.ts')) as Partial<RerunModule>;
  } catch (error) {
    assert.fail(`src/ci/rerun.ts is unavailable: ${String(error)}`);
  }
  assert.equal(typeof module.rerun, 'function');
  assert.equal(typeof module.jenkinsPullHash, 'function');
  return module as RerunModule;
}

// Verbatim capture of the real Jenkins PR-181 job (tree query), last build head 903bcdd.
const readCapture = () =>
  readFileSync(
    new URL('../fixtures/jenkins/pr-job-last-build.json', import.meta.url),
    'utf8',
  );
const head = '903bcdd2bd955013a2b31e8dd00c97d2e549d984';
const token = 'tok-SECRET-value-123';
const user = 'krn-lead';

function gh(
  overrides: { head?: string; runs?: unknown[]; total?: number } = {},
) {
  const calls: string[][] = [];
  const runner = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'repo')
      return {
        code: 0,
        stdout: JSON.stringify({ nameWithOwner: 'krn-works/krn' }),
      };
    if (args[1]?.includes('/pulls/'))
      return {
        code: 0,
        stdout: JSON.stringify({ head: { sha: overrides.head ?? head } }),
      };
    if (args[1]?.includes('/check-runs'))
      return {
        code: 0,
        stdout: JSON.stringify({
          total_count: overrides.total ?? (overrides.runs ?? [1]).length,
          check_runs: overrides.runs ?? [
            {
              id: 10,
              name: 'krn/gate',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        }),
      };
    return { code: 1, stdout: '' };
  };
  return { runner, calls };
}

type Seen = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
};

async function jenkins(
  respond: { job?: string; jobStatus?: number; buildStatus?: number } = {},
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (request.method === 'GET') {
        response.writeHead(respond.jobStatus ?? 200, {
          'content-type': 'application/json',
        });
        response.end(respond.job ?? readCapture());
        return;
      }
      response.writeHead(respond.buildStatus ?? 201, {
        location: 'http://127.0.0.1:18080/queue/item/77/',
      });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const env = (url: string) => ({
  KRN_JENKINS_URL: url,
  KRN_JENKINS_USER: user,
  KRN_JENKINS_TOKEN: token,
});

async function failure(
  promise: Promise<unknown>,
): Promise<{ exitCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { exitCode, message } = error as {
      exitCode: number;
      message: string;
    };
    assert.ok(!message.includes(token), 'token leaked into error');
    return { exitCode, message };
  }
  return assert.fail('expected a refusal');
}

test('rerun reads the PR head from the verbatim Jenkins capture', async () => {
  const { jenkinsPullHash } = await load();
  assert.equal(jenkinsPullHash(JSON.parse(readCapture())), head);
  assert.equal(
    jenkinsPullHash({
      lastBuild: { actions: [{ lastBuiltRevision: { SHA1: head } }] },
    }),
    undefined,
  );
  const foreign = {
    _class: 'hudson.model.ParametersAction',
    revision: { pullHash: head },
  };
  assert.equal(
    jenkinsPullHash({ lastBuild: { actions: [foreign] } }),
    undefined,
  );
  const scm = {
    _class: 'jenkins.scm.api.SCMRevisionAction',
    revision: { pullHash: head },
  };
  assert.equal(
    jenkinsPullHash({ lastBuild: { actions: [scm, scm] } }),
    undefined,
  );
  assert.equal(
    jenkinsPullHash({ lastBuild: { actions: [foreign, scm] } }),
    head,
  );
});

test('rerun queues the same head with basic auth and no parameters', async () => {
  const { rerun } = await load();
  const server = await jenkins();
  try {
    const { runner, calls } = gh();
    const line = await rerun(
      { pr: 181, head },
      { gh: runner, env: env(server.url) },
    );
    assert.equal(line, `RERUN queued pr=181 head=${head} queue-item=77`);
    assert.ok(!line.includes(token));
    assert.deepEqual(calls[0], ['repo', 'view', '--json', 'nameWithOwner']);
    assert.equal(server.seen.length, 2);
    assert.equal(server.seen[0]?.method, 'GET');
    assert.match(
      server.seen[0]?.url ?? '',
      /^\/job\/ci\/job\/product\/job\/PR-181\/api\/json\?tree=/u,
    );
    assert.equal(server.seen[1]?.method, 'POST');
    assert.equal(server.seen[1]?.url, '/job/ci/job/product/job/PR-181/build');
    assert.equal(server.seen[1]?.body, '');
    const expected = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    assert.equal(server.seen[1]?.authorization, expected);
  } finally {
    await server.close();
  }
});

test('rerun refuses mismatched heads, pending runs and Jenkins errors without leaking the token', async () => {
  const { rerun } = await load();
  const server = await jenkins();
  try {
    const moved = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        { gh: gh({ head: 'b'.repeat(40) }).runner, env: env(server.url) },
      ),
    );
    assert.equal(moved.exitCode, 65);
    const busy = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        {
          gh: gh({
            runs: [
              {
                id: 10,
                name: 'krn/gate',
                status: 'completed',
                conclusion: 'failure',
              },
              {
                id: 11,
                name: 'krn/gate',
                status: 'in_progress',
                conclusion: null,
              },
            ],
          }).runner,
          env: env(server.url),
        },
      ),
    );
    assert.equal(busy.exitCode, 75);
    const paged = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        { gh: gh({ total: 101 }).runner, env: env(server.url) },
      ),
    );
    assert.equal(paged.exitCode, 65);
    assert.match(paged.message, /incomplete/u);
    const notIndexed = await failure(
      rerun(
        { pr: 181, head: 'c'.repeat(40), repo: 'krn-works/krn' },
        { gh: gh({ head: 'c'.repeat(40) }).runner, env: env(server.url) },
      ),
    );
    assert.equal(notIndexed.exitCode, 65);
    assert.match(notIndexed.message, /not indexed/u);
    assert.equal(
      server.seen.filter((request) => request.method === 'POST').length,
      0,
    );
    const missing = await failure(
      rerun({ pr: 181, head }, { gh: gh().runner, env: {} }),
    );
    assert.equal(missing.exitCode, 64);
    assert.equal(
      (
        await failure(
          rerun({ pr: 0, head }, { gh: gh().runner, env: env(server.url) }),
        )
      ).exitCode,
      64,
    );
    assert.equal(
      (
        await failure(
          rerun(
            { pr: 181, head: 'abc' },
            { gh: gh().runner, env: env(server.url) },
          ),
        )
      ).exitCode,
      64,
    );
  } finally {
    await server.close();
  }
  const broken = await jenkins({ buildStatus: 500 });
  try {
    const refused = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        { gh: gh().runner, env: env(broken.url) },
      ),
    );
    assert.equal(refused.exitCode, 75);
  } finally {
    await broken.close();
  }
  const oversized = await jenkins({
    job: `{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
  });
  try {
    const refused = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        { gh: gh().runner, env: env(oversized.url) },
      ),
    );
    assert.equal(refused.exitCode, 65);
    assert.match(refused.message, /exceeds 1 MiB/u);
    assert.equal(
      oversized.seen.filter((request) => request.method === 'POST').length,
      0,
    );
  } finally {
    await oversized.close();
  }
  const malformed = await jenkins({ job: '{"lastBuild":' });
  try {
    const refused = await failure(
      rerun(
        { pr: 181, head, repo: 'krn-works/krn' },
        { gh: gh().runner, env: env(malformed.url) },
      ),
    );
    assert.equal(refused.exitCode, 65);
  } finally {
    await malformed.close();
  }
});

test('krn ci rerun without Jenkins credentials exits 64 and names the variables', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli/main.ts', 'ci', 'rerun', '--pr', '181', '--head', head],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        KRN_JENKINS_USER: '',
        KRN_JENKINS_TOKEN: '',
        KRN_LEGACY_BIN: '/nonexistent/krn-legacy',
      },
    },
  );
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /KRN_JENKINS_USER and KRN_JENKINS_TOKEN/u);
});

const tunnelCommand = 'node .krn/runs/ci-platform/lead-access/tunnel.mjs';

test('rerun names the Jenkins lead tunnel when the Jenkins URL refuses the connection', async () => {
  const { rerun } = await load();
  // Real receiver: a loopback port that was just released refuses connections.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const refused = await failure(
    rerun(
      { pr: 181, head, repo: 'krn-works/krn' },
      {
        gh: gh().runner,
        env: env(`http://127.0.0.1:${port}`),
      },
    ),
  );
  assert.equal(refused.exitCode, 75);
  // The configured URL may carry credentials, so the refusal never echoes it.
  assert.ok(!refused.message.includes(`:${port}`), refused.message);
  assert.match(refused.message, /connection refused/u);
  assert.ok(refused.message.includes(tunnelCommand), refused.message);
  const other = await failure(
    rerun(
      { pr: 181, head, repo: 'krn-works/krn' },
      {
        gh: gh().runner,
        env: env('http://127.0.0.1:1'),
        fetcher: async () => {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
          });
        },
      },
    ),
  );
  assert.equal(other.exitCode, 75);
  assert.ok(!other.message.includes(tunnelCommand), other.message);
});

test('Jenkins diagnostics document the lead tunnel for krn ci rerun', () => {
  const doc = readFileSync(
    new URL('../../infra/ci/jenkins/diagnostics-and-queue.md', import.meta.url),
    'utf8',
  );
  assert.ok(doc.includes(tunnelCommand), 'tunnel command missing');
  assert.match(doc, /10\.254\.254\.6:8080/u);
});

const pendingRuns = [{ id: 11, name: 'krn/gate', status: 'in_progress' }];

test('GitHub pending, Jenkins finished → POST /build', async () => {
  const { rerun } = await load();
  const job = JSON.parse(readCapture());
  Object.assign(job.lastBuild, { building: false, result: 'FAILURE' });
  const server = await jenkins({ job: JSON.stringify(job) });
  try {
    const line = await rerun(
      { pr: 181, head },
      { gh: gh({ runs: pendingRuns }).runner, env: env(server.url) },
    );
    assert.match(line, /^RERUN queued/u);
    assert.equal(
      server.seen.filter((request) => request.method === 'POST').length,
      1,
    );
    assert.ok(server.seen[0]?.url?.includes('building,result'));
  } finally {
    await server.close();
  }
});

test('pending rerun requires a typed finished Jenkins build and matching head', async () => {
  const { rerun } = await load();
  for (const state of [
    { building: true, result: null },
    { building: false },
    { result: 'FAILURE' },
    { building: 'false', result: 'FAILURE' },
    { building: false, result: false },
    { building: false, result: 1 },
    { building: false, result: null },
    {},
  ]) {
    const job = JSON.parse(readCapture());
    Object.assign(job.lastBuild, state);
    const server = await jenkins({ job: JSON.stringify(job) });
    try {
      const refused = await failure(
        rerun(
          { pr: 181, head },
          { gh: gh({ runs: pendingRuns }).runner, env: env(server.url) },
        ),
      );
      assert.equal(refused.exitCode, 75);
      assert.match(refused.message, /jenkins building/u);
      assert.equal(
        server.seen.filter((request) => request.method === 'POST').length,
        0,
      );
    } finally {
      await server.close();
    }
  }
  const job = JSON.parse(readCapture());
  Object.assign(job.lastBuild, { building: false, result: 'FAILURE' });
  const server = await jenkins({ job: JSON.stringify(job) });
  try {
    const moved = 'c'.repeat(40);
    const refused = await failure(
      rerun(
        { pr: 181, head: moved },
        {
          gh: gh({ head: moved, runs: pendingRuns }).runner,
          env: env(server.url),
        },
      ),
    );
    assert.equal(refused.exitCode, 65);
    assert.match(refused.message, /not indexed/u);
    assert.equal(
      server.seen.filter((request) => request.method === 'POST').length,
      0,
    );
  } finally {
    await server.close();
  }
});
