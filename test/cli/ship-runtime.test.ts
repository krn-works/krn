import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { outsideRunner } from '../../src/cli/pr.ts';

// Every CLI path that ships carries the guards `krn pr ship` carries (deploy refusal, claim
// release, base): a call that hand-builds its own runtime drops the ones it forgets.
test('every shipCommand caller outside src/ci/ship.ts passes cliShipRuntime', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter(
      (f) =>
        f.endsWith('.ts') && join('src', f) !== join('src', 'ci', 'ship.ts'),
    )
    .map((f) => join('src', f));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/shipCommand\(/gu)) {
      const call = text.slice(match.index, match.index + 300);
      if (!call.includes('cliShipRuntime')) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the ship runner gives git in an outside repository its App credential helper, and leaves the product repository alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-runner-'));
  try {
    const outside = join(root, 'outside');
    const product = join(root, 'product');
    for (const [dir, url] of [
      [outside, 'https://github.com/krn-works/seo-audit-harness.git'],
      [product, 'https://github.com/krn-works/krn.git'],
    ] as const) {
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    }
    const seen: string[][] = [];
    const runner = outsideRunner((command, args) => {
      seen.push([command, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    });
    runner('git', ['push', 'origin', 'b'], outside);
    runner('git', ['push', 'origin', 'b'], product);
    runner('gh', ['pr', 'list'], outside);
    const [push, productPush, gh] = seen;
    assert.equal(push?.[1], '-c');
    assert.equal(push?.[2], 'credential.https://github.com.helper=');
    assert.match(
      push?.[4] ?? '',
      /KRN_APP_REPOSITORY='krn-works\/seo-audit-harness'.*git-credential$/u,
    );
    assert.deepEqual(push?.slice(-3), ['push', 'origin', 'b']);
    assert.deepEqual(productPush, ['git', 'push', 'origin', 'b']);
    assert.deepEqual(gh, ['gh', 'pr', 'list']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
