import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { cli, fixture } from './workspace-fixture.ts';

test('eval mask refuses invalid slots and reports bwrap startup failures as 70', async () => {
  const f = await fixture();
  try {
    for (const slot of [
      'relative',
      f.directory,
      join(f.directory, 'missing'),
    ]) {
      const result = f.invoke(['mask', '--slot', slot, '--', '/usr/bin/true']);
      assert.equal(result.status, 65, result.stderr);
      assert.match(result.stderr, /slot|repo/u);
    }
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap startup failure\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const args = ['mask', '--slot', slot, '--', '/usr/bin/true'];
    const failed = f.invoke(args, { PATH: tools });
    assert.equal(failed.status, 70, failed.stderr);
    assert.equal(failed.stderr, 'fixture bwrap startup failure\n');
    const missing = f.invoke(args, { PATH: join(tools, 'absent') });
    assert.equal(missing.status, 70);
    assert.match(missing.stderr, /bwrap.*ENOENT/u);
  } finally {
    await f.cleanup();
  }
});
test('eval mask refuses tool mounts that overlap reserved paths or the slot', async (t) => {
  const f = await fixture();
  try {
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap started\\n" >&2\nexit 70\n',
      { mode: 0o755 },
    );
    const invoke = (tool: string) =>
      f.invoke(
        ['mask', '--slot', slot, '--tool', tool, '--', '/usr/bin/true'],
        { PATH: tools },
      );
    for (const path of ['/', '/tmp', '/w', '/proc/x', '/usr', '/etc']) {
      await t.test(path, async () => {
        const result = invoke(path);
        assert.equal(result.status, 65, result.stderr);
        assert.match(
          result.stderr,
          /reserved|overlap|protected path|filesystem root/u,
        );
      });
    }
    for (const path of ['/usr/bin', dirname(process.execPath)]) {
      await t.test(`${path} remains available`, async () => {
        const result = invoke(path);
        assert.equal(result.status, 70, result.stderr);
        assert.equal(result.stderr, 'fixture bwrap started\n');
      });
    }
  } finally {
    await f.cleanup();
  }
});
test('eval mask refuses an ancestor of the slot as a tool directory', async () => {
  const temporaryRoot = process.env.TMPDIR;
  assert.ok(temporaryRoot, 'test suite provides a private TMPDIR');
  const f = await fixture({ temporaryRoot });
  try {
    const slot = join(f.directory, 'valid-slot');
    await mkdir(join(slot, 'repo'), { recursive: true });
    const tools = join(f.directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'bwrap'),
      '#!/bin/sh\nprintf "fixture bwrap started\\n" >&2\nexit 70\n',
      { mode: 0o755 },
    );
    const result = f.invoke(
      ['mask', '--slot', slot, '--tool', f.directory, '--', '/usr/bin/true'],
      { PATH: tools },
    );
    assert.equal(result.status, 65, result.stderr);
    assert.match(result.stderr, /overlap.*slot/u);
    const alias = join(f.directory, 'tools-alias');
    await symlink(tools, alias);
    const symlinked = f.invoke(
      ['mask', '--slot', slot, '--tool', alias, '--', '/usr/bin/true'],
      { PATH: tools },
    );
    assert.equal(symlinked.status, 65, symlinked.stderr);
    assert.match(symlinked.stderr, /symlink/u);
  } finally {
    await f.cleanup();
  }
});
test('eval mask provides a private writable /tmp', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    await mkdir(join(f.slot, 'repo'), { recursive: true });
    const hostTmpCanary = join(f.directory, 'host-tmp-canary');
    await writeFile(hostTmpCanary, 'host tmp\n');
    const script = `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      assert.equal(fs.statSync('/tmp').isDirectory(), true);
      fs.writeFileSync('/tmp/private-canary', 'private tmp\\n');
      assert.equal(fs.readFileSync('/tmp/private-canary', 'utf8'), 'private tmp\\n');
      assert.throws(() => fs.readFileSync(${JSON.stringify(hostTmpCanary)}), {code:'ENOENT'});
    `;
    const result = f.invoke([
      'mask',
      '--slot',
      f.slot,
      '--tool',
      '/usr/bin',
      '--tool',
      dirname(process.execPath),
      '--',
      'node',
      '-e',
      script,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
  } finally {
    await f.cleanup();
  }
});
test('eval mask hides every other workspace and home, fixes paths and preserves raw streams and exit', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const prepared = f.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const neighbour = join(
      f.root,
      f.value.id,
      'neighbour-task',
      'repo',
      'base.txt',
    );
    const hidden = [
      join(f.experiment, 'packet.md'),
      neighbour,
      join(f.source, 'base.txt'),
      join(f.home, '.codex', 'private'),
      '/w/home/.codex/private',
      '/w/.git',
      '/w/.krn',
      '/.git',
      '/.krn',
    ];
    const script = `
      const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process');
      for (const path of ${JSON.stringify(hidden)}) assert.throws(() => fs.readFileSync(path), {code:'ENOENT'}, path);
      assert.equal(process.cwd(), '/w/repo');
      assert.equal(process.env.HOME, '/w/home');
      assert.equal(process.env.TMPDIR, '/w/t');
      assert.equal(process.env.PATH, ${JSON.stringify(`${dirname(process.execPath)}:/usr/bin`)});
      assert.equal(process.env.KRN_MASK_PRIVATE, undefined);
      assert.equal(fs.readFileSync('base.txt', 'utf8'), 'base\\n');
      fs.writeFileSync('written', 'writable\\n');
      assert.equal(cp.execFileSync('git', ['-C','/w/repo','rev-parse','--show-toplevel'], {encoding:'utf8'}), '/w/repo\\n');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(dirname(process.execPath), 'mask-write'))}, ''), {code:'EROFS'});
      process.stdout.write(Buffer.from([0,255,65,10]));
      process.stderr.write(Buffer.from([0,254,66,10]));
      process.exitCode=7;
    `;
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'eval',
        'mask',
        '--slot',
        f.slot,
        '--tool',
        dirname(process.execPath),
        '--',
        'node',
        '-e',
        script,
        '--',
        '--json',
      ],
      {
        env: { ...process.env, HOME: f.home, KRN_MASK_PRIVATE: 'hidden' },
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 7, result.stderr.toString());
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 65, 10]));
    assert.deepEqual(result.stderr, Buffer.from([0, 254, 66, 10]));
    assert.equal(
      await readFile(join(f.slot, 'repo', 'written'), 'utf8'),
      'writable\n',
    );
    const exited = f.invoke([
      'mask',
      '--slot',
      f.slot,
      '--',
      '/usr/bin/sh',
      '-c',
      'printf "bwrap: command stderr\\n" >&2; exit 1',
    ]);
    assert.equal(exited.status, 1, exited.stderr);
    assert.equal(exited.stdout, '');
    assert.equal(exited.stderr, 'bwrap: command stderr\n');
  } finally {
    await f.cleanup();
  }
});
test('eval mask binds short Unix sockets and blocks TCP unless network is requested', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const prepared = f.prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const network of [false, true]) {
      const script = `
        const assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net');
        const dir = fs.mkdtempSync(process.env.TMPDIR+'/api-filter-test-');
        const unix = net.createServer();
        unix.on('error', error => { throw error; });
        unix.listen(dir+'/api.sock', () => unix.close(() => {
          const socket=net.connect({host:'127.0.0.1',port:${address.port}});
          socket.setTimeout(2000, () => { throw new Error('TCP did not settle'); });
          socket.once('connect', () => { socket.destroy(); assert.equal(${network},true); console.log('connected'); });
          socket.once('error', error => { assert.equal(${network},false); assert.ok(error.code); console.log('blocked'); });
        }));
      `;
      const result = f.invoke([
        'mask',
        '--slot',
        f.slot,
        '--tool',
        dirname(process.execPath),
        ...(network ? ['--network'] : []),
        '--',
        'node',
        '-e',
        script,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, network ? 'connected\n' : 'blocked\n');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
