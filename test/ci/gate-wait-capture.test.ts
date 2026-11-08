import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitCommand } from '../../src/ci/wait.ts';
import type { GateAdmissionPolicy } from '../../src/deliver/admission-policy.ts';
import { waitForGate } from '../../src/deliver/gate-wait.ts';

// Verbatim `gh api repos/<repo>/commits/<sha>/check-runs` output (KRN-12).
async function capture(name: string): Promise<string> {
  return readFile(
    new URL(`../fixtures/github-check-runs/${name}.json`, import.meta.url),
    'utf8',
  );
}

function receiver(output: string, head: string, policy: GateAdmissionPolicy) {
  const calls: string[][] = [];
  return {
    calls,
    options: {
      repo: 'krn-works/krn',
      pr: 1,
      head,
      policy,
      gh: async (args: string[]) => {
        calls.push(args);
        return output;
      },
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
  assert.deepEqual(calls[0], [
    'api',
    '--paginate',
    '--slurp',
    `repos/krn-works/krn/commits/${head}/check-runs?filter=all&per_page=100`,
  ]);
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
  const page = await capture('review-gate-failure');
  await assert.rejects(
    waitCommand(
      ['--repo', 'krn-works/krn', '--pr', '1', '--head', head, '--base', base],
      { cwd: repo, gh: async () => page, sleep: async () => {}, now: () => 0 },
    ),
    /Check concluded failure on 12faa099/u,
  );
});
