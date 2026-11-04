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
import { test } from 'node:test';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
async function setup(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(repo, 'spec/worker-scope.json'),
    existsSync('spec/worker-scope.json')
      ? readFileSync('spec/worker-scope.json')
      : '{}',
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
  ])
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\nprintf "ActiveState=inactive\\nControlGroup=\\n"\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.166.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report'),
  };
  async function command(...args: string[]) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', run],
      { env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    const code = await new Promise<number | null>((done) =>
      child.on('close', done),
    );
    return { code, stdout, stderr };
  }
  let message = 0;
  async function turn(text: string, first = false, extra: string[] = []) {
    const file = join(root, `message-${++message}.md`);
    writeFileSync(file, text);
    return command(
      first ? 'start' : 'send',
      ...(first ? ['--repo', repo, '--brief'] : ['--message']),
      file,
      ...extra,
    );
  }
  const json = (path: string) =>
    JSON.parse(readFileSync(join(run, path), 'utf8'));
  const requests = () =>
    readFileSync(env.CODEX_TEST_WORKER_LOG ?? '', 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
  t.after(async () => {
    await command('stop');
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, command, turn, json, requests };
}

const base = {
  status: 'partial',
  summary: 'stopped',
  changed_paths: [] as string[],
  checks: [],
  findings: [],
  unverified: [],
  blockers: [] as string[],
};
const flag = /blocker not technical: send a continuation/;

test('a partial or blocked report with no changes and no technical blocker is flagged on start and send', async (t) => {
  for (const [name, report, flagged] of [
    ['vague partial', { blockers: ['no time left'] }, true],
    ['empty blocked', { status: 'blocked' }, true],
    ['exit without command', { blockers: ['exit 1'] }, true],
    ['command exit', { blockers: ['npm test exit 1'] }, false],
    [
      'exited with exit code',
      {
        status: 'blocked',
        blockers: ['node --test x.ts exited with exit code 2'],
      },
      false,
    ],
    ['timeout', { blockers: ['tsc timed out after 600 s'] }, false],
    ['bare timeout', { blockers: ['timed out'] }, false],
    ['exit status', { blockers: ['biome check: Exit Status 1'] }, false],
    [
      'changed paths',
      { changed_paths: ['src/a.ts'], blockers: ['no time left'] },
      false,
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const s = await setup(t);
      writeFileSync(
        join(s.root, 'report'),
        JSON.stringify({ ...base, ...report }),
      );
      for (const [first, round] of [
        [true, '001'],
        [false, '002'],
      ] as const) {
        const result = await s.turn('custom-report', first);
        assert.equal(result.code, 4, result.stderr);
        const recorded = s.json(`rounds/${round}/result.json`);
        assert.equal(recorded.nontechnical_blocker, flagged, round);
        if (flagged) {
          assert.match(result.stderr, flag);
          assert.match(recorded.message, flag);
        } else {
          assert.doesNotMatch(result.stderr, flag);
          assert.doesNotMatch(recorded.message, flag);
        }
      }
    });
  }
});

test('a clean done report records no non-technical blocker', async (t) => {
  const s = await setup(t);
  const result = await s.turn('done-clean', true);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, flag);
  assert.equal(s.json('rounds/001/result.json').nontechnical_blocker, false);
});
