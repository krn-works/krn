import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { git, redFirst } from '../../src/flow/repository.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('red-first proves a preloader-dependent contract in the review sandbox and records capability skips', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;

  const root = mkdtempSync(join(tmpdir(), 'krn-red-first-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message: string) => {
    git(root, ['add', '--all']);
    git(root, ['commit', '-qm', message]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Review test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  put('.gitignore', '.krn/\n');
  put('package.json', '{"type":"module"}');
  put(
    'scripts/isolation-gate.mjs',
    readFileSync(
      new URL('../../scripts/isolation-gate.mjs', import.meta.url),
      'utf8',
    ),
  );
  put(
    'test/helpers/isolation.ts',
    readFileSync(new URL('../helpers/isolation.ts', import.meta.url), 'utf8'),
  );
  put(
    'krn.review.json',
    JSON.stringify({
      version: 1,
      testFile: { import: ['scripts/isolation-gate.mjs'] },
    }),
  );
  put('src/value.mjs', 'export const value = 1;\n');
  const base = commit('base runner configuration');

  const preloaderTest = 'test/preloader.test.ts';
  const isolationTest = 'test/isolation.test.ts';
  put('src/value.mjs', 'export const value = 2;\n');
  put(
    preloaderTest,
    `import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/isolation.ts';
import { value } from '../src/value.mjs';
test('value', () => assert.equal(value, 2));
`,
  );
  put(
    isolationTest,
    `import { test } from 'node:test';
import { requiresIsolation } from './helpers/isolation.ts';
test('requires user bus', (t) => {
  if (!requiresIsolation(t, t.name, ['systemdUserScope'])) return;
  throw new Error('review sandbox must not run nested isolation');
});
`,
  );
  const head = commit(
    `fix value\n\nChange-contract: ${preloaderTest}:red->green\nChange-contract: ${isolationTest}:red->green`,
  );

  // Use the default executor: systemd-run and bwrap, including its process monitor.
  const report = await redFirst(root, base, head);
  for (const run of report.results)
    assert.doesNotMatch(run.summary, /detached/u, JSON.stringify(run));
  assert.deepEqual(
    report.results
      .filter((run) => run.path === preloaderTest)
      .map(({ side, classification, exitCode }) => ({
        side,
        classification,
        exitCode,
      })),
    [
      { side: 'base', classification: 'assertion', exitCode: 1 },
      { side: 'head', classification: 'pass', exitCode: 0 },
    ],
    JSON.stringify(report),
  );
  const proven = report.contracts?.find(({ path }) => path === preloaderTest);
  assert.equal(proven?.red?.classification, 'assertion');
  assert.equal(proven?.green.classification, 'pass');
  assert.equal(proven?.proven, true);

  const skipped = report.contracts?.find(({ path }) => path === isolationTest);
  assert.equal(skipped?.cause, 'capability');
  assert.equal(skipped?.proven, false);
  const isolationRuns = report.results.filter(
    (run) => run.path === isolationTest,
  );
  assert.equal(isolationRuns.length, 2);
  for (const run of [...isolationRuns, skipped?.red, skipped?.green]) {
    assert.equal(run?.classification, 'skipped');
    assert.equal(run?.exitCode, 0);
    assert.equal(run?.cause, 'capability');
    assert.equal(run?.proven, false);
  }
});
