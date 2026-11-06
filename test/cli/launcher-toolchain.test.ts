import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const launcherSource = join(repository, 'bin', 'krn');
const nodePin = '24.22.1';
const goPin = '1.27.3';

async function stub(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
}

async function harness(root: string, withGoPin: boolean) {
  const repo = join(root, withGoPin ? 'with-go' : 'without-go');
  const miseData = join(root, `mise-${withGoPin ? 'go' : 'nogo'}`);
  await mkdir(join(repo, 'bin'), { recursive: true });
  await writeFile(join(repo, '.node-version'), `${nodePin}\n`);
  await writeFile(join(repo, 'bin', 'krn'), await readFile(launcherSource));
  await chmod(join(repo, 'bin', 'krn'), 0o755);
  if (withGoPin) {
    await mkdir(join(repo, 'infra', 'ci'), { recursive: true });
    await writeFile(
      join(repo, 'infra', 'ci', 'mise.toml'),
      `[tools]\ngo = "${goPin}"\n`,
    );
  }
  await stub(
    join(miseData, 'installs', 'node', nodePin, 'bin', 'node'),
    [
      'printf "PATH=%s\\n" "$PATH"',
      'printf "MISE_NODE_VERSION=%s\\n" "${MISE_NODE_VERSION-}"',
      'printf "MISE_GO_VERSION=%s\\n" "${MISE_GO_VERSION-}"',
    ].join('\n'),
  );
  await stub(join(miseData, 'installs', 'go', goPin, 'bin', 'go'), 'exit 0');
  const fakeBin = join(root, 'fake-bin');
  await stub(join(fakeBin, 'mise'), 'exit 1');
  const result = spawnSync(join(repo, 'bin', 'krn'), ['--probe'], {
    cwd: '/',
    encoding: 'utf8',
    env: {
      HOME: root,
      MISE_DATA_DIR: miseData,
      PATH: [fakeBin, '/usr/bin', '/bin'].join(delimiter),
    },
  });
  const fields = Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );
  return { result, fields, miseData };
}

test('launcher hands the pinned Node and Go to every child process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'krn-launcher-toolchain-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await t.test(
    'pinned Go and Node lead PATH and mise re-activation',
    async () => {
      const { result, fields, miseData } = await harness(root, true);
      assert.equal(result.status, 0, result.stderr);
      const path = String(fields.PATH).split(delimiter);
      assert.equal(path[0], join(miseData, 'installs', 'go', goPin, 'bin'));
      assert.equal(path[1], join(miseData, 'installs', 'node', nodePin, 'bin'));
      assert.equal(fields.MISE_NODE_VERSION, nodePin);
      assert.equal(fields.MISE_GO_VERSION, goPin);
    },
  );

  await t.test('a checkout without a Go pin still pins Node', async () => {
    const { result, fields, miseData } = await harness(root, false);
    assert.equal(result.status, 0, result.stderr);
    const path = String(fields.PATH).split(delimiter);
    assert.equal(path[0], join(miseData, 'installs', 'node', nodePin, 'bin'));
    assert.equal(fields.MISE_NODE_VERSION, nodePin);
    assert.equal(fields.MISE_GO_VERSION, '');
  });
});

test('repository mise.toml pins the same Node and Go as the gate', async () => {
  const config = join(repository, 'mise.toml');
  assert.ok(existsSync(config), 'mise.toml pins the repository toolchain');
  const text = await readFile(config, 'utf8');
  const node = (
    await readFile(join(repository, '.node-version'), 'utf8')
  ).trim();
  const go = /^go\s*=\s*"([^"]+)"/m.exec(
    await readFile(join(repository, 'infra', 'ci', 'mise.toml'), 'utf8'),
  )?.[1];
  assert.match(
    text,
    new RegExp(`^node = "${node.replaceAll('.', '\\.')}"$`, 'm'),
  );
  assert.match(
    text,
    new RegExp(`^go = "${String(go).replaceAll('.', '\\.')}"$`, 'm'),
  );
});
