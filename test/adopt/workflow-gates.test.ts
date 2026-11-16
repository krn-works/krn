import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  onlyMissing,
  runsCommand,
  workflowCommands,
  workflowGates,
} from '../../src/adopt/workflow-gates.ts';

// A plain hand-written GitHub Actions workflow, as a repository carries before adoption.
const own = `name: CI
on:
  pull_request:
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - name: Lint
        run: |
          npm run lint
          echo done
`;

// The call adopt writes to the shared project CI.
const call = `name: KRN CI
jobs:
  ci:
    uses: krn-works/krn/.github/workflows/project-ci.yml@${'a'.repeat(40)}
    with:
      install: "npm ci"
      test: "npm test"
`;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-workflow-gates-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, '.github/workflows', name), text);
  return root;
}

test('run steps, block scalars and call inputs are commands; other keys are not', () => {
  assert.deepEqual(workflowCommands(own), [
    'npm ci',
    'npm test',
    'npm run lint\necho done',
  ]);
  assert.deepEqual(workflowCommands(call), ['npm ci', 'npm test']);
  assert.equal(runsCommand(own, 'true'), false);
  assert.equal(runsCommand(own, 'npm run lint'), true);
  assert.equal(runsCommand('      - run: npm test:e2e\n', 'npm test'), false);
  assert.equal(
    runsCommand('      - run: npm ci && npm test\n', 'npm test'),
    true,
  );
});

test('a gate two workflows run is duplicated and one none runs is missing', () => {
  const root = repo({ 'ci.yml': own, 'krn-ci.yml': call });
  try {
    const commands = {
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    };
    const gates = workflowGates(root, commands);
    assert.deepEqual(gates.runBy, {
      lint: ['.github/workflows/ci.yml'],
      typecheck: [],
      test: ['.github/workflows/ci.yml', '.github/workflows/krn-ci.yml'],
    });
    assert.deepEqual(gates.missing, ['typecheck']);
    assert.deepEqual(gates.duplicated, ['test']);
    assert.deepEqual(
      onlyMissing(
        commands,
        workflowGates(root, commands, ['.github/workflows/krn-ci.yml']),
      ),
      { typecheck: 'npm run typecheck' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
