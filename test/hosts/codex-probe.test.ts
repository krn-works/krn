import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolveSupportedCodex } from '../../src/hosts/codex.ts';
import { probeCodexAppServer } from '../../src/hosts/codex-probe.ts';
import { pickCodexReceiver } from '../../src/worker/receiver.ts';
import { capture } from '../receivers/capture.ts';
import { stubSystemd } from '../worker/session-fixture.ts';

const directory = 'fixtures/codex-app-server-startup';
const supported: readonly string[] = JSON.parse(
  readFileSync('spec/worker-scope.json', 'utf8'),
).supportedVersions;

/** A fake Codex that replays one captured probe and logs its argv. */
function replay(path: string, name: string): void {
  const { exitCode, streams } = capture(directory, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(`${path}.argv`)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(${JSON.stringify((streams.stdout ?? Buffer.alloc(0)).toString('base64'))}, 'base64');\nprocess.exitCode = ${exitCode};\n`,
  );
  chmodSync(path, 0o755);
}

function home(t: import('node:test').TestContext, versions: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'krn-codex-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executables = Object.fromEntries(
    versions.map((version) => {
      const path = join(
        root,
        `.codex/packages/app-server-daemon/releases/${version}-x86_64-unknown-linux-musl/bin/codex`,
      );
      replay(path, 'startup-config');
      return [version, path];
    }),
  );
  return { root, executables };
}

function withoutOverride(t: import('node:test').TestContext) {
  const previous = process.env.KRN_CODEX_BIN;
  delete process.env.KRN_CODEX_BIN;
  t.after(() => {
    if (previous !== undefined) process.env.KRN_CODEX_BIN = previous;
  });
}

test('every supported Codex version has recorded app-server captures', () => {
  for (const fixtures of ['fixtures/codex-app-server', directory]) {
    const provenance = JSON.parse(
      readFileSync(`test/${fixtures}/provenance.json`, 'utf8'),
    );
    const captured = /^codex-cli (\S+)$/u.exec(provenance.receiver)?.[1];
    for (const version of supported)
      assert.equal(
        version,
        captured,
        `spec/worker-scope.json supports ${version} without a capture in test/${fixtures}/provenance.json`,
      );
  }
});

test('the resolver picks the newest supported release from the policy list', (t) => {
  withoutOverride(t);
  const { root, executables } = home(t, ['0.166.0', '0.168.0']);
  assert.deepEqual(resolveSupportedCodex(['0.166.0'], root), {
    executable: executables['0.166.0'],
    version: '0.166.0',
  });
  assert.equal(resolveSupportedCodex(['0.165.0'], root), undefined);
});

test('the probe reads the captured startup config and its refusal', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'krn-codex-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ok = join(root, 'ok/codex');
  const invalid = join(root, 'invalid/codex');
  replay(ok, 'startup-config');
  replay(invalid, 'startup-config-invalid');
  assert.deepEqual(probeCodexAppServer(ok, root), { version: '0.167.0' });
  assert.deepEqual(JSON.parse(readFileSync(`${ok}.argv`, 'utf8')), [
    'app-server',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="workspace-write"',
    '--print-startup-config',
  ]);
  const refused = probeCodexAppServer(invalid, root);
  assert.ok('error' in refused);
  assert.match(
    refused.error,
    /^exit 1: failed to load configuration: unknown variant `sometimes`/u,
  );
});

test('the probe version must equal the chosen release', (t) => {
  withoutOverride(t);
  const { root } = home(t, ['0.166.0']);
  assert.throws(
    () => pickCodexReceiver(['0.166.0'], root, root),
    /reports 0\.167\.0; expected 0\.166\.0/u,
  );
});

test('worker start exits 65 before any systemd scope when no installed release is supported', (t) => {
  const { root } = home(t, ['0.168.0']);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(repo, 'spec/worker-scope.json'),
    readFileSync('spec/worker-scope.json'),
  );
  writeFileSync(join(root, 'brief.md'), 'ok');
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=w',
      '-c',
      'user.email=w@example.invalid',
      'commit',
      '-qm',
      'base',
    ],
  ])
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  stubSystemd(bin);
  const marker = join(root, 'systemd-run.called');
  writeFileSync(
    join(bin, 'systemd-run'),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.KRN_CODEX_BIN;
  const run = join(repo, '.krn/runs/worker');
  const result = spawnSync(
    process.execPath,
    [
      resolve('src/cli/krn.mjs'),
      'worker',
      'start',
      '--repo',
      repo,
      '--brief',
      join(root, 'brief.md'),
      '--run',
      run,
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 65, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(
      `no installed Codex release is supported; spec/worker-scope.json supports ${supported.join(', ').replaceAll('.', '\\.')}`,
      'u',
    ),
  );
  assert.equal(existsSync(marker), false, 'systemd-run was invoked');
  assert.equal(existsSync(join(run, 'session.json')), false);
});
