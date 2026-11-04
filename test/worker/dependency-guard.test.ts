import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');

function commitManifest(repo: string) {
  writeFileSync(join(repo, 'package.json'), '{}\n');
  for (const args of [
    ['add', 'package.json'],
    [
      '-c',
      'user.name=worker',
      '-c',
      'user.email=worker@example.invalid',
      'commit',
      '-qm',
      'manifest',
    ],
  ]) {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
}

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-dependency-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(join(repo, 'spec'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\nnode_modules\ndeps/\n');
  writeFileSync(join(repo, 'README.md'), 'tracked\n');
  writeFileSync(
    join(repo, 'spec/worker-scope.json'),
    readFileSync('spec/worker-scope.json'),
  );
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=worker',
      '-c',
      'user.email=worker@example.invalid',
      'commit',
      '-qm',
      'base',
    ],
  ]) {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.166.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_SCOPE_LOG: join(root, 'scopes.jsonl'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report-text'),
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
  };
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\necho "ActiveState=inactive"\necho "ControlGroup="\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  function turn(extra: string[] = []) {
    const brief = join(root, 'brief.md');
    writeFileSync(brief, 'ok');
    const child = spawn(
      process.execPath,
      [
        cli,
        'worker',
        'start',
        '--repo',
        repo,
        '--brief',
        brief,
        '--run',
        run,
        ...extra,
      ],
      { env },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    return new Promise<{ code: number | null; stderr: string }>((done) =>
      child.once('close', (code) => done({ code, stderr })),
    );
  }
  t.after(() => {
    // A successful start leaves a detached driver; stop it before cleanup.
    const stopped = spawnSync(
      process.execPath,
      [cli, 'worker', 'stop', '--repo', repo, '--run', run],
      { env, encoding: 'utf8' },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, turn };
}

test('start checks dependency readiness before state writes or spawn', async (t) => {
  for (const [name, prepare, expected] of [
    ['no node_modules', (_repo: string) => {}, false],
    ['no .bin', (repo: string) => mkdirSync(join(repo, 'node_modules')), false],
    [
      '.bin is file',
      (repo: string) => {
        mkdirSync(join(repo, 'node_modules'));
        writeFileSync(join(repo, 'node_modules/.bin'), 'x');
      },
      false,
    ],
    [
      'node_modules is file (ENOTDIR)',
      (repo: string) => writeFileSync(join(repo, 'node_modules'), 'x'),
      false,
    ],
    [
      'ready directory',
      (repo: string) =>
        mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true }),
      true,
    ],
    [
      'symlinked ready directory',
      (repo: string) => {
        mkdirSync(join(repo, 'deps/.bin'), { recursive: true });
        symlinkSync(join(repo, 'deps'), join(repo, 'node_modules'));
      },
      true,
    ],
    ['no package manifest', (_repo: string) => {}, true],
  ] as [string, (repo: string) => void, boolean][]) {
    await t.test(name, async (t) => {
      const s = await setup(t);
      prepare(s.repo);
      if (name !== 'no package manifest') commitManifest(s.repo);
      const result = await s.turn();
      assert.equal(result.code, expected ? 0 : 64, result.stderr);
      if (!expected) {
        assert.match(
          result.stderr,
          /dependencies missing: run pnpm install --frozen-lockfile in /,
        );
        assert.ok(result.stderr.includes(s.repo));
        assert.equal(existsSync(s.run), false);
        assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
        assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG), false);
      }
    });
  }
  await t.test('forbidden allow is checked first', async (t) => {
    const s = await setup(t);
    commitManifest(s.repo);
    const result = await s.turn(['--allow', '.git/config']);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /names a forbidden path/);
  });
});
