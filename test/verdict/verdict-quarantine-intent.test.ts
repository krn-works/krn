import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sandbox from '../../src/verdict/sandbox.ts';

const sandboxUrl = pathToFileURL(
  join(import.meta.dirname, '../../src/verdict/sandbox.ts'),
).href;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-quarantine-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'temporary');
  mkdirSync(directory);
  t.mock.method(process.stderr, 'write', () => true);
  const owners = join(directory, '.verdict-owners');
  return { root, directory, owners };
}

// Allocates a tree in a child, then quarantines it under a zero file-size limit so the
// quarantine write fails (EFBIG) and the child exits: a dead owner with an unmarked record.
function interruptedQuarantine(f: { root: string; directory: string }) {
  const script = join(f.root, 'owner.mjs');
  writeFileSync(
    script,
    [
      `const sandbox = await import(${JSON.stringify(sandboxUrl)});`,
      `const copy = await sandbox.createWorktreeDirectory(${JSON.stringify(f.directory)}, ${JSON.stringify(f.root)});`,
      `process.stdout.write(copy);`,
      `const { execFileSync } = await import('node:child_process');`,
      `execFileSync('bash', ['-c', 'ulimit -f 0; exec "$0" "$@"', process.execPath, ${JSON.stringify(join(f.root, 'quarantine.mjs'))}, copy], { stdio: 'ignore' });`,
    ].join('\n'),
  );
  writeFileSync(
    join(f.root, 'quarantine.mjs'),
    `const sandbox = await import(${JSON.stringify(sandboxUrl)});\nsandbox.quarantineVerdictTree(process.argv[2]);\n`,
  );
  const child = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  assert.notEqual(child.status, 0, 'the quarantine write must fail');
  const copy = child.stdout.trim();
  assert.ok(copy.startsWith(join(f.directory, 'verdict-')), child.stderr);
  assert.ok(existsSync(copy));
  return copy;
}

test('an interrupted quarantine keeps its tree while a check scope may be live', async (t) => {
  assert.equal(typeof sandbox.sweepOrphanedVerdictTrees, 'function');
  const f = await fixture(t);
  const copy = interruptedQuarantine(f);

  await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
    scopeProbe: () => true,
  });
  assert.ok(existsSync(copy), 'a live scope keeps the tree');

  await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
    scopeProbe: () => {
      throw new Error('probe failed');
    },
  });
  assert.ok(existsSync(copy), 'a failed probe keeps the tree');
  assert.ok(
    readdirSync(f.owners).some((name) =>
      name.startsWith(`.${basename(copy)}.json.`),
    ),
    'the quarantine marker stays while its tree exists',
  );
});

test('an interrupted quarantine tree goes once no check scope is live, with its marker', async (t) => {
  const f = await fixture(t);
  const copy = interruptedQuarantine(f);

  await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
    scopeProbe: () => false,
  });

  assert.ok(!existsSync(copy));
  assert.deepEqual(readdirSync(f.owners), []);
});

test('an old unrecorded tree with a quarantine marker waits for its scopes', async (t) => {
  const f = await fixture(t);
  const copy = interruptedQuarantine(f);
  rmSync(join(f.owners, `${basename(copy)}.json`));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(copy, old, old);

  await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
    scopeProbe: () => true,
  });
  assert.ok(existsSync(copy));

  await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
    scopeProbe: () => false,
  });
  assert.ok(!existsSync(copy));
});
