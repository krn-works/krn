import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeCheckpointRequest } from '../../src/foreman/checkpoint-request.ts';
import { runJob } from '../../src/foreman/run.ts';
import { recordRepo } from '../../src/foreman/state.ts';
import type { Contract, Deps } from '../../src/foreman/types.ts';
import * as relay from '../../src/relay/index.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import * as trace from '../../src/trace/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  gateCheck,
  reviewEvidence,
  writeReviewEvidence,
} from '../helpers/ship-evidence.ts';

const gitContextKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
] as const;
const preflightPath = fileURLToPath(
  new URL('../../scripts/pr-preflight.mjs', import.meta.url),
);

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of gitContextKeys) delete env[key];
  return env;
}

function contractFor(issue: string, description?: string): Contract {
  return {
    issueId: issue,
    identifier: issue,
    title: 'Delivery metadata fixture',
    description:
      description ??
      [
        'R1-task: none (accepted contract annotation)',
        '',
        '```krn-contract',
        JSON.stringify({
          version: 1,
          targetRepo: 'krn-works/krn',
          checks: ['typecheck'],
        }),
        '```',
      ].join('\n'),
    revision: 'fixture-revision',
    targetRepo: 'krn-works/krn',
    checks: ['typecheck'],
  };
}

async function integrationFixture(options: {
  readonly issue?: string;
  readonly description?: string;
  readonly recordRepo?: boolean;
}) {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'delivery-trailers-'));
  const issue = options.issue ?? 'LON-901';
  const job = {
    id: `delivery-${issue.toLowerCase()}`,
    issue,
    worktree: root,
    repoRoot: root,
  };
  const env = cleanGitEnvironment();
  const git = (args: string[], input?: string) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.name', 'Delivery fixture']);
    git(['config', 'user.email', 'delivery@example.invalid']);
    git(['remote', 'add', 'origin', 'https://github.com/krn-works/krn.git']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'test', 'x.test.ts'), 'export {};\n');
    await writeFile(
      join(root, 'krn.checks.json'),
      JSON.stringify({
        version: 1,
        checks: [{ id: 'fixture', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
      }),
    );
    git(['add', '.gitignore', 'krn.checks.json', 'src', 'test']);
    git(['commit', '--quiet', '-m', 'initial fixture']);
    const base = git(['rev-parse', 'HEAD']);
    const contract = contractFor(issue, options.description);
    if (options.recordRepo !== false) recordRepo(job, root, 'main', base);
    return { root, job, base, contract, git };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function fakeHostDeps(
  fixture: Awaited<ReturnType<typeof integrationFixture>>,
  options: {
    readonly onStart?: (start: number) => void;
    readonly onFirstStart?: (
      input: Parameters<Deps['hosts']['codex']['start']>[0],
      sessionId: string,
    ) => Promise<void>;
    readonly traceOverride?: Deps['trace'];
  } = {},
): { readonly deps: Deps; readonly starts: () => number } {
  let starts = 0;
  const deps: Deps = {
    budget: {
      maxResets: 0,
      maxRepairs: 0,
      session: { timeoutMs: 1000 },
    },
    ledger: {
      readContract: async () => fixture.contract,
    },
    relay,
    trace: options.traceOverride ?? trace,
    hosts: {
      codex: {
        start: async (input) => {
          starts += 1;
          options.onStart?.(starts);
          const sessionId = `session-delivery-${starts}`;
          await input.onStarted(sessionId);
          if (starts === 1) await options.onFirstStart?.(input, sessionId);
          return {
            id: sessionId,
            wait: async () => ({ reasonKind: 'exit', claimsDone: false }),
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  };
  return { deps, starts: () => starts };
}

function runPreflight(input: {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
}) {
  const harness = `
    import { runPreflight } from ${JSON.stringify(preflightPath)};
    const input = ${JSON.stringify({
      repo: input.repo,
      base: input.base,
      head: input.head,
      pr: 17,
    })};
    const pull = {
      number: 17,
      title: ${JSON.stringify(input.title)},
      base: { sha: input.base, ref: 'main', repo: { full_name: 'krn-works/krn' } },
      head: { sha: input.head },
    };
    const statuses = [{
      context: 'krn/gate-local', state: 'success',
      creator: { login: 'delivery-fixture' },
      description: 'Gate passed: 1 tests, 0 isolation skips',
    }];
    const report = await runPreflight(input, {
      readPull: async () => ({ ok: true, value: pull }),
      readStatuses: async () => ({ ok: true, value: statuses }),
      readCheckRuns: async () => ({ ok: true, value: ${JSON.stringify([gateCheck()])} }),
    });
    process.stdout.write(JSON.stringify(report) + '\\n');
  `;
  const env = { ...process.env };
  for (const key of gitContextKeys) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.KRN_SCOPE_PROBE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: input.repo,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

function parsedReport(result: ReturnType<typeof runPreflight>) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout, `expected preflight JSON; stderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as {
    verdict: 'pass' | 'fail';
    reasons: string[];
    ticket?: string;
  };
}

test('public delivery receiver refuses an unbound review even with passing delivery metadata', async (t) => {
  const fixture = await integrationFixture({ recordRepo: false });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const head = fixture.base;
  const directory = join(fixture.root, '.krn/runs/review', head);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'record.json'),
    JSON.stringify(reviewEvidence(fixture.base, head)),
  );
  const report = parsedReport(
    runPreflight({
      repo: fixture.root,
      base: fixture.base,
      head,
      title: 'feat: delivery (LON-901)',
    }),
  );
  assert.equal(report.verdict, 'fail');
  assert.match(
    report.reasons.join('\n'),
    /unbound legacy review cannot admit a PR/u,
  );
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('runJob commits contract-derived trailers and the public preflight admits that head', async (t) => {
  if (
    !requiresIsolation(
      t,
      'runJob commits contract-derived trailers and the public preflight admits that head',
      ['systemdUserScope'],
    )
  )
    return;
  const fixture = await integrationFixture({});
  try {
    const { deps } = fakeHostDeps(fixture, {
      onFirstStart: async (input, sessionId) => {
        await writeFile(
          join(fixture.root, 'src', 'index.ts'),
          'export const value = 2;\n',
        );
        const tasks = join(fixture.root, 'tasks');
        await mkdir(tasks, { recursive: true });
        const record: TaskRecord = {
          id: 'LON-901',
          status: 'open',
          resolution: null,
          created: '2026-10-26',
          priority: 1,
          title: 'Delivery metadata fixture',
          after: [],
          body: [],
        };
        await writeFile(join(tasks, 'LON-901.json'), serializeTask(record));
        writeCheckpointRequest(fixture.job, {
          intent: input.checkpoint.intent,
          sessionId,
          message: 'Ticket: LON-999',
          next: 'step B',
        });
      },
    });
    await runJob(fixture.job, deps);
    const head = fixture.git(['rev-parse', 'HEAD']);
    assert.notEqual(
      head,
      fixture.base,
      'foreman must create a real checkpoint commit',
    );
    const body = fixture.git(['show', '-s', '--format=%B', head]);
    const trailers = fixture.git(['interpret-trailers', '--parse'], body);
    assert.deepEqual(trailers.split('\n'), [
      'Krn-Session: session-delivery-1',
      'Ticket: LON-901',
      'R1-task: none',
    ]);

    await writeReviewEvidence(fixture.root, fixture.base, head, undefined, 17);
    const result = runPreflight({
      repo: fixture.root,
      base: fixture.base,
      head,
      title: 'feat(fixture): deliver contract metadata (LON-901)',
    });
    const report = parsedReport(result);
    assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
    assert.deepEqual(report.reasons, []);
    assert.equal(report.ticket, 'LON-901');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runJob and public preflight admit a contract with no R1-task declaration', async (t) => {
  if (
    !requiresIsolation(
      t,
      'runJob and public preflight admit a contract with no R1-task declaration',
      ['systemdUserScope'],
    )
  )
    return;
  const description = 'Accepted issue with no R1-task declaration.';
  const fixture = await integrationFixture({ description });
  try {
    const { deps } = fakeHostDeps(fixture, {
      onFirstStart: async (input, sessionId) => {
        await writeFile(
          join(fixture.root, 'src', 'index.ts'),
          'export const value = 2;\n',
        );
        const tasks = join(fixture.root, 'tasks');
        await mkdir(tasks, { recursive: true });
        const record: TaskRecord = {
          id: 'LON-901',
          status: 'open',
          resolution: null,
          created: '2026-10-26',
          priority: 1,
          title: 'Delivery metadata fixture',
          after: [],
          body: [],
        };
        await writeFile(join(tasks, 'LON-901.json'), serializeTask(record));
        writeCheckpointRequest(fixture.job, {
          intent: input.checkpoint.intent,
          sessionId,
          message: 'Ticket: LON-999',
          next: 'step B',
        });
      },
    });
    await runJob(fixture.job, deps);
    const head = fixture.git(['rev-parse', 'HEAD']);
    assert.notEqual(
      head,
      fixture.base,
      'foreman must create a real checkpoint commit',
    );
    const body = fixture.git(['show', '-s', '--format=%B', head]);
    const trailers = fixture.git(['interpret-trailers', '--parse'], body);
    assert.deepEqual(trailers.split('\n'), [
      'Krn-Session: session-delivery-1',
      'Ticket: LON-901',
    ]);

    await writeReviewEvidence(fixture.root, fixture.base, head, undefined, 17);
    const result = runPreflight({
      repo: fixture.root,
      base: fixture.base,
      head,
      title: 'feat(fixture): deliver optional metadata (LON-901)',
    });
    const report = parsedReport(result);
    assert.equal(report.verdict, 'pass', JSON.stringify(report.reasons));
    assert.deepEqual(report.reasons, []);
    assert.equal(report.ticket, 'LON-901');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate and malformed R1-task declarations stop before relay, trace, host, or projection writes', async (t) => {
  for (const scenario of [
    {
      name: 'duplicate declarations',
      description: [
        'R1-task: none',
        'R1-task: R1-23',
        '',
        '```krn-contract',
        JSON.stringify({
          version: 1,
          targetRepo: 'krn-works/krn',
          checks: ['typecheck'],
        }),
        '```',
      ].join('\n'),
    },
    {
      name: 'malformed declaration',
      description: [
        'R1-task: none trailing-value',
        '',
        '```krn-contract',
        JSON.stringify({
          version: 1,
          targetRepo: 'krn-works/krn',
          checks: ['typecheck'],
        }),
        '```',
      ].join('\n'),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await integrationFixture({
        issue: 'LON-903',
        description: scenario.description,
        recordRepo: false,
      });
      try {
        const { deps, starts } = fakeHostDeps(fixture, {
          onFirstStart: async (input, sessionId) => {
            await writeFile(
              join(fixture.root, 'src', 'index.ts'),
              'export {};\n',
            );
            writeCheckpointRequest(fixture.job, {
              intent: input.checkpoint.intent,
              sessionId,
              message: 'feat: invalid contract metadata',
              next: 'step B',
            });
          },
        });
        const outcome = await runJob(fixture.job, deps);
        assert.equal(
          starts(),
          0,
          'invalid task metadata must refuse before host startup',
        );
        assert.equal(outcome.kind, 'stop');
        if (outcome.kind === 'stop')
          assert.match(
            outcome.reasons.join('\n'),
            /delivery metadata refused/u,
          );
        const state = join(
          fixture.root,
          '.krn',
          'runs',
          'foreman',
          fixture.job.id,
        );
        assert.equal(await pathExists(join(state, 'capsule.json')), false);
        assert.equal(await pathExists(join(state, 'trace.jsonl')), false);
        assert.equal(
          await pathExists(
            join(
              fixture.root,
              '.krn',
              'runs',
              'delivery-loop',
              fixture.job.id,
              'state.md',
            ),
          ),
          false,
        );
        assert.equal(await pathExists(join(state, 'repo.json')), false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('pending checkpoint recovery retains the accepted trailers and prepared commit', async () => {
  const fixture = await integrationFixture({
    issue: 'LON-902',
    description: [
      'R1-task: none (recovery annotation)',
      '',
      '```krn-contract',
      JSON.stringify({
        version: 1,
        targetRepo: 'krn-works/krn',
        checks: ['typecheck'],
      }),
      '```',
    ].join('\n'),
  });
  let throwAfterPublication = true;
  const interruptedTrace: typeof trace = {
    ...trace,
    commit: async (job, intent, sessionId, sha, message) => {
      if (throwAfterPublication) {
        throwAfterPublication = false;
        throw new Error('injected interruption after publication');
      }
      await trace.commit(job, intent, sessionId, sha, message);
    },
  };
  let starts = 0;
  try {
    const { deps } = fakeHostDeps(fixture, {
      traceOverride: interruptedTrace,
      onStart: (start) => {
        starts = start;
      },
      onFirstStart: async (input, sessionId) => {
        await writeFile(
          join(fixture.root, 'src', 'index.ts'),
          'export const recovery = true;\n',
        );
        writeCheckpointRequest(fixture.job, {
          intent: input.checkpoint.intent,
          sessionId,
          message: 'Ticket: LON-999',
          next: 'step B',
        });
      },
    });
    const first = await runJob(fixture.job, deps);
    assert.equal(first.kind, 'stop');
    const interrupted = await relay.load(fixture.job, fixture.contract);
    const pending = interrupted.pendingCheckpoint;
    assert.ok(
      pending,
      'the injected interruption must leave owned recovery state',
    );
    assert.equal(fixture.git(['rev-parse', 'HEAD']), pending.sha);
    const preparedSha = pending.sha;
    const preparedBody = fixture.git([
      'show',
      '-s',
      '--format=%B',
      preparedSha,
    ]);

    await runJob(fixture.job, { ...deps, trace });
    const recovered = await relay.load(fixture.job, fixture.contract);
    assert.equal(recovered.pendingCheckpoint, undefined);
    assert.equal(recovered.head, preparedSha);
    assert.equal(fixture.git(['rev-parse', 'HEAD']), preparedSha);
    assert.equal(
      fixture.git(['rev-list', '--count', 'HEAD']),
      '2',
      'recovery must publish the original prepared object without another commit',
    );
    const body = fixture.git(['show', '-s', '--format=%B', preparedSha]);
    assert.equal(
      body,
      preparedBody,
      'recovery must retain the prepared commit body',
    );
    assert.deepEqual(
      fixture.git(['interpret-trailers', '--parse'], body).split('\n'),
      ['Krn-Session: session-delivery-1', 'Ticket: LON-902', 'R1-task: none'],
    );
    assert.equal(starts, 2, 'recovery may proceed to the next worker action');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
