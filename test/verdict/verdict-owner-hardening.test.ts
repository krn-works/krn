import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as sandbox from '../../src/verdict/trees.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-verdict-owner-hardening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'temporary');
  const outside = join(root, 'outside');
  mkdirSync(directory);
  mkdirSync(outside);
  const owners = join(directory, '.verdict-owners');
  const tree = join(directory, 'verdict-orphan');
  const record = join(owners, `${basename(tree)}.json`);
  const now = Date.now();
  const age = (hours: number) => new Date(now - hours * 60 * 60 * 1000);
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });
  return { root, directory, outside, owners, tree, record, now, age, writes };
}

for (const kind of ['symlink', 'file']) {
  test(`a ${kind} owner directory blocks record operations and sweeping but allows allocation`, async (t) => {
    const f = fixture(t);
    const outsideRecord = join(f.outside, 'verdict-gone.json');
    const contents = JSON.stringify({ pid: process.pid, start: '0' });
    writeFileSync(outsideRecord, contents);
    if (kind === 'symlink') symlinkSync(f.outside, f.owners);
    else writeFileSync(f.owners, 'owner directory is a file');
    mkdirSync(f.tree);
    utimesSync(f.tree, f.age(25), f.age(25));

    let allocated = '';
    await assert.doesNotReject(async () => {
      allocated = await sandbox.createWorktreeDirectory(f.directory, f.root);
    });

    assert.ok(lstatSync(allocated).isDirectory());
    assert.ok(existsSync(f.tree), 'invalid owners must disable the sweep');
    assert.deepEqual(readdirSync(f.outside), ['verdict-gone.json']);
    assert.equal(readFileSync(outsideRecord, 'utf8'), contents);
    if (kind === 'file')
      assert.equal(readFileSync(f.owners, 'utf8'), 'owner directory is a file');
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]?.trimEnd().split('\n').length, 1);

    f.writes.length = 0;
    await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory);
    sandbox.removeVerdictTreeOwner(join(f.directory, 'verdict-gone'));
    assert.ok(existsSync(f.tree));
    assert.deepEqual(readdirSync(f.outside), ['verdict-gone.json']);
    assert.equal(readFileSync(outsideRecord, 'utf8'), contents);
  });
}

for (const hours of [25, 1]) {
  test(`a symlink owner record uses the ${hours} hour tree age and leaves its target intact`, async (t) => {
    const f = fixture(t);
    mkdirSync(f.owners, { mode: 0o700 });
    mkdirSync(f.tree);
    const outsideRecord = join(f.outside, 'owner.json');
    const contents = JSON.stringify({ pid: process.pid, start: '0' });
    writeFileSync(outsideRecord, contents);
    symlinkSync(outsideRecord, f.record);
    utimesSync(f.tree, f.age(hours), f.age(hours));
    let ownerProbes = 0;

    await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
      now: () => f.now,
      isOwnerAlive: () => {
        ownerProbes++;
        return false;
      },
    });

    assert.equal(ownerProbes, 0, 'a symlink record must never supply an owner');
    assert.equal(existsSync(f.tree), hours < 24);
    assert.equal(existsSync(f.record), hours < 24);
    assert.equal(readFileSync(outsideRecord, 'utf8'), contents);
  });
}

for (const contents of [
  '{bad json',
  '{}',
  '{"pid":0,"start":"0"}',
  '{"pid":1,"start":"invalid"}',
]) {
  for (const hours of [25, 1]) {
    test(`malformed owner ${contents} uses the ${hours} hour tree age`, async (t) => {
      const f = fixture(t);
      mkdirSync(f.owners, { mode: 0o700 });
      mkdirSync(f.tree);
      writeFileSync(f.record, contents);
      utimesSync(f.tree, f.age(hours), f.age(hours));

      await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
        now: () => f.now,
      });

      assert.equal(existsSync(f.tree), hours < 24);
      assert.equal(existsSync(f.record), hours < 24);
    });
  }
}

for (const kind of ['symlink', 'file']) {
  test(`a dead owner's ${kind} tree entry is unlinked without following its target`, async (t) => {
    const f = fixture(t);
    mkdirSync(f.owners, { mode: 0o700 });
    const marker = join(f.outside, 'preserved');
    writeFileSync(marker, 'outside tree');
    if (kind === 'symlink') {
      // A .git file must not make the sweep treat this link as a worktree.
      writeFileSync(join(f.outside, '.git'), 'outside git pointer');
      symlinkSync(f.outside, f.tree);
      lutimesSync(f.tree, f.age(1), f.age(1));
    } else writeFileSync(f.tree, 'tree entry is a file');
    writeFileSync(f.record, JSON.stringify({ pid: process.pid, start: '0' }));

    await sandbox.sweepOrphanedVerdictTrees(f.root, f.directory, {
      isOwnerAlive: () => false,
    });

    assert.equal(lstatSync(f.tree, { throwIfNoEntry: false }), undefined);
    assert.equal(existsSync(f.record), false);
    assert.equal(readFileSync(marker, 'utf8'), 'outside tree');
    if (kind === 'symlink')
      assert.equal(
        readFileSync(join(f.outside, '.git'), 'utf8'),
        'outside git pointer',
      );
  });
}

test('quarantining a symlink record never overwrites its target', (t) => {
  const f = fixture(t);
  mkdirSync(f.owners, { mode: 0o700 });
  mkdirSync(f.tree);
  const outsideRecord = join(f.outside, 'owner.json');
  const contents = JSON.stringify({ pid: process.pid, start: '0' });
  writeFileSync(outsideRecord, contents);
  symlinkSync(outsideRecord, f.record);

  try {
    sandbox.quarantineVerdictTree(f.tree);
  } catch {
    // Refusing the planted record is allowed; modifying its target is not.
  }

  assert.equal(readFileSync(outsideRecord, 'utf8'), contents);
});

test('allocation creates a private regular owner record', async (t) => {
  const f = fixture(t);
  const tree = await sandbox.createWorktreeDirectory(f.directory, f.root);
  const record = join(f.owners, `${basename(tree)}.json`);

  assert.ok(lstatSync(record).isFile());
  assert.equal(lstatSync(record).mode & 0o777, 0o600);
});
