import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  gateAdmissionPolicyFromBase,
  matchesGateCheckRun,
} from '../../src/deliver/admission-policy.ts';

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
