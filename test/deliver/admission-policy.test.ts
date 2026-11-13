import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  gateAdmissionPolicyFromBase,
  gateAdmissionPolicyFromBranch,
  matchesGateCheckRun,
} from '../../src/deliver/admission-policy.ts';
import { waitForGate } from '../../src/deliver/gate-wait.ts';

const base = 'a'.repeat(40);
test('missing base policy preserves the legacy Actions selector', () => {
  const policy = gateAdmissionPolicyFromBase(base, () => '');
  assert.equal(
    matchesGateCheckRun(
      { name: 'gate', head_sha: base, app: { slug: 'github-actions' } },
      base,
      policy,
    ),
    true,
  );
  assert.equal(
    matchesGateCheckRun(
      { name: 'Check', head_sha: base, app: { id: 15368 } },
      base,
      policy,
    ),
    false,
  );
});

test('malformed or non-regular base policy fails closed', () => {
  assert.throws(() =>
    gateAdmissionPolicyFromBase(base, (args) =>
      args[0] === 'ls-tree'
        ? `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`
        : JSON.stringify({
            schemaVersion: 1,
            checkRunName: '',
            appId: 15368,
          }),
    ),
  );
  assert.throws(() =>
    gateAdmissionPolicyFromBase(
      base,
      () => `120000 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`,
    ),
  );
});

test('base policy can pin the GitHub Actions aggregate Check', () => {
  let policy: ReturnType<typeof gateAdmissionPolicyFromBase> | undefined;
  assert.doesNotThrow(() => {
    policy = gateAdmissionPolicyFromBase(base, (args) => {
      if (args[0] === 'ls-tree')
        return `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`;
      if (args[0] === 'cat-file')
        return JSON.stringify({
          schemaVersion: 1,
          checkRunName: 'Check',
          appId: 15368,
        });
      throw new Error('unexpected Git read');
    });
  });
  assert.ok(policy);
  assert.deepEqual(policy, {
    source: 'pinned-app',
    checkRunName: 'Check',
    appId: 15368,
  });
  assert.equal(
    matchesGateCheckRun(
      { name: 'Check', head_sha: base, app: { id: 15368 } },
      base,
      policy,
    ),
    true,
  );
  for (const check of [
    { name: 'gate', head_sha: base, app: { id: 15368 } },
    { name: 'Check', head_sha: base, app: { id: 1 } },
    { name: 'Check', head_sha: 'c'.repeat(40), app: { id: 15368 } },
  ])
    assert.equal(matchesGateCheckRun(check, base, policy), false);
  for (const mixed of [
    { schemaVersion: 1, checkRunName: 'Check', appId: 1 },
    { schemaVersion: 1, checkRunName: 'ci / Check\nx', appId: 15368 },
    { schemaVersion: 1, checkRunName: 'x'.repeat(101), appId: 15368 },
  ])
    assert.throws(
      () =>
        gateAdmissionPolicyFromBase(base, (args) =>
          args[0] === 'ls-tree'
            ? `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`
            : JSON.stringify(mixed),
        ),
      /base gate policy is invalid/u,
    );
});

// KRN-12: the check-run names a reusable workflow call produces on GitHub,
// captured verbatim from astral-sh/uv (caller job `bench:` without a name).
const capture = JSON.parse(
  readFileSync(
    new URL(
      '../fixtures/ci-admission/reusable-check-runs.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  check_runs: { name: string; head_sha: string; app: { id: number } }[];
};

test('base policy selects a reusable workflow aggregate as `<caller job> / <job>`', () => {
  const captured = capture.check_runs[0];
  assert.ok(captured);
  const [caller, job] = captured.name.split(' / ');
  assert.equal(caller, 'bench');
  const policy = gateAdmissionPolicyFromBase(base, (args) =>
    args[0] === 'ls-tree'
      ? `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`
      : JSON.stringify({
          schemaVersion: 1,
          checkRunName: `${caller} / ${job}`,
          appId: 15368,
        }),
  );
  assert.equal(matchesGateCheckRun(captured, captured.head_sha, policy), true);
  assert.equal(
    matchesGateCheckRun(
      { ...captured, name: job ?? '' },
      captured.head_sha,
      policy,
    ),
    false,
  );
});

test('a base without an admission file waits for the base branch required Actions check', () => {
  // Verbatim `gh api repos/krn-works/krn-pilot-py/branches/main` before the adoption PR merged.
  const protectedBranch = readFileSync(
    new URL('../fixtures/ci-admission/branch-protected.json', import.meta.url),
    'utf8',
  );
  assert.deepEqual(gateAdmissionPolicyFromBranch(protectedBranch), {
    source: 'pinned-app',
    checkRunName: 'ci / Check',
    appId: 15368,
  });
  // Verbatim krn-works/krn main: protection without a pinned check keeps the legacy name.
  const unpinned = readFileSync(
    new URL('../fixtures/ci-admission/branch-unpinned.json', import.meta.url),
    'utf8',
  );
  assert.equal(
    gateAdmissionPolicyFromBranch(unpinned).source,
    'legacy-actions',
  );
  assert.equal(
    gateAdmissionPolicyFromBranch(
      JSON.stringify({
        protection: {
          required_status_checks: {
            checks: [
              { context: 'a', app_id: 15368 },
              { context: 'b', app_id: 15368 },
            ],
          },
        },
      }),
    ).source,
    'legacy-actions',
  );
});

test('a gate wait whose base names no policy waits for the check the base branch requires', async () => {
  const head = 'c'.repeat(40);
  const calls: string[] = [];
  const result = await waitForGate({
    repo: 'krn-works/krn-pilot-py',
    pr: 1,
    head,
    policy: gateAdmissionPolicyFromBase(base, () => ''),
    branchPolicy: async (ref) => {
      calls.push(ref);
      return gateAdmissionPolicyFromBranch(
        readFileSync(
          new URL(
            '../fixtures/ci-admission/branch-protected.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    },
    gh: async (args) =>
      args.includes('repos/krn-works/krn-pilot-py/pulls/1')
        ? JSON.stringify({
            head: { sha: head },
            mergeable_state: 'clean',
            base: { ref: 'main' },
          })
        : JSON.stringify([
            {
              check_runs: [
                {
                  id: 1,
                  name: 'ci / Check',
                  head_sha: head,
                  status: 'completed',
                  conclusion: 'success',
                  app: { id: 15368, slug: 'github-actions' },
                },
              ],
            },
          ]),
    sleep: async () => {},
    now: () => 0,
    pollMs: 1,
    timeoutMs: 1000,
  });
  assert.equal(result, 'success');
  assert.deepEqual(calls, ['main']);
});
