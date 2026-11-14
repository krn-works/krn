import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyGaps } from '../../src/adopt/verify.ts';

// KRN-12: verbatim `gh api` captures; the CLI test puts a gh that replays them first on PATH.
const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    'utf8',
  );
const repo = fixture('gh/repo-krn-works-krn.stdout.json');
const protectedBranch = fixture('ci-admission/branch-protected.json');
const unpinned = fixture('ci-admission/branch-unpinned.json');
// The live krn-works/krn answers: Check is required by a ruleset, so classic protection is empty.
const rulesetOnly = fixture('gh/rules-branches-main-krn-works-krn.stdout.json');
const noAutoMerge = repo.replace(
  '"allow_auto_merge":true',
  '"allow_auto_merge":false',
);
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

test('a repository with the required check and auto-merge has no gap', () => {
  assert.deepEqual(verifyGaps(repo, protectedBranch), []);
});

test('a missing required check and disabled auto-merge are each named', () => {
  assert.notEqual(noAutoMerge, repo);
  assert.deepEqual(verifyGaps(repo, unpinned), [
    'branch main has no single required status check from GitHub Actions',
  ]);
  assert.deepEqual(verifyGaps(noAutoMerge, protectedBranch), [
    'auto-merge is not allowed (repository setting allow_auto_merge)',
  ]);
});

test('a check required by a ruleset counts, as on krn-works/krn', () => {
  assert.deepEqual(verifyGaps(repo, unpinned, rulesetOnly), []);
});

function verify(
  repoBody: string,
  branchBody: string,
  rulesBody = '[]',
  prepare: (root: string) => void = () => {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-verify-'));
  prepare(dir);
  writeFileSync(join(dir, 'repo.json'), repoBody);
  writeFileSync(join(dir, 'branch.json'), branchBody);
  writeFileSync(join(dir, 'rules.json'), rulesBody);
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\ncase "$2" in */rules/branches/*) cat "${dir}/rules.json";; */branches/*) cat "${dir}/branch.json";; *) cat "${dir}/repo.json";; esac\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  return spawnSync(process.execPath, [cli, 'adopt', dir, '--verify'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });
}

test('adopt --verify exits 0 when set and 1 naming the gap otherwise', () => {
  const ok = verify(repo, protectedBranch);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = verify(noAutoMerge, unpinned);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /verify gap: auto-merge is not allowed/u);
  assert.match(bad.stdout, /verify gap: branch main has no single required/u);
  const ruleset = verify(repo, unpinned, rulesetOnly);
  assert.equal(ruleset.status, 0, ruleset.stdout);
});

const withWorkflow = (name: string, contract?: string) => (root: string) => {
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL(`../fixtures/workflows/${name}`, import.meta.url)),
    join(root, '.github/workflows', name),
  );
  if (contract) writeFileSync(join(root, 'krn.json'), contract);
};

test('adopt --verify names a deploying base-branch workflow until krn.json acknowledges it', () => {
  const bad = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow('deploy-on-push.yml'),
  );
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(
    bad.stdout,
    /verify gap: \.github\/workflows\/deploy-on-push\.yml deploys on a push to main/u,
  );
  assert.match(bad.stdout, /"deploy": "acknowledged"/u);
  const ok = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow(
      'deploy-on-push.yml',
      '{"test":"true","deploy":"acknowledged"}',
    ),
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const plain = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow('test-only.yml'),
  );
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
});
