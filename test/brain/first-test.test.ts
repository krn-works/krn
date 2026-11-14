import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type FirstTestStack,
  firstTestRecipe,
  firstTestStack,
} from '../../src/brain/first-test.ts';
import { laneBriefText } from '../../src/cli/lane-brief.ts';
import { bootstrapProof } from '../../src/cli/lane-run/bootstrap.ts';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'first-test-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  return root;
}

const vacuous = JSON.stringify({ test: 'exit 1', vacuous: true });
const PHP = '<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n';
const JS = 'export const add = (a, b) => {\n  return a + b;\n};\n';

const cases: Array<{
  stack: FirstTestStack;
  files: Record<string, string>;
  tests: Record<string, string>;
  command: string;
}> = [
  {
    stack: 'php',
    files: { 'krn.json': vacuous, 'composer.json': '{}', 'lib.php': PHP },
    tests: {
      'tests/smoke.php':
        "<?php\nrequire __DIR__ . '/../lib.php';\nexit(add(2, 3) === 5 ? 0 : 1);\n",
    },
    command: 'php tests/smoke.php',
  },
  {
    stack: 'wordpress',
    files: { 'krn.json': vacuous, 'functions.php': PHP, 'style.css': '/**/' },
    tests: {
      'tests/smoke.php':
        "<?php\nrequire __DIR__ . '/../functions.php';\nexit(add(2, 3) === 5 ? 0 : 1);\n",
    },
    command: 'php tests/smoke.php',
  },
  {
    stack: 'npm',
    files: { 'krn.json': vacuous, 'package.json': '{}', 'lib.mjs': JS },
    tests: {
      'test/lib.test.mjs':
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../lib.mjs";\ntest("add", () => assert.equal(add(2, 3), 5));\n',
    },
    command: 'node --test',
  },
];

for (const c of cases) {
  test(`the ${c.stack} recipe names its stack and its fixture goes from vacuous to red-on-mutation`, () => {
    const root = fixture(c.files);
    try {
      assert.equal(firstTestStack(root), c.stack);
      assert.match(
        laneBriefText(root, 'brief', '2026-11-14'),
        /First-test recipe/u,
      );
      assert.match(firstTestRecipe(c.stack), /krn\.json "test"/u);
      for (const [name, text] of Object.entries(c.tests)) {
        mkdirSync(join(root, name, '..'), { recursive: true });
        writeFileSync(join(root, name), text);
      }
      writeFileSync(
        join(root, 'krn.json'),
        JSON.stringify({ test: c.command }),
      );
      spawnSync('git', ['-C', root, 'add', '-A']);
      // a nested node --test run inside this runner would report green as a subtest
      delete process.env.NODE_TEST_CONTEXT;
      const proof = bootstrapProof(root, c.command);
      assert.ok('verified' in proof, JSON.stringify(proof));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a static site gets the node:test recipe and a non-vacuous repository gets no recipe', () => {
  const root = fixture({ 'krn.json': '{"test":"true"}', 'index.html': '<p>' });
  try {
    assert.equal(firstTestStack(root), 'static');
    assert.doesNotMatch(
      laneBriefText(root, 'brief', '2026-11-14'),
      /First-test recipe/u,
    );
    assert.match(firstTestRecipe('static'), /node:test/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
