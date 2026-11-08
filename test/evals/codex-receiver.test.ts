import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CAPTURED_CODEX_VERSIONS,
  capturedCodexVersion,
} from '../../src/evals/receiver.ts';
import { capture } from '../receivers/capture.ts';
import { fixture } from './session-fixture.ts';

const fixtures = fileURLToPath(new URL('../fixtures/eval/', import.meta.url));

test('captured Codex versions equal the test/fixtures/eval/codex-<version> directories', async () => {
  const directories = (await readdir(fixtures)).flatMap(
    (name) => /^codex-(\d+\.\d+\.\d+)$/u.exec(name)?.[1] ?? [],
  );
  assert.deepEqual([...CAPTURED_CODEX_VERSIONS].sort(), directories.sort());
  for (const version of CAPTURED_CODEX_VERSIONS) {
    const provenance = JSON.parse(
      await readFile(
        join(fixtures, `codex-${version}`, 'provenance.json'),
        'utf8',
      ),
    );
    assert.equal(provenance.receiver, `codex-cli ${version}`);
    // The session fixture's fake Codex replays this file for --version.
    assert.equal(
      provenance.captures.find(
        (entry: { name: string }) => entry.name === 'version',
      )?.stdout.file,
      'version.stdout.txt',
    );
  }
});

test('capturedCodexVersion accepts the captured --version line and refuses another', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { exitCode, streams } = capture(
    'fixtures/eval/codex-0.167.0',
    'version',
  );
  assert.equal(exitCode, 0);
  const replay = async (bytes: Buffer | string) => {
    const binary = join(f.tools, 'codex-version');
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(Buffer.from(bytes).toString('base64'))}, 'base64');\n`,
    );
    await chmod(binary, 0o755);
    return binary;
  };
  assert.equal(
    await capturedCodexVersion(await replay(streams.stdout ?? '')),
    'codex-cli 0.167.0',
  );
  await assert.rejects(
    capturedCodexVersion(await replay('codex-cli 0.168.0\n')),
    /codex reports "codex-cli 0\.168\.0"; captured receiver versions: 0\.167\.0/u,
  );
});

test('eval session exits 65 naming the captured versions before writing for an uncaptured Codex', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const observed = f.invoke(f.args(), {
    KRN_FIXTURE_CODEX_VERSION: 'codex-cli 0.170.0',
  });
  assert.equal(observed.status, 65, observed.stderr);
  const envelope = JSON.parse(observed.stdout);
  assert.equal(envelope.code, 65);
  assert.match(envelope.error, /captured receiver versions: 0\.167\.0/u);
  assert.deepEqual(await readdir(f.slot), ['repo']);
});
