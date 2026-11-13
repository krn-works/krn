import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitCommand } from '../../src/ci/wait.ts';
import type { GateAdmissionPolicy } from '../../src/deliver/admission-policy.ts';
import { waitForGate } from '../../src/deliver/gate-wait.ts';
import { checkRunArgs, pull, pullArgs, strictGh } from './strict-gh.ts';

// Verbatim `gh api repos/<repo>/commits/<sha>/check-runs` and
// `gh api repos/<repo>/pulls/<n>` output (KRN-12).
async function capture(
  name: string,
  kind = 'github-check-runs',
): Promise<string> {
  return readFile(
    new URL(`../fixtures/${kind}/${name}.json`, import.meta.url),
    'utf8',
  );
}

function receiver(
  output: string,
  head: string,
  policy: GateAdmissionPolicy,
  pullOutput = pull(head),
  pr = 1,
) {
  const { gh, calls } = strictGh('krn-works/krn', pr, head, {
    pull: () => pullOutput,
    checks: () => output,
  });
  return {
    calls,
    options: {
      repo: 'krn-works/krn',
      pr,
      head,
      policy,
      gh,
      sleep: async () => {},
      now: () => 0,
      pollMs: 1,
      timeoutMs: 1,
    },
  };
}

test('gate wait admits the captured slurped Check failure page and names the rerun', async () => {
  const head = '12faa099bdb389b3b520a62ad0a74a63f3a7528e';
  const { options, calls } = receiver(
    await capture('review-gate-failure'),
    head,
    { source: 'pinned-app', checkRunName: 'Check', appId: 15368 },
  );
  await assert.rejects(
    waitForGate(options),
    new RegExp(
      `^Error: Check concluded failure on ${head}; rerun: gh run rerun`,
    ),
  );
  assert.deepEqual(calls, [
    pullArgs('krn-works/krn', 1),
    checkRunArgs('krn-works/krn', head),
  ]);
});

test('gate wait admits the captured merged PR and its slurped check-runs', async () => {
  const head = 'e6d7a5d40d9ad765f6587eb37bf67a9e62dc7df8';
  const { options, calls } = receiver(
    await capture('pr-414-slurped'),
    head,
    { source: 'pinned-app', checkRunName: 'Check', appId: 15368 },
    await capture('pr-merged', 'github-pulls'),
    414,
  );
  assert.equal(await waitForGate(options), 'success');
  assert.deepEqual(calls, [
    pullArgs('krn-works/krn', 414),
    checkRunArgs('krn-works/krn', head),
  ]);
});

test('gate wait stops when the captured PR head is not the awaited head', async () => {
  const head = '12faa099bdb389b3b520a62ad0a74a63f3a7528e';
  const { options, calls } = receiver(
    await capture('review-gate-failure'),
    head,
    { source: 'pinned-app', checkRunName: 'Check', appId: 15368 },
    await capture('pr-merged', 'github-pulls'),
    414,
  );
  await assert.rejects(
    waitForGate(options),
    /^Error: head moved: PR #414 is at e6d7a5d4/u,
  );
  assert.equal(calls.length, 1);
});

test('gate wait admits the captured legacy gate success page once slurped', async () => {
  const head = 'e8df90177ce27145655d219c5c0d9784a42db437';
  // `--slurp` wraps each page of the captured single-page response in an array.
  const page = await capture('gate-success');
  const { options } = receiver(`[${page}]`, head, {
    source: 'legacy-actions',
    checkRunName: 'gate',
    appSlug: 'github-actions',
  });
  assert.equal(await waitForGate(options), 'success');
});

test('ci wait reads the admission policy from real git at base and admits the captured Check failure', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'krn-ci-wait-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await mkdir(join(repo, 'spec'));
  await writeFile(
    join(repo, 'spec/ci-admission.json'),
    await readFile(new URL('../../spec/ci-admission.json', import.meta.url)),
  );
  git('add', 'spec/ci-admission.json');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'policy',
  );
  const base = git('rev-parse', 'HEAD');
  const head = '12faa099bdb389b3b520a62ad0a74a63f3a7528e';
  const { gh } = strictGh('krn-works/krn', 1, head, {
    pull: () => pull(head),
    checks: () => page,
  });
  const page = await capture('review-gate-failure');
  await assert.rejects(
    waitCommand(
      ['--repo', 'krn-works/krn', '--pr', '1', '--head', head, '--base', base],
      { cwd: repo, gh, sleep: async () => {}, now: () => 0 },
    ),
    /Check concluded failure on 12faa099/u,
  );
});

// KRN-12: a checkout of another repository holds none of the base objects, so
// git fails with the captured message and the policy comes from the contents
// API; the 404 and the present file are verbatim `gh api` captures.
const foreign = (name: string) =>
  readFile(
    new URL(`../fixtures/foreign-repo/${name}`, import.meta.url),
    'utf8',
  );
const notATree = () => ({
  code: 128,
  stdout: '',
  stderr: 'fatal: not a tree object\n',
});

const gateSuccess = await capture('gate-success');

function foreignReceiver(
  repo: string,
  head: string,
  base: string,
  policy: () => string,
  checks: string,
) {
  const { gh } = strictGh(repo, 1, head, {
    pull: () => pull(head),
    checks: () => checks,
  });
  const reads: string[][] = [];
  return {
    reads,
    runtime: {
      cwd: '/work/repo',
      run: (_command: string, args: string[]) => {
        reads.push(args);
        return notATree();
      },
      gh: async (args: string[]) => {
        if (
          args[1] ===
          `repos/${repo}/contents/spec/ci-admission.json?ref=${base}`
        )
          return policy();
        return gh(args);
      },
      sleep: async () => {},
      now: () => 0,
    },
  };
}

test('ci wait outside the repository reads a missing policy through the API and succeeds on the captured gate', async () => {
  const head = 'e8df90177ce27145655d219c5c0d9784a42db437';
  const base = 'b'.repeat(40);
  const { runtime } = foreignReceiver(
    'o/r',
    head,
    base,
    () => {
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), {
        result: { stderr: 'gh: Not Found (HTTP 404)\n' },
      });
    },
    JSON.stringify([JSON.parse(gateSuccess)]),
  );
  const out = await waitCommand(
    ['--repo', 'o/r', '--pr', '1', '--head', head, '--base', base],
    runtime,
  );
  assert.match(out, new RegExp(`^gate: success ${head}`, 'u'));
});

test('ci wait outside the repository takes the gate name from the policy file read through the API', async () => {
  const head = '12faa099bdb389b3b520a62ad0a74a63f3a7528e';
  const base = 'b'.repeat(40);
  const { runtime, reads } = foreignReceiver(
    'krn-works/krn',
    head,
    base,
    () => '',
    await capture('review-gate-failure'),
  );
  const present = await foreign('policy-present.json');
  const wrapped = {
    ...runtime,
    gh: async (args: string[]) =>
      args[1]?.includes('/contents/spec/ci-admission.json')
        ? present
        : runtime.gh(args),
  };
  await assert.rejects(
    waitCommand(
      ['--repo', 'krn-works/krn', '--pr', '1', '--head', head, '--base', base],
      wrapped,
    ),
    /Check concluded failure on 12faa099/u,
  );
  assert.equal(reads[0]?.[0], 'ls-tree');
});

test('ci wait on the captured foreign pull never finds the legacy gate and exits 69', async () => {
  const pr = JSON.parse(await foreign('pull.json'));
  const head: string = pr.head.sha;
  const base: string = pr.base.sha;
  const { runtime } = foreignReceiver(
    'krn-works/seo-audit-harness',
    head,
    base,
    () => {
      throw Object.assign(new Error('x'), {
        result: { stderr: 'gh: Not Found (HTTP 404)\n' },
      });
    },
    await foreign('check-runs.json'),
  );
  let time = 0;
  await assert.rejects(
    waitCommand(
      [
        '--repo',
        'krn-works/seo-audit-harness',
        '--pr',
        '1',
        '--head',
        head,
        '--base',
        base,
      ],
      {
        ...runtime,
        now: () => time,
        sleep: async (ms: number) => {
          time += ms;
        },
      },
    ),
    { exitCode: 69 },
  );
});
