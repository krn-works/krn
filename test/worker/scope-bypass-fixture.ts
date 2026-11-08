import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

export const cli = resolve('src/cli/krn.mjs');
export const fixture = resolve('test/fixtures/worker/app-server.mjs');
export async function setup(t: TestContext, worktree = false) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-scope-'));
  const main = join(root, 'main');
  const repo = worktree ? join(root, 'repo') : main;
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(join(main, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n.krn/\n');
  writeFileSync(
    join(main, 'spec/worker-scope.json'),
    existsSync('spec/worker-scope.json')
      ? readFileSync('spec/worker-scope.json')
      : '{}',
  );
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', main, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=worker',
    '-c',
    'user.email=worker@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  if (worktree) git('worktree', 'add', '-qb', 'worker', repo);
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\nprintf "ActiveState=inactive\\nControlGroup=\\n"\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.167.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
  };
  function launch(...args: string[]) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', run],
      { env },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const result = new Promise<{ code: number | null; stderr: string }>(
      (done) => child.on('close', (code) => done({ code, stderr })),
    );
    return { child, result };
  }
  let round = 0;
  function turn(text: string) {
    const path = join(root, `message-${++round}.md`);
    writeFileSync(path, text);
    return launch(
      round === 1 ? 'start' : 'send',
      ...(round === 1 ? ['--repo', repo, '--brief'] : ['--message']),
      path,
      '--allow',
      '**',
    );
  }
  t.after(async () => {
    await launch('stop').result;
    rmSync(root, { recursive: true, force: true });
  });
  const dirs = spawnSync(
    'git',
    [
      '-C',
      repo,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(dirs.status, 0, dirs.stderr);
  const [gitDir = '', commonDir = ''] = dirs.stdout.trim().split('\n');
  return { root, repo, run, env, turn, launch, gitDir, commonDir };
}
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
