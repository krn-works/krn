import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  sessionEnvironment,
  wrapperDirectory,
} from '../../src/cli/lane-run/environment.ts';
import { runTests } from '../../src/hook/stop.ts';
import { receiverEnv } from '../../src/repo/receiver-env.ts';

// A verbatim shape of `mise env --json` in a receiver pinning Node 26.10.0.
const captured = JSON.stringify({
  PATH: '/mise/installs/node/26.10.0/bin:/usr/bin',
  MISE_NODE_VERSION: '26.10.0',
});

function receiver(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'krn-receiver-'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
}

test('a receiver that pins its toolchain resolves the mise env over the given env', () => {
  const dir = receiver({ 'mise.toml': '[tools]\nnode = "26.10.0"\n' });
  try {
    const env = receiverEnv(
      dir,
      { PATH: '/usr/bin', KEEP: '1' },
      () => captured,
    );
    assert.equal(env.PATH, '/mise/installs/node/26.10.0/bin:/usr/bin');
    assert.equal(env.KEEP, '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a launcher MISE_NODE_VERSION override never outranks the receiver pin', () => {
  const dir = receiver({ 'mise.toml': '[tools]\nnode = "26.10.0"\n' });
  try {
    let asked: NodeJS.ProcessEnv = {};
    const env = receiverEnv(
      dir,
      { PATH: '/usr/bin', MISE_NODE_VERSION: '24.22.1' },
      (_root, given) => {
        asked = given;
        return captured;
      },
    );
    assert.equal(asked.MISE_NODE_VERSION, undefined);
    assert.equal(env.MISE_NODE_VERSION, '26.10.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a receiver with no pin keeps the env as given and never asks mise', () => {
  const dir = receiver({});
  try {
    const given = { PATH: '/usr/bin' };
    assert.equal(
      receiverEnv(dir, given, () => assert.fail('mise must not run')),
      given,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mise that refuses or prints no JSON keeps the env as given', () => {
  const dir = receiver({ 'mise.toml': '[tools]\nnode = "26.10.0"\n' });
  try {
    const given = { PATH: '/usr/bin' };
    assert.equal(
      receiverEnv(dir, given, () => undefined),
      given,
    );
    assert.equal(
      receiverEnv(dir, given, () => 'not json'),
      given,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mise = spawnSync('mise', ['where', 'node@26.10.0'], {
  encoding: 'utf8',
});
const realMise = mise.status === 0;

if (realMise)
  test('the Stop check runs the receiver pinned Node, not the Node running the hook', () => {
    const dir = receiver({
      'mise.toml': '[tools]\nnode = "26.10.0"\n',
      'pin.test.mjs':
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('runs the pinned node', () => {\n  assert.match(process.version, /^v26\\.10\\./u);\n});\n",
    });
    try {
      spawnSync('mise', ['trust', dir]);
      assert.notEqual(process.version.slice(0, 4), 'v26.');
      // The KRN launcher exports its own Node pin to every child.
      process.env.MISE_NODE_VERSION = process.version.slice(1);
      try {
        assert.deepEqual(runTests(dir, ['pin.test.mjs']), []);
      } finally {
        delete process.env.MISE_NODE_VERSION;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

if (realMise)
  test('a lane session PATH follows the receiver pin and keeps the wrapper first', () => {
    const dir = receiver({ 'mise.toml': '[tools]\nnode = "26.10.0"\n' });
    try {
      spawnSync('mise', ['trust', dir]);
      const env = sessionEnvironment({ PATH: process.env.PATH }, '/c', {
        lane: 'l',
        receiver: dir,
      });
      assert.ok(env.PATH?.startsWith(`${wrapperDirectory}${delimiter}`));
      assert.match(env.PATH ?? '', /node\/26\.10\.0\/bin/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('a lane session without a receiver keeps the given PATH', () => {
  const env = sessionEnvironment({ PATH: '/bin' }, '/c', { lane: 'l' });
  assert.equal(env.PATH, `${wrapperDirectory}${delimiter}/bin`);
});

test('a receiver with no pin runs the check on the hook Node', () => {
  const dir = receiver({
    'same.test.mjs': `import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('same node', () => {\n  assert.equal(process.version, ${JSON.stringify(process.version)});\n});\n`,
  });
  try {
    mkdirSync(join(dir, 'x'));
    assert.deepEqual(runTests(dir, ['same.test.mjs']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
