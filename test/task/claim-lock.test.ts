import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectClaim, serializeClaim } from '../../src/task/claims.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));
const taskCliRunner = `
const { taskCommand } = await import(process.env.KRN_TEST_TASK_CLI_MODULE);
try {
  taskCommand(process.argv.slice(1));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message + '\\n' : String(error) + '\\n');
  process.exitCode = error !== null && typeof error === 'object' && 'exitCode' in error
    ? error.exitCode
    : 64;
}
`;
const scratch = join(
  process.cwd(),
  '../../runs/claude-claim-lock-tests/scratch',
);

const lockHook = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

Date.now = () => 1000;

const openSync = fs.openSync.bind(fs);
const writeSync = fs.writeSync.bind(fs);
const closeSync = fs.closeSync.bind(fs);
const unlinkSync = fs.unlinkSync.bind(fs);
const spawnSync = childProcess.spawnSync.bind(childProcess);

childProcess.spawnSync = function (command, args = [], options = {}) {
  if (command !== 'git') return spawnSync(command, args, options);
  const gitArgs = args.map(String);
  const directoryIndex = gitArgs.indexOf('-C');
  const directory = directoryIndex < 0
    ? process.cwd()
    : gitArgs[directoryIndex + 1];
  const root = process.env.KRN_TEST_ROOT;
  const linked = process.env.KRN_TEST_LINKED;
  const rootBranch = process.env.KRN_TEST_ROOT_BRANCH;
  const linkedBranch = process.env.KRN_TEST_LINKED_BRANCH;
  let status = 0;
  let output = '';

  if (gitArgs.includes('--show-toplevel')) output = directory + '\\n';
  else if (gitArgs.includes('--git-common-dir')) output = root + '/.git\\n';
  else if (gitArgs.includes('--short') && gitArgs.includes('symbolic-ref')) {
    output = (directory === root ? rootBranch : linkedBranch) + '\\n';
  } else if (gitArgs.includes('--porcelain') && gitArgs.includes('list')) {
    output = 'worktree ' + root + '\\0worktree ' + linked + '\\0';
  } else if (gitArgs.includes('--verify') && gitArgs.includes('show-ref')) {
    const branch = gitArgs.at(-1)?.replace('refs/heads/', '');
    if (branch !== rootBranch && branch !== linkedBranch) status = 1;
  } else if (gitArgs.includes('--verify') && gitArgs.includes('rev-parse')) {
    output = 'fixture-origin-main\\n';
  } else if (
    gitArgs.includes('show') &&
    gitArgs.includes('origin/main:tasks/' + process.env.KRN_TEST_TASK_ID + '.json')
  ) {
    output = process.env.KRN_TEST_ORIGIN_TASK;
  } else {
    throw new Error('unexpected test git probe: ' + gitArgs.join(' '));
  }

  const stdout = options.encoding === 'utf8' ? output : Buffer.from(output);
  const stderr = options.encoding === 'utf8' ? '' : Buffer.alloc(0);
  return {
    pid: process.pid,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
    error: undefined,
  };
};

function recordLockRelease(claim) {
  const trace = process.env.KRN_TEST_LOCK_TRACE;
  if (trace === undefined) return;
  const entry = JSON.stringify({
    actor: process.env.KRN_TEST_LOCK_ACTOR,
    action: process.env.KRN_TEST_LOCK_ACTION,
    claim,
  }) + '\\n';
  const descriptor = openSync(trace, 'a', 0o600);
  try {
    writeSync(descriptor, entry);
  } finally {
    closeSync(descriptor);
  }
}

fs.unlinkSync = function (path, ...args) {
  if (typeof path !== 'string' || !path.endsWith('.lock'))
    return unlinkSync(path, ...args);
  let claim = null;
  try {
    claim = JSON.parse(fs.readFileSync(process.env.KRN_TEST_CLAIM_PATH, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  recordLockRelease(claim);
  return unlinkSync(path, ...args);
};

syncBuiltinESMExports();
`;

const fastLockClockHook = `
let current = 0;
Date.now = () => (current += 1000);
`;

interface LockRelease {
  actor: string;
  action: 'claim' | 'takeover' | 'release';
  claim: { actor: string } | null;
}

test('expired claims have one concurrent claim --next winner across two worktrees', {
  timeout: 120_000,
}, async () => {
  const repo = await fixtureRepo('claim-lock-race-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-lock-race-linked');
  try {
    addWorktree(repo, linked, 'claim-lock-race-linked-branch');
    const claimPath = join(repo, '.krn', 'task-claims', 'T-1.json');

    for (let trial = 0; trial < 1; trial += 1) {
      mkdirSync(dirname(claimPath), { recursive: true });
      writeFileSync(
        claimPath,
        serializeClaim({
          id: 'T-1',
          actor: `stale-${trial}`,
          worktree: join(dirname(repo), `missing-worktree-${trial}`),
          branch: `missing-branch-${trial}`,
          claimed: '2026-10-26T00:00:00.000Z',
          reason: null,
        }),
      );

      const contenders = Array.from({ length: 12 }, (_, index) => {
        const actor = `worker-${trial}-${index}`;
        const worktree = index % 2 === 0 ? repo : linked;
        return {
          actor,
          worktree,
          result: runCliAsync(worktree, ['claim', '--next', '--actor', actor]),
        };
      });
      const results = await Promise.all(
        contenders.map(async ({ actor, worktree, result }) => ({
          actor,
          worktree,
          ...(await result),
        })),
      );
      const winners = results.filter((result) => result.status === 0);
      assert.equal(
        winners.length,
        1,
        `trial ${trial}: ${results.map((result) => `${result.actor}=${result.status}`).join(', ')}`,
      );
      assert.equal(results.filter((result) => result.status === 75).length, 11);

      const winner = winners[0];
      assert.ok(winner);
      assert.equal(winner.stdout.trim(), 'T-1');
      const saved = JSON.parse(readFileSync(claimPath, 'utf8')) as {
        actor: string;
        id: string;
        worktree: string;
      };
      assert.equal(saved.id, 'T-1');
      assert.equal(saved.actor, winner.actor);
      assert.equal(saved.worktree, realpathSync(winner.worktree));
    }
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('takeover, release, and plain claim stay serialized across two worktrees', {
  timeout: 120_000,
}, async () => {
  const taskIds = Array.from({ length: 10 }, (_, index) => `T-${index + 1}`);
  const repo = await fixtureRepo('claim-lock-mutations-', taskIds.map(task));
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  const compiled = await compileTaskCli();
  const hookPath = join(repo, '.krn', 'tmp', 'lock-observer.mjs');
  try {
    addWorktree(repo, linked, 'claim-lock-mutations-linked-branch');
    await mkdir(join(repo, '.krn', 'tmp'), { recursive: true });
    await writeFile(hookPath, lockHook);
    for (let trial = 0; trial < taskIds.length; trial += 1) {
      const id = taskIds[trial];
      assert.ok(id);
      const claimPath = join(repo, '.krn', 'task-claims', `${id}.json`);
      mkdirSync(dirname(claimPath), { recursive: true });
      writeFileSync(
        claimPath,
        serializeClaim({
          id,
          actor: `seed-${trial}`,
          worktree: realpathSync(repo),
          branch: 'main',
          claimed: '2026-10-26T00:00:00.000Z',
          reason: null,
        }),
      );
    }
    const firstTask = taskIds[0];
    assert.ok(firstTask);
    assert.equal(inspectClaim(repo, firstTask).state, 'live');
    await Promise.all(
      Array.from({ length: 10 }, (_, trial) =>
        runMutationTrial({
          trial,
          id: taskIds[trial] ?? '',
          repo,
          linked,
          hookPath,
          taskCliModule: compiled.module,
        }),
      ),
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
    await rm(compiled.directory, { recursive: true, force: true });
  }
});

async function runMutationTrial({
  trial,
  id,
  repo,
  linked,
  hookPath,
  taskCliModule,
}: {
  trial: number;
  id: string;
  repo: string;
  linked: string;
  hookPath: string;
  taskCliModule: string;
}): Promise<void> {
  const claimPath = join(repo, '.krn', 'task-claims', `${id}.json`);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', `${id}.lock`);
  const tracePath = join(repo, '.krn', 'tmp', `lock-order-${id}.jsonl`);
  const linkedBranch = 'claim-lock-mutations-linked-branch';
  const contenders = Array.from({ length: 18 }, (_, index) => {
    const operation: LockRelease['action'] =
      index < 6 ? 'takeover' : index < 12 ? 'release' : 'claim';
    const actor = `${operation}-${trial}-${index}`;
    const worktree = index % 2 === 0 ? repo : linked;
    const args =
      operation === 'release'
        ? ['release', id]
        : [
            'claim',
            id,
            ...(operation === 'takeover'
              ? ['--takeover', '--reason', 'r']
              : []),
            '--actor',
            actor,
          ];
    return {
      actor,
      action: operation,
      worktree,
      result: runTaskCliAsync(
        worktree,
        args,
        lockObserverEnv(
          hookPath,
          tracePath,
          claimPath,
          repo,
          linked,
          linkedBranch,
          taskCliModule,
          id,
          actor,
          operation,
        ),
      ),
    };
  });
  const results = await Promise.all(
    contenders.map(async ({ actor, action, worktree, result }) => ({
      actor,
      action,
      worktree,
      ...(await result),
    })),
  );

  const releases = readLockReleases(tracePath);
  const resultsByActor = new Map(
    results.map((result) => [result.actor, result]),
  );
  const releaseActors = new Set(releases.map(({ actor }) => actor));
  assert.equal(
    releaseActors.size,
    releases.length,
    `trial ${trial}: duplicate lock release records`,
  );
  for (const release of releases) {
    const result = resultsByActor.get(release.actor);
    assert.ok(result, `trial ${trial}: unknown process ${release.actor}`);
    if (result.status === 0 && result.action !== 'release') {
      assert.equal(
        release.claim?.actor,
        release.actor,
        `trial ${trial}: ${release.actor} succeeded without holding its claim at lock release`,
      );
    }
  }
  for (const result of results) {
    if (result.status === 0)
      assert.ok(
        releaseActors.has(result.actor),
        `trial ${trial}: ${result.actor} succeeded without a lock-order record`,
      );
  }

  const lastSuccessfulWriter = releases
    .filter(({ actor }) => resultsByActor.get(actor)?.status === 0)
    .at(-1);
  assert.ok(
    lastSuccessfulWriter,
    `trial ${trial}: no successful writer; ${results.map(({ actor, status, stderr }) => `${actor}=${status}: ${stderr.trim()}`).join(' | ')}`,
  );
  const claimDirectory = join(repo, '.krn', 'task-claims');
  const claimFiles = existsSync(claimDirectory)
    ? readdirSync(claimDirectory).filter((name) => name.endsWith('.json'))
    : [];
  assert.ok(
    claimFiles.length <= 10,
    `trial ${trial}: found ${claimFiles.length} claim files`,
  );
  assert.ok(
    claimFiles.every((name) => name.startsWith('T-') && name.endsWith('.json')),
  );
  assert.equal(
    existsSync(lockPath),
    false,
    `trial ${trial}: lock file remains`,
  );

  if (lastSuccessfulWriter.action === 'release') {
    assert.equal(
      existsSync(claimPath),
      false,
      `trial ${trial}: release was the last successful writer`,
    );
  } else {
    assert.equal(
      existsSync(claimPath),
      true,
      `trial ${trial}: claim was the last successful writer`,
    );
    const saved = JSON.parse(readFileSync(claimPath, 'utf8')) as {
      actor: string;
      worktree: string;
    };
    assert.equal(saved.actor, lastSuccessfulWriter.actor);
    const winner = resultsByActor.get(saved.actor);
    assert.equal(winner?.status, 0);
    assert.notEqual(winner?.action, 'release');
    assert.equal(saved.worktree, realpathSync(winner?.worktree ?? repo));
  }
}

test('release racing a claim on an expired claim never creates two claim winners', {
  timeout: 120_000,
}, async () => {
  const compiled = await compileTaskCli();
  const taskIds = Array.from({ length: 10 }, (_, index) => `T-${index + 1}`);
  const repo = await fixtureRepo(
    'claim-lock-expired-release-',
    taskIds.map(task),
  );
  const linked = join(dirname(repo), 'claim-lock-expired-release-linked');
  const hookPath = join(repo, '.krn', 'tmp', 'lock-observer.mjs');
  try {
    addWorktree(repo, linked, 'claim-lock-expired-release-linked-branch');
    await mkdir(join(repo, '.krn', 'tmp'), { recursive: true });
    await writeFile(hookPath, lockHook);
    await Promise.all(
      taskIds.map((id, trial) =>
        runExpiredReleaseTrial({
          hookPath,
          linked,
          repo,
          taskCliModule: compiled.module,
          trial,
          id,
        }),
      ),
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
    await rm(compiled.directory, { recursive: true, force: true });
  }
});

async function runExpiredReleaseTrial({
  hookPath,
  linked,
  repo,
  taskCliModule,
  trial,
  id,
}: {
  hookPath: string;
  linked: string;
  repo: string;
  taskCliModule: string;
  trial: number;
  id: string;
}): Promise<void> {
  const claimPath = join(repo, '.krn', 'task-claims', `${id}.json`);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', `${id}.lock`);
  const tracePath = join(repo, '.krn', 'tmp', `lock-order-${id}.jsonl`);
  mkdirSync(dirname(claimPath), { recursive: true });
  writeFileSync(
    claimPath,
    serializeClaim({
      id,
      actor: `stale-${trial}`,
      worktree: join(dirname(repo), `missing-worktree-${trial}`),
      branch: `missing-branch-${trial}`,
      claimed: '2026-10-26T00:00:00.000Z',
      reason: null,
    }),
  );

  const actor = `claim-${trial}`;
  const contenders = [
    {
      actor: `release-${trial}`,
      action: 'release' as const,
      worktree: repo,
      args: ['release', id],
    },
    {
      actor,
      action: 'claim' as const,
      worktree: linked,
      args: ['claim', id, '--actor', actor],
    },
  ];
  const results = await Promise.all(
    contenders.map(async ({ actor: processActor, action, worktree, args }) => ({
      actor: processActor,
      action,
      ...(await runTaskCliAsync(
        worktree,
        args,
        lockObserverEnv(
          hookPath,
          tracePath,
          claimPath,
          repo,
          linked,
          'claim-lock-expired-release-linked-branch',
          taskCliModule,
          id,
          processActor,
          action,
        ),
      )),
    })),
  );
  const claimWinners = results.filter(
    ({ action, status }) => action === 'claim' && status === 0,
  );
  assert.ok(claimWinners.length <= 1, `trial ${trial}: multiple claim winners`);

  const releases = readLockReleases(tracePath);
  assert.equal(releases.length, contenders.length);
  const resultsByActor = new Map(
    results.map((result) => [result.actor, result]),
  );
  for (const release of releases) {
    const result = resultsByActor.get(release.actor);
    assert.ok(result, `trial ${trial}: unknown process ${release.actor}`);
    if (result.action === 'claim' && result.status === 0)
      assert.equal(release.claim?.actor, release.actor);
  }

  const lastSuccessfulWriter = releases
    .filter(
      ({ actor: processActor }) =>
        resultsByActor.get(processActor)?.status === 0,
    )
    .at(-1);
  assert.ok(lastSuccessfulWriter, `trial ${trial}: no successful writer`);
  if (lastSuccessfulWriter.action === 'release') {
    assert.equal(existsSync(claimPath), false);
  } else {
    const saved = JSON.parse(readFileSync(claimPath, 'utf8')) as {
      actor: string;
    };
    assert.equal(saved.actor, lastSuccessfulWriter.actor);
  }
  assert.equal(
    existsSync(lockPath),
    false,
    `trial ${trial}: lock file remains`,
  );
  await rm(tracePath, { force: true });
  await rm(claimPath, { force: true });
}

test('claiming recovers a stale per-task lock with a dead local pid', async () => {
  const repo = await fixtureRepo('claim-lock-stale-', [task('T-1')]);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', 'T-1.lock');
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: deadPid(),
        hostname: hostname(),
        acquired: '2026-10-26T00:00:00.000Z',
      })}\n`,
    );

    const claimed = runCli(repo, ['claim', '--next', '--actor', 'recovered']);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(claimed.stdout.trim(), 'T-1');
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claiming reports busy when another live local pid holds the lock', async () => {
  const repo = await fixtureRepo('claim-lock-live-', [task('T-1')]);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', 'T-1.lock');
  const clockHookPath = join(repo, '.krn', 'tmp', 'fast-lock-clock.mjs');
  const heldLock = `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    acquired: '2026-10-26T00:00:00.000Z',
  })}\n`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, heldLock);
    await writeFile(clockHookPath, fastLockClockHook);

    const claimed = runCli(repo, ['claim', '--next', '--actor', 'blocked'], {
      ...process.env,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import=${pathToFileURL(clockHookPath).href}`,
      ]
        .filter(Boolean)
        .join(' '),
    });
    assert.equal(claimed.status, 75, claimed.stderr);
    assert.match(claimed.stderr, /claim is busy/u);
    assert.equal(readFileSync(lockPath, 'utf8'), heldLock);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliResult {
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runCliAsync(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

function runTaskCliAsync(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', taskCliRunner, ...args],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

function lockObserverEnv(
  hookPath: string,
  tracePath: string,
  claimPath: string,
  root: string,
  linked: string,
  linkedBranch: string,
  taskCliModule: string,
  taskId: string,
  actor: string,
  action: LockRelease['action'],
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KRN_TEST_ROOT: root,
    KRN_TEST_LINKED: linked,
    KRN_TEST_ROOT_BRANCH: 'main',
    KRN_TEST_LINKED_BRANCH: linkedBranch,
    KRN_TEST_TASK_ID: taskId,
    KRN_TEST_ORIGIN_TASK: serializeTask(task(taskId)),
    KRN_TEST_TASK_CLI_MODULE: taskCliModule,
    KRN_TEST_LOCK_TRACE: tracePath,
    KRN_TEST_CLAIM_PATH: claimPath,
    KRN_TEST_LOCK_ACTOR: actor,
    KRN_TEST_LOCK_ACTION: action,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(hookPath).href}`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function readLockReleases(path: string): LockRelease[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LockRelease);
}

async function fixtureRepo(
  prefix: string,
  records: TaskRecord[],
): Promise<string> {
  const repo = await tempRepo(prefix);
  await mkdir(join(repo, 'tasks'), { recursive: true });
  for (const record of records)
    await writeFile(
      join(repo, 'tasks', `${record.id}.json`),
      serializeTask(record),
    );
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add task fixtures');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

async function compileTaskCli(): Promise<{
  module: string;
  directory: string;
}> {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'task-cli-'));
  const taskDirectory = join(directory, 'src', 'task');
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  for (const name of ['cli', 'claims', 'record', 'store', 'staged-write']) {
    const sourcePath = fileURLToPath(
      new URL(`../../src/task/${name}.ts`, import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');
    const javascript = stripTypeScriptTypes(source, { mode: 'strip' }).replace(
      /(['"])(\.{1,2}\/[^'"]+)\.ts\1/gu,
      '$1$2.js$1',
    );
    await writeFile(join(taskDirectory, `${name}.js`), javascript);
  }
  return {
    module: pathToFileURL(join(taskDirectory, 'cli.js')).href,
    directory,
  };
}

async function tempRepo(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const repo = await mkdtemp(join(scratch, prefix));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'KRN task claim lock test');
  git(repo, 'config', 'user.email', 'krn-task-claim-lock-test@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Task fixture\n');
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', 'README.md', '.gitignore');
  git(repo, 'commit', '-qm', 'initialize task fixture');
  return repo;
}

function task(id: string): TaskRecord {
  return {
    id,
    status: 'open',
    resolution: null,
    created: '2026-10-26',
    priority: 2,
    title: `Task ${id}`,
    after: [],
    body: [],
  };
}

function addWorktree(root: string, path: string, branch: string): void {
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path, 'HEAD');
}

function removeWorktree(root: string, path: string): void {
  if (!existsSync(path)) return;
  spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', path], {
    encoding: 'utf8',
  });
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function deadPid(): number {
  const pid = 2_147_483_647;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
      return pid;
    throw error;
  }
  throw new Error('expected test pid to be absent');
}
