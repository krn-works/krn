import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { laneDiffCoverage } from '../../src/cli/lane-run/diff-coverage.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

const source = `export function area(size: number): number {
  return size;
}
`;
const changedSource = `type Shape = { size: number };
export function area(size: number, shape?: Shape): number {
  if (size < 0) {
    const flipped: number = -size;
    return flipped;
  }
  return shape === undefined ? size : shape.size;
}
`;

/** A repository at its base, then a lane commit changing src/a.ts and adding the given test. */
function lane(related: string, testBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'krn-diff-coverage-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'lane@example.invalid');
  sh(dir, 'config', 'user.name', 'lane');
  writeFileSync(
    join(dir, 'krn.json'),
    JSON.stringify({ base: 'main', test: 'npm test', related }),
  );
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/a.ts'), source);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'lane');
  writeFileSync(join(dir, 'src/a.ts'), changedSource);
  writeFileSync(
    join(dir, 'test/a.test.ts'),
    `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { area } from '../src/a.ts';\n${testBody}\n`,
  );
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'lane');
  return dir;
}

const run = (dir: string) =>
  laneDiffCoverage(dir, 'main', join(dir, '.krn', 'tmp', 'coverage.info'));

test('a change adding an unexecuted branch reports that line uncovered under the real node runner', () => {
  const dir = lane(
    'node --test {files}',
    "test('area', () => { assert.equal(area(2), 2); assert.equal(area(1, { size: 3 }), 3); });",
  );
  try {
    assert.deepEqual(run(dir), {
      covered: 4,
      changed: 7,
      uncovered: ['src/a.ts:4', 'src/a.ts:5', 'src/a.ts:6'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fully covered change reports 0 uncovered under the real node runner', () => {
  const dir = lane(
    'node --test {files}',
    "test('area', () => { assert.equal(area(-2), 2); assert.equal(area(1, { size: 3 }), 3); });",
  );
  try {
    assert.deepEqual(run(dir), { covered: 7, changed: 7, uncovered: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a receiver whose tests do not run on the node runner has no coverage source (n/a)', () => {
  const dir = lane(
    'npx vitest run {files}',
    "test('area', () => { assert.equal(area(2), 2); });",
  );
  try {
    assert.equal(run(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
