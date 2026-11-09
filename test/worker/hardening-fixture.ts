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
import { z } from 'zod';
import { systemctlStub } from './systemctl-stub.ts';

export const cli = resolve('src/cli/krn.mjs');
export const fixture = resolve('test/fixtures/worker/app-server.mjs');
export const requestSchema = z.object({
  method: z.string().optional(),
  params: z
    .object({
      developerInstructions: z.string().optional(),
      config: z
        .object({
          sandbox_workspace_write: z.object({
            writable_roots: z.array(z.string()),
          }),
        })
        .optional(),
      sandboxPolicy: z
        .object({ writableRoots: z.array(z.string()) })
        .optional(),
    })
    .optional(),
});
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')[1]
      ?.startsWith('Z');
  } catch {
    return false;
  }
}
export async function setup(t: TestContext, worktree = false) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-hardening-'));
  const main = join(root, 'main');
  const repo = worktree ? join(root, 'repo') : main;
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(join(main, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  writeFileSync(join(main, 'README.md'), 'tracked\n');
  writeFileSync(
    join(main, 'spec/worker-scope.json'),
    existsSync('spec/worker-scope.json')
      ? readFileSync('spec/worker-scope.json')
      : '{}',
  );
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
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
    ...(worktree ? [['worktree', 'add', '-qb', 'worker', repo]] : []),
  ]) {
    const result = spawnSync('git', ['-C', main, ...args], {
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
    CODEX_TEST_WORKER_VERSION: '0.167.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_SCOPE_LOG: join(root, 'scopes.jsonl'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report-text'),
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
  };
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: systemctlStub(join(root, 'scopes.jsonl')),
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  function launch(args: string[], directory = run) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', directory],
      { env },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    let finished = false;
    const result = new Promise<{ code: number | null; stderr: string }>(
      (done) =>
        child.once('close', (code) => {
          finished = true;
          done({ code, stderr });
        }),
    );
    return {
      child,
      result,
      get finished() {
        return finished;
      },
    };
  }
  let messages = 0;
  function turn(
    text: string,
    first = false,
    directory = run,
    extra: string[] = [],
  ) {
    const path = join(root, `message-${++messages}.md`);
    writeFileSync(path, text);
    return launch(
      [
        first ? 'start' : 'send',
        ...(first ? ['--repo', repo, '--brief'] : ['--message']),
        path,
        ...extra,
      ],
      directory,
    );
  }
  function rows(path: string): unknown[] {
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .slice(0, -1)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  const requests = () =>
    z.array(requestSchema).parse(rows(env.CODEX_TEST_WORKER_LOG));
  const json = (path: string) =>
    JSON.parse(readFileSync(join(run, path), 'utf8'));
  t.after(async () => {
    await launch(['stop']).result;
    // Only processes created by this fixture may survive a failed assertion.
    for (const path of ['session.json', 'closed-session.json']) {
      if (!existsSync(join(run, path))) continue;
      const state = json(path);
      for (const pid of [state.pid, state.serverPid]) {
        if (!alive(pid)) continue;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, git, launch, turn, json, rows, requests };
}
export const credentials = [
  [
    '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-body\n-----END PRIVATE KEY-----',
    'synthetic-pem-body',
  ],
  [
    '-----BEGIN RSA PRIVATE KEY-----\r\nsynthetic-rsa-body\r\n-----END RSA PRIVATE KEY-----',
    'synthetic-rsa-body',
  ],
  [`standalone AKIA${'A'.repeat(16)}`, `AKIA${'A'.repeat(16)}`],
  ['AWS_ACCESS_KEY_ID=synthetic-access-key', 'synthetic-access-key'],
  [
    'APP_TOKEN: synthetic-token\r\nDB_PASSWD=synthetic-passwd',
    'synthetic-token',
  ],
  [
    'CLIENT_CREDENTIAL = "synthetic credential with spaces"',
    'synthetic credential with spaces',
  ],
  ['AUTHORIZATION: synthetic-auth', 'synthetic-auth'],
  [
    'API_KEY=synthetic-api-key PASSWORD: synthetic-password SECRET=synthetic-secret',
    'synthetic-secret',
  ],
] as const;
