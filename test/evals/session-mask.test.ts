import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { cli, fixture, tree } from './session-fixture.ts';

test('eval mask with network exposes the host resolved resolv.conf bytes', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const observed = spawnSync(
      process.execPath,
      [
        cli,
        'eval',
        'mask',
        '--slot',
        f.slot,
        '--network',
        '--',
        '/usr/bin/cat',
        '/etc/resolv.conf',
      ],
      {
        env: { ...process.env, KRN_EVAL_RESOLV_CONF: '/etc/resolv.conf' },
        timeout: 30_000,
      },
    );
    assert.equal(observed.status, 0, observed.stderr.toString());
    assert.deepEqual(
      observed.stdout,
      await readFile(await realpath('/etc/resolv.conf')),
    );
  } finally {
    await f.cleanup();
  }
});
test('eval mask binds only the final resolver file read-only when network is enabled', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const resolver = join(f.directory, 'resolver');
    await mkdir(resolver);
    const target = join(resolver, 'nameservers');
    const neighbour = join(resolver, 'private');
    const bytes = Buffer.from('nameserver 127.0.0.53\n# fixture\r\n');
    await writeFile(target, bytes);
    await writeFile(neighbour, 'hidden\n');
    const alias = join(f.directory, 'resolv.conf');
    const intermediate = join(f.directory, 'resolver-link');
    await symlink('resolver/nameservers', intermediate);
    await symlink('resolver-link', alias);
    const before = await tree(resolver);
    const env = { KRN_EVAL_RESOLV_CONF: alias };
    const offline = f.invoke(
      ['mask', '--slot', f.slot, '--', '/usr/bin/test', '!', '-e', target],
      env,
    );
    assert.equal(offline.status, 0, offline.stderr);
    const dangling = join(f.directory, 'dangling-resolver');
    await symlink('absent', dangling);
    const withoutResolver = f.invoke(
      ['mask', '--slot', f.slot, '--', '/usr/bin/true'],
      { KRN_EVAL_RESOLV_CONF: dangling },
    );
    assert.equal(withoutResolver.status, 0, withoutResolver.stderr);
    const observed = f.invoke(
      [
        'mask',
        '--slot',
        f.slot,
        '--network',
        '--tool',
        dirname(process.execPath),
        '--',
        process.execPath,
        '-e',
        `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        process.stdout.write(fs.readFileSync(process.argv[1]).toString('base64'));
        assert.throws(() => fs.appendFileSync(process.argv[1], 'forbidden'), { code: 'EROFS' });
        assert.equal(fs.existsSync(process.argv[2]), false);
      `,
        target,
        neighbour,
      ],
      env,
    );
    assert.equal(observed.status, 0, observed.stderr);
    assert.deepEqual(Buffer.from(observed.stdout, 'base64'), bytes);
    assert.deepEqual(await tree(resolver), before);
  } finally {
    await f.cleanup();
  }
});
test('eval mask refuses dangling and non-regular resolver targets with network', async () => {
  const f = await fixture();
  try {
    const dangling = join(f.directory, 'resolv.conf');
    await symlink('absent', dangling);
    const directoryAlias = join(f.directory, 'resolver-directory');
    await symlink(f.tools, directoryAlias);
    const loop = join(f.directory, 'resolver-loop');
    await symlink(loop, loop);
    const unreadable = join(f.directory, 'resolver-unreadable');
    await writeFile(unreadable, 'nameserver 127.0.0.53\n', { mode: 0o000 });
    try {
      for (const path of [
        dangling,
        directoryAlias,
        f.tools,
        loop,
        unreadable,
        `${f.directory}/absent`,
      ]) {
        const observed = f.invoke(
          ['mask', '--slot', f.slot, '--network', '--', '/usr/bin/true'],
          { KRN_EVAL_RESOLV_CONF: path },
        );
        assert.equal(observed.status, 65, `${path}: ${observed.stderr}`);
      }
    } finally {
      await chmod(unreadable, 0o600);
    }
  } finally {
    await f.cleanup();
  }
});
