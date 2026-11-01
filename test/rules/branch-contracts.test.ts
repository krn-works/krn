import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Dynamic URL keeps the absent base implementation an assertion failure.
const script = new URL('../../scripts/head-trailers.mjs', import.meta.url);
const api = await import(script.href).catch(() => undefined);

const trailer = 'Ticket: t-abc\nCo-Authored-By: A <a@example.com>';

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function branch(
  t: { after: (fn: () => Promise<void>) => void },
  contracts: readonly string[],
): Promise<{ root: string; base: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), 'krn-branch-contracts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'a@example.com']);
  git(root, ['config', 'user.name', 'A']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', `base\n\n${trailer}`]);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  for (const [index, contract] of contracts.entries()) {
    await writeFile(join(root, `change-${index}.txt`), `${index}\n`);
    git(root, ['add', '.']);
    const lines = contract ? `${contract}\n` : '';
    git(
      root,
      ['commit', '-q', '-F', '-'],
      `change ${index}\n\n${trailer}\n${lines}`,
    );
  }
  return { root, base, head: git(root, ['rev-parse', 'HEAD']) };
}

const observer = 'Change-contract: test/rules/observer.test.ts:red->green';
const tracker = 'Change-contract: none (tracker-only commit)';
const invalid = [
  tracker,
  'Change-contract: test/rules/observer.test.ts',
  'Change-contract: test/rules/observer.test.ts:red->blue',
  'Change-contract: src/value.ts:red->green',
  'Change-contract: ../test/observer.test.ts:red->green',
  `${observer}\n${observer}`,
];

test('preflight accepts the contracts and tracker commits that review accepts', async (t) => {
  assert.equal(typeof api?.checkBranchContracts, 'function');
  const { root, base, head } = await branch(t, [observer, '']);
  assert.equal(api.checkBranchContracts(base, head, root).length, 1);
});

test('preflight refuses every branch commit contract that review refuses', async (t) => {
  assert.equal(typeof api?.checkBranchContracts, 'function');
  for (const contract of invalid) {
    // The invalid contract sits on an earlier commit, below a valid head.
    const { root, base, head } = await branch(t, [contract, observer]);
    assert.throws(
      () => api.checkBranchContracts(base, head, root),
      /invalid or duplicate Change-contract/u,
      contract,
    );
  }
});

test('the preflight command refuses a branch with an invalid contract', async (t) => {
  const command = fileURLToPath(script);
  const valid = await branch(t, [observer, '']);
  const accepted = spawnSync(process.execPath, [command], {
    cwd: valid.root,
    encoding: 'utf8',
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const refused = await branch(t, [tracker, '']);
  const result = spawnSync(process.execPath, [command], {
    cwd: refused.root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /none \(tracker-only commit\)/u);
});
