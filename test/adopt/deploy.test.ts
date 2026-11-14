import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deploys,
  deployWorkflows,
  runsOnBase,
} from '../../src/adopt/deploy.ts';
import { parseContractFile } from '../../src/repo/contract.ts';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/workflows/${name}`, import.meta.url));

function repoWith(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-detect-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const file of files)
    copyFileSync(fixture(file), join(root, '.github/workflows', file));
  return root;
}

test('a workflow with an environment and an rsync step on a push to main deploys', () => {
  assert.deepEqual(deployWorkflows(repoWith('deploy-on-push.yml'), 'main'), [
    '.github/workflows/deploy-on-push.yml',
  ]);
});

test('a workflow that only tests on a push to main does not deploy', () => {
  assert.deepEqual(deployWorkflows(repoWith('test-only.yml'), 'main'), []);
});

test('a deploy triggered by tags only is not a deploy on the base branch', () => {
  assert.deepEqual(deployWorkflows(repoWith('deploy-on-tags.yml'), 'main'), []);
});

test('the trigger forms GitHub accepts are read', () => {
  assert.equal(runsOnBase('on: push\njobs: {}\n', 'main'), true);
  assert.equal(runsOnBase('on: [pull_request, push]\n', 'main'), true);
  assert.equal(runsOnBase('on:\n  - push\n', 'main'), true);
  assert.equal(runsOnBase('on:\n  pull_request:\n', 'main'), false);
  assert.equal(
    runsOnBase('on:\n  push:\n    branches: [develop]\n', 'main'),
    false,
  );
  assert.equal(
    runsOnBase("on:\n  push:\n    branches: ['release/**', main]\n", 'main'),
    true,
  );
  assert.equal(
    runsOnBase('on:\n  push:\n    branches-ignore:\n      - main\n', 'main'),
    false,
  );
  assert.equal(
    runsOnBase('on: { push: { branches: [main] } }\n', 'main'),
    true,
  );
  assert.equal(
    runsOnBase(
      'on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\n',
      'main',
    ),
    true,
  );
  assert.equal(
    runsOnBase('"on":\n  push:\n    branches: [main]\n', 'main'),
    true,
  );
});

test('deploy markers: actions, tools and step names; a test-named trigger is not one', () => {
  const job = (step: string) =>
    `on: push\njobs:\n  j:\n    steps:\n      ${step}\n`;
  assert.equal(deploys(job('- uses: cloudflare/wrangler-action@v3')), true);
  assert.equal(deploys(job('- run: npx vercel --prod')), true);
  assert.equal(
    deploys(job('- name: Publish package\n        run: echo x')),
    true,
  );
  assert.equal(deploys(job('- run: ssh host systemctl restart app')), true);
  assert.equal(deploys(job('- run: npm test')), false);
  assert.equal(
    deploys('on:\n  push:\n    branches: [deploy]\njobs: {}\n'),
    false,
  );
});

test('krn.json accepts only the acknowledged deploy value', () => {
  assert.deepEqual(
    parseContractFile('{"test":"true","deploy":"acknowledged"}').deploy,
    'acknowledged',
  );
  assert.throws(
    () => parseContractFile('{"deploy":"yes"}'),
    /"deploy" must be "acknowledged"/u,
  );
});
