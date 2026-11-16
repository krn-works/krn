import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import {
  isScratch,
  pruneRegistry,
  readRegistry,
  registerAdopted,
} from '../../src/brain/adopted-registry.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'krn-scratch-'));

test('a scratch adoption is not registered in the host registry unless --register forces it', () => {
  const home = scratch();
  const repo = join(scratch(), '.krn', 'tmp', 'clone');
  mkdirSync(repo, { recursive: true });
  const env = { HOME: home } as NodeJS.ProcessEnv;
  process.env.HOME = home;
  assert.equal(isScratch(repo), true);
  assert.equal(registerAdopted(repo, env), false);
  assert.equal(registerAdopted(repo, env, true), true);
  assert.deepEqual(readRegistry(join(home, '.krn', 'adopted.json')), [
    realpathSync(repo),
  ]);
});

test('a path with a tmp directory segment outside the system temp directory is scratch', () => {
  const outside = join(parse(process.cwd()).root, 'data', 'tmp', 'pm-clone');
  assert.equal(isScratch(outside), true);
  assert.equal(isScratch(join(process.cwd(), '.krn', 'tmp', 'x')), true);
  assert.equal(
    isScratch(join(parse(process.cwd()).root, 'data', 'repo')),
    false,
  );
});

test('pruning the host registry drops scratch paths, an explicit registry keeps them', () => {
  const live = scratch();
  const dir = scratch();
  const explicit = join(dir, 'adopted.json');
  writeFileSync(explicit, JSON.stringify([live]));
  assert.deepEqual(pruneRegistry(explicit), { roots: [live], pruned: 0 });
  assert.deepEqual(JSON.parse(readFileSync(explicit, 'utf8')), [live]);

  process.env.HOME = dir;
  const host = join(dir, '.krn', 'adopted.json');
  mkdirSync(join(dir, '.krn'));
  writeFileSync(host, JSON.stringify([live]));
  assert.deepEqual(pruneRegistry(host), { roots: [], pruned: 1 });
  assert.deepEqual(JSON.parse(readFileSync(host, 'utf8')), []);
});
