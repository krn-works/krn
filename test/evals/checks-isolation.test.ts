import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { digest, fixture, output } from './checks-fixture.ts';

test('eval check isolates network, evaluator tools and other inputs and preserves stream hashes', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  const server = createServer((socket) => socket.destroy());
  try {
    const other = join(f.directory, 'other-slot');
    await mkdir(other);
    await writeFile(join(other, 'canary'), 'untouched');
    const source = join(f.directory, 'source');
    await mkdir(source);
    await writeFile(join(source, 'canary'), 'source unchanged');
    const inputs = new Map<string, Buffer>();
    for (const name of ['manifest.json', ...Object.keys(f.value.inputs)])
      inputs.set(name, await readFile(join(f.experiment, name)));
    // krn eval check mounts the pinned Node from its mise install.
    const nodeBin = join(
      process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise'),
      'installs/node',
      process.versions.node,
      'bin',
    );
    await f.testFile(`const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      test('environment', () => {
        assert.equal(process.cwd(), '/w/repo/package');
        assert.equal(process.env.NODE_OPTIONS, '--test-reporter=tap');
        const paths = process.env.PATH.split(':');
        assert.equal(paths[0], '/w/repo/package/node_modules/.bin');
        assert.equal(paths[2], ${JSON.stringify(nodeBin)});
        assert.equal(paths[3], '/usr/bin');
        for (const name of ['npm', 'npx', 'scripts.json']) assert.throws(() => fs.writeFileSync(path.join(paths[1], name), 'true'), {code: 'EROFS'});
        for (const file of ${JSON.stringify([join(f.experiment, 'packet.md'), join(other, 'canary'), join(source, 'canary')])}) assert.throws(() => fs.readFileSync(file), {code: 'ENOENT'});
      });`);
    assert.equal(output(f.run()).status, 'PASS');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(address.port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
    });
    await f.testFile(
      `require('node:test')('network', async () => { await new Promise((resolve, reject) => { const socket = require('node:net').connect(${address.port}, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(); }); socket.on('error', reject); }); });\n`,
    );
    const network = output(f.run());
    assert.equal(network.status, 'FAIL');
    assert.equal(network.fail, 1);
    assert.equal(await readFile(join(other, 'canary'), 'utf8'), 'untouched');
    assert.equal(
      await readFile(join(source, 'canary'), 'utf8'),
      'source unchanged',
    );
    for (const [name, bytes] of inputs)
      assert.deepEqual(await readFile(join(f.experiment, name)), bytes);
    f.task.suiteChecks[0] = {
      argv: [
        'node',
        '-e',
        'process.stdout.write(Buffer.from([0,255,65,10]));process.stderr.write(Buffer.from([0,254,66,10]));process.exitCode=7',
      ],
      tests: false,
    };
    await f.save();
    const args = f.args();
    args[args.indexOf('focused')] = 'suite:0';
    const bytes = output(f.invoke(args));
    assert.equal(bytes.exitCode, 7);
    assert.equal(bytes.stdoutSha256, digest(Buffer.from([0, 255, 65, 10])));
    assert.equal(bytes.stderrSha256, digest(Buffer.from([0, 254, 66, 10])));
    assert.deepEqual(output(f.invoke(args)), bytes);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
