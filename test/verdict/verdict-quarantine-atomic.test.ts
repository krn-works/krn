import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sandbox from '../../src/verdict/trees.ts';

const sandboxUrl = pathToFileURL(
  join(import.meta.dirname, '../../src/verdict/trees.ts'),
).href;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-quarantine-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'temporary');
  mkdirSync(directory);
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });
  const tree = await sandbox.createWorktreeDirectory(directory, root);
  const owners = join(directory, '.verdict-owners');
  const record = join(owners, `${basename(tree)}.json`);
  return { root, directory, tree, owners, record, writes };
}

test('a quarantine interrupted while writing keeps the original owner record', async (t) => {
  assert.equal(typeof sandbox.quarantineVerdictTree, 'function');
  const f = await fixture(t);
  const original = readFileSync(f.record, 'utf8');
  const script = join(f.root, 'quarantine.mjs');
  writeFileSync(
    script,
    `const sandbox = await import(${JSON.stringify(sandboxUrl)});\nsandbox.quarantineVerdictTree(process.argv[2]);\n`,
  );

  // A zero file-size limit fails the child's first file write (EFBIG; Node ignores SIGXFSZ).
  const child = spawnSync(
    'bash',
    ['-c', 'ulimit -f 0; exec "$0" "$@"', process.execPath, script, f.tree],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    },
  );

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /EFBIG/u);
  assert.ok(
    existsSync(f.record),
    'the owner record must survive the interrupt',
  );
  assert.equal(readFileSync(f.record, 'utf8'), original);
});

test('quarantine replaces the record with a quarantined copy and leaves no temporary file', async (t) => {
  const f = await fixture(t);
  const before = JSON.parse(readFileSync(f.record, 'utf8'));

  sandbox.quarantineVerdictTree(f.tree);

  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), {
    ...before,
    quarantined: true,
  });
  assert.deepEqual(readdirSync(f.owners), [basename(f.record)]);
});

test('the sweep removes temporary records of dead writers and keeps live ones', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-quarantine-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process.stderr, 'write', () => true);
  const directory = join(root, 'temporary');
  const owners = join(directory, '.verdict-owners');
  mkdirSync(owners, { recursive: true, mode: 0o700 });
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  const dead = `.verdict-gone.json.${exited.pid}.tmp`;
  const live = `.verdict-busy.json.${process.pid}.tmp`;
  writeFileSync(join(owners, dead), '{');
  writeFileSync(join(owners, live), '{');

  await sandbox.createWorktreeDirectory(directory, root);

  const left = readdirSync(owners);
  assert.ok(!left.includes(dead), 'a dead writer leaves no temporary record');
  assert.ok(left.includes(live), 'a live writer keeps its temporary record');
});
