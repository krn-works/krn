import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gateAdmissionPolicyFromBase,
  matchesGateCheckRun,
} from '../../src/deliver/admission-policy.ts';

const base = 'a'.repeat(40);
const policyBlob = JSON.stringify({
  schemaVersion: 1,
  checkRunName: 'krn/gate',
  appId: 5548482,
});

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
      { name: 'krn/gate', head_sha: base, app: { id: 5548482 } },
      base,
      policy,
    ),
    false,
  );
});

test('base policy pins App ID, exact context, and exact check head', () => {
  const policy = gateAdmissionPolicyFromBase(base, (args) => {
    if (args[0] === 'ls-tree')
      return `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`;
    if (args[0] === 'cat-file') return policyBlob;
    throw new Error('unexpected Git read');
  });
  assert.equal(
    matchesGateCheckRun(
      { name: 'krn/gate', head_sha: base, app: { id: 5548482 } },
      base,
      policy,
    ),
    true,
  );
  for (const check of [
    { name: 'gate', head_sha: base, app: { id: 5548482 } },
    { name: 'krn/gate', head_sha: base, app: { id: 15368 } },
    { name: 'krn/gate', head_sha: 'c'.repeat(40), app: { id: 5548482 } },
  ])
    assert.equal(matchesGateCheckRun(check, base, policy), false);
});

test('malformed or non-regular base policy fails closed', () => {
  assert.throws(() =>
    gateAdmissionPolicyFromBase(base, (args) =>
      args[0] === 'ls-tree'
        ? `100644 blob ${'b'.repeat(40)}\tspec/ci-admission.json\n`
        : JSON.stringify({
            schemaVersion: 1,
            checkRunName: 'gate',
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
    { name: 'krn/gate', head_sha: base, app: { id: 5548482 } },
    { name: 'Check', head_sha: base, app: { id: 5548482 } },
    { name: 'Check', head_sha: 'c'.repeat(40), app: { id: 15368 } },
  ])
    assert.equal(matchesGateCheckRun(check, base, policy), false);
  for (const mixed of [
    { schemaVersion: 1, checkRunName: 'Check', appId: 5548482 },
    { schemaVersion: 1, checkRunName: 'krn/gate', appId: 15368 },
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
