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
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
const requestSchema = z.object({
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

async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')[1]
      ?.startsWith('Z');
  } catch {
    return false;
  }
}
async function setup(t: TestContext, worktree = false) {
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
    CODEX_TEST_WORKER_VERSION: '0.166.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_SCOPE_LOG: join(root, 'scopes.jsonl'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report-text'),
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
  };
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CODEX_TEST_WORKER_SCOPE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('ActiveState=inactive\\nControlGroup=');
`,
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
          .trim()
          .split('\n')
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

test('run directory is strictly below the real repository .krn with no symlink components', {
  concurrency: 6,
}, async (t) => {
  for (const location of [
    'external/.krn/run',
    'main/.krn-other/run',
    'main/.krn',
  ]) {
    t.test(location, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, join(s.root, location)).result;
      assert.equal(result.code, 64, result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
    });
  }
  for (const component of ['.krn', '.krn/runs', '.krn/runs/worker']) {
    t.test(`symlink ${component}`, async (t) => {
      const s = await setup(t);
      const target = join(s.root, 'target');
      mkdirSync(target);
      const path = join(s.repo, component);
      mkdirSync(resolve(path, '..'), { recursive: true });
      symlinkSync(target, path);
      const result = await s.turn('ok', true).result;
      assert.equal(result.code, 65, result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
      rmSync(path);
    });
  }
});

test('thread and turn grant only repository and tmp roots, and tell the worker the lead commits', {
  concurrency: 6,
}, async (t) => {
  for (const worktree of [false, true]) {
    t.test(worktree ? 'linked worktree' : 'repository', async (t) => {
      const s = await setup(t, worktree);
      assert.equal((await s.turn('ok', true).result).code, 0);
      const requests = s.requests();
      const thread = requests.find((row) => row.method === 'thread/start');
      const turn = requests.find((row) => row.method === 'turn/start');
      assert.ok(thread?.params);
      assert.ok(turn?.params);
      assert.deepEqual(
        thread.params.config?.sandbox_workspace_write.writable_roots,
        [s.repo, join(s.run, 'tmp')],
      );
      assert.deepEqual(turn.params.sandboxPolicy?.writableRoots, [
        s.repo,
        join(s.run, 'tmp'),
      ]);
      assert.match(thread.params.developerInstructions ?? '', /never commit/i);
      assert.match(thread.params.developerInstructions ?? '', /lead commits/i);
    });
  }
});

test('Git HEAD, packed refs, refs trees and top-level lock changes fail scope in repositories and worktrees', {
  concurrency: 6,
}, async (t) => {
  for (const worktree of [false, true]) {
    for (const name of [
      'HEAD',
      'packed-refs',
      'refs/heads/forbidden',
      'HEAD.lock',
      'index.lock',
    ]) {
      t.test(`${worktree ? 'worktree' : 'repository'} ${name}`, async (t) => {
        const s = await setup(t, worktree);
        const gitDir = s.git(
          'rev-parse',
          '--path-format=absolute',
          name === 'HEAD' ? '--git-dir' : '--git-common-dir',
        );
        const path = join(gitDir, name);
        const result = await s.turn(`write ${relative(s.repo, path)}`, true)
          .result;
        assert.equal(result.code, 3, result.stderr);
        assert.ok(result.stderr.includes(path), result.stderr);
      });
    }
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      t.test(`${worktree ? 'worktree' : 'repository'} ${flag}`, async (t) => {
        const s = await setup(t, worktree);
        const result = await s.turn(`index-flag ${flag}`, true).result;
        assert.equal(result.code, 3, result.stderr);
        assert.ok(result.stderr.includes('README.md'), result.stderr);
      });
    }
  }
});

test('pre-existing index flags are baseline data and read-only Git checks preserve the index', async (t) => {
  const s = await setup(t);
  s.git('update-index', '--assume-unchanged', 'README.md');
  s.git('update-index', '--skip-worktree', 'spec/worker-scope.json');
  assert.equal((await s.turn('ok', true).result).code, 0);
  assert.equal((await s.turn('ok').result).code, 0);
});

test('untracked baseline compares content, deletions, types and symlink targets through the tiers', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write', 'delete', 'retype', 'relink']) {
    t.test(action, async (t) => {
      const s = await setup(t);
      const path = join(s.repo, 'AGENTS.md');
      if (action === 'relink') symlinkSync('initial-target', path);
      else writeFileSync(path, 'before edit'); // Same size as "worker edit".
      const result = await s.turn(`${action} AGENTS.md`, true).result;
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes('AGENTS.md'), result.stderr);
    });
  }
  t.test('review tier and unchanged symlink', async (t) => {
    const s = await setup(t);
    mkdirSync(join(s.repo, 'docs'));
    writeFileSync(join(s.repo, 'docs/guide.md'), 'before edit');
    symlinkSync('old-target', join(s.repo, 'existing-link'));
    assert.equal((await s.turn('ok', true).result).code, 0);
    const result = await s.turn('write docs/guide.md').result;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.json('rounds/002/result.json').needs_lead_note, [
      'docs/guide.md',
    ]);
  });
});

test('untracked baseline refuses more than 10000 files or 1 GB total before starting the server', {
  concurrency: 6,
}, async (t) => {
  for (const bound of ['files', 'bytes']) {
    t.test(bound, async (t) => {
      const s = await setup(t);
      if (bound === 'files') {
        mkdirSync(join(s.repo, 'generated'));
        for (let i = 0; i <= 10000; i++)
          writeFileSync(join(s.repo, 'generated', `${i}`), 'x');
      } else {
        for (const name of ['large-a', 'large-b']) {
          const path = join(s.repo, name);
          writeFileSync(path, '');
          truncateSync(path, 600 * 1024 * 1024);
        }
      }
      const result = await s.turn('ok', true).result;
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, bound === 'files' ? /10000/ : /1 GB/);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
    });
  }
});

test('missing, mismatched and malformed usage fail closed, interrupt, stop scope and never persist zero metrics', {
  concurrency: 6,
}, async (t) => {
  for (const action of [
    'no-usage',
    'wrong-thread-usage',
    'wrong-turn-usage',
    'bad-usage',
  ]) {
    t.test(action, async (t) => {
      const s = await setup(t);
      // Missing usage on a later turn must not reuse the preceding metrics.
      assert.equal((await s.turn('ok', true).result).code, 0);
      const state = s.json('session.json');
      const result = await s.turn(action).result;
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, /usage/);
      assert.equal(existsSync(join(s.run, 'rounds/002/metrics.json')), false);
      await until(() =>
        s.requests().some((row) => row.method === 'turn/interrupt'),
      );
      await until(() => !alive(state.pid) && !alive(state.serverPid));
      assert.ok(
        s
          .rows(s.env.CODEX_TEST_WORKER_SCOPE_LOG)
          .some((row) => JSON.stringify(row).includes(state.unit)),
      );
      assert.equal((await s.turn('ok').result).code, 5);
    });
  }
  t.test(
    'first turn has no fabricated metrics or summary tokens',
    async (t) => {
      const s = await setup(t);
      const result = await s.turn('no-usage', true).result;
      assert.equal(result.code, 65, result.stderr);
      await until(() => existsSync(join(s.run, 'summary.json')));
      assert.equal(existsSync(join(s.run, 'rounds/001/metrics.json')), false);
      assert.equal('tokens' in s.json('summary.json'), false);
    },
  );
});

test('start and stop reap the recorded server scope and process group after driver SIGKILL', {
  concurrency: 6,
}, async (t) => {
  for (const command of ['start', 'stop']) {
    t.test(command, async (t) => {
      const s = await setup(t);
      const pending = s.turn('hang-orphan', true);
      await until(
        () =>
          pending.finished ||
          s.requests().some((row) => row.method === 'turn/start'),
      );
      assert.ok(
        s.requests().some((row) => row.method === 'turn/start'),
        'server did not start a turn',
      );
      const state = s.json('session.json');
      assert.match(state.unit, /^krn-worker-.+\.scope$/);
      assert.equal(alive(state.serverPid), true);
      process.kill(state.pid, 'SIGKILL');
      assert.equal((await pending.result).code, 75);
      await until(() => !alive(state.pid));
      assert.equal(
        alive(state.serverPid),
        true,
        'fixture must leave a live orphan for the reaper',
      );
      const result =
        command === 'start'
          ? await s.turn('ok', true).result
          : await s.launch(['stop']).result;
      assert.equal(result.code, command === 'start' ? 75 : 0, result.stderr);
      assert.equal(
        alive(state.serverPid),
        false,
        'recorded orphan server remains alive',
      );
      assert.ok(
        s
          .rows(s.env.CODEX_TEST_WORKER_SCOPE_LOG)
          .some(
            (row) =>
              JSON.stringify(row) ===
              JSON.stringify(['--user', 'stop', state.unit]),
          ),
      );
    });
  }
});

const credentials = [
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

test('PEM, AWS and credential assignments are redacted in start and send inboxes and persisted report text', async (t) => {
  const s = await setup(t);
  const release = join(s.root, 'initialize-release');
  s.env.CODEX_TEST_WORKER_INITIALIZE_GATE = release;
  const text = credentials.map(([source]) => source).join('\r\n');
  const inspect = (path: string) => {
    const stored = readFileSync(path, 'utf8');
    for (const [, secret] of credentials)
      assert.equal(stored.includes(secret), false, secret);
    assert.match(stored, /\[redacted\]/);
    assert.equal(stored.includes('synthetic-passwd'), false);
    assert.equal(stored.includes('synthetic-api-key'), false);
    assert.equal(stored.includes('synthetic-password'), false);
  };
  const first = s.turn(text, true);
  try {
    await until(
      () => first.finished || existsSync(join(s.run, 'inbox/001.json')),
    );
    assert.ok(
      existsSync(join(s.run, 'inbox/001.json')),
      'start did not publish an inbox record',
    );
    inspect(join(s.run, 'inbox/001.json'));
  } finally {
    writeFileSync(release, 'release');
    await first.result;
  }
  assert.equal((await first.result).code, 0);
  const state = s.json('session.json');
  process.kill(state.pid, 'SIGSTOP');
  const second = s.turn(text);
  try {
    await until(
      () => second.finished || existsSync(join(s.run, 'inbox/002.json')),
    );
    assert.ok(
      existsSync(join(s.run, 'inbox/002.json')),
      'send did not publish an inbox record',
    );
    inspect(join(s.run, 'inbox/002.json'));
  } finally {
    process.kill(state.pid, 'SIGCONT');
    await second.result;
  }
  assert.equal((await second.result).code, 0);
  writeFileSync(s.env.CODEX_TEST_WORKER_REPORT, text);
  const before = readFileSync(join(s.run, 'session.json'), 'utf8');
  const third = await s.turn('report-secrets', false, s.run, [
    '--model',
    'AUTH=synthetic-model',
    '--effort',
    'TOKEN: synthetic-effort',
  ]).result;
  assert.equal(third.code, 64, third.stderr);
  assert.equal(readFileSync(join(s.run, 'session.json'), 'utf8'), before);
  assert.equal(existsSync(join(s.run, 'inbox/003.json')), false);
  assert.equal(existsSync(join(s.run, 'rounds/003')), false);
  assert.equal((await s.turn('report-secrets').result).code, 0);
  inspect(join(s.run, 'rounds/003/report.json'));
});

test('start refuses an --allow value that names a forbidden path before spawning', {
  concurrency: 6,
}, async (t) => {
  for (const value of [
    '.agents/skills/x/SKILL.md',
    'tasks/a.json',
    '.git/config',
    'docs/program/lead-rules.md',
  ]) {
    t.test(value, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, s.run, ['--allow', value]).result;
      assert.equal(result.code, 64, result.stderr);
      assert.match(result.stderr, /names a forbidden path/);
      assert.ok(result.stderr.includes(value), result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
      assert.equal(existsSync(join(s.run, 'session.json')), false);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG), false);
    });
  }
  // A wildcard allow that overlaps forbidden globs is accepted on purpose:
  // `src/**` and `docs/**` overlap `**/AGENTS.md` and `docs/adr/**`, and the
  // scope check still fails any forbidden change under it (exit 3).
  t.test('wildcard allow still fails a forbidden change', async (t) => {
    const s = await setup(t);
    const result = await s.turn(
      'write .agents/skills/x/SKILL.md',
      true,
      s.run,
      ['--allow', '**'],
    ).result;
    assert.equal(result.code, 3, result.stderr);
    assert.match(
      result.stderr,
      /scope violation: .*\.agents\/skills\/x\/SKILL\.md/,
    );
  });
  for (const value of ['src/**', 'docs/**', 'test/worker/x.test.ts']) {
    t.test(`accepts ${value}`, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, s.run, ['--allow', value]).result;
      assert.equal(result.code, 0, result.stderr);
    });
  }
});

test('worker developer instructions stay within the byte budget', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  const thread = s.requests().find((row) => row.method === 'thread/start');
  const text = thread?.params?.developerInstructions ?? '';
  assert.ok(Buffer.byteLength(text) <= 600);
});
