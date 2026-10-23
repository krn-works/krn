import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexHost } from '../src/hosts/codex.ts';
import * as relay from '../src/relay/index.ts';
import * as trace from '../src/trace/index.ts';
import { requiresIsolation } from './helpers/isolation.ts';
import {
  SPAWNED_PROCESS_WAIT_MS,
  testTimeoutFor,
} from './support/process-wait.ts';

async function repoFixture(
  ignore = '.krn/\n',
  parent = tmpdir(),
): Promise<string> {
  const root = await mkdtemp(join(parent, 'krn-s4b-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '--initial-branch=main']);
  await writeFile(join(root, '.gitignore'), ignore);
  await writeFile(join(root, 'README.md'), 'fixture\n');
  git(['add', '.gitignore', 'README.md']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  return root;
}

async function fakePaperclip(issue: string, responseDelayMs = 0) {
  let delayedBootstrapIssueReads = responseDelayMs > 0 ? 2 : 0;
  const server = createServer((request, response) => {
    const delayResponse =
      request.method === 'GET' &&
      request.url === `/api/issues/${issue}` &&
      delayedBootstrapIssueReads > 0;
    if (delayResponse) delayedBootstrapIssueReads -= 1;
    const respond = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: issue,
          title: 'Fixture issue',
          description: [
            '```krn-contract',
            JSON.stringify({
              version: 1,
              targetRepo: 'fixture/repo',
              checks: ['gate'],
            }),
            '```',
          ].join('\n'),
          updatedAt: '2026-10-08T10:00:00.000Z',
          status: 'in_progress',
          assigneeAgentId: 'fixture-agent',
        }),
      );
    };
    if (delayResponse) setTimeout(respond, responseDelayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    resetBootstrapIssueReadPair: () => {
      delayedBootstrapIssueReads = responseDelayMs > 0 ? 2 : 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function fakeCodex(root: string, body: string): Promise<string> {
  const path = join(root, 'fake-codex');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('start stores jobs inside the repo without creating a sibling folder', async () => {
  const root = await repoFixture('.krn/\n');
  const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
  const run = (repo: string, id: string) =>
    spawnSync(
      process.execPath,
      [cli, 'start', '--job', id, '--issue', 'I-S4c'],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );
  const jobId = 'S4c-inside';
  const sibling = join(root, '..', `${root.split('/').at(-1)}-jobs`, jobId);
  try {
    const result = run(root, jobId);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      JSON.parse(result.stdout).worktree,
      join(root, '.krn', 'worktrees', jobId),
    );
    assert.equal(existsSync(sibling), false);
  } finally {
    spawnSync('git', [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      join(root, '.krn', 'worktrees', jobId),
    ]);
    await rm(join(root, '.krn'), { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('start accepts ignored .krn contents with a runs gitignore exception', async () => {
  const root = await repoFixture('/.krn/*/*\n!/.krn/runs/.gitignore\n');
  const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
  const jobId = 'S4d-contents-ignored';
  await mkdir(join(root, '.krn', 'runs'), { recursive: true });
  await writeFile(join(root, '.krn', 'runs', '.gitignore'), '');
  const addException = spawnSync('git', [
    '-C',
    root,
    'add',
    '.krn/runs/.gitignore',
  ]);
  assert.equal(addException.status, 0, addException.stderr.toString());
  try {
    assert.notEqual(
      spawnSync('git', ['-C', root, 'check-ignore', '-q', '.krn/']).status,
      0,
    );
    assert.equal(
      spawnSync('git', [
        '-C',
        root,
        'check-ignore',
        '-q',
        `.krn/worktrees/${jobId}`,
      ]).status,
      0,
    );
    const result = spawnSync(
      process.execPath,
      [cli, 'start', '--job', jobId, '--issue', 'I-S4d'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      JSON.parse(result.stdout).worktree,
      join(root, '.krn', 'worktrees', jobId),
    );
  } finally {
    spawnSync('git', [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      join(root, '.krn', 'worktrees', jobId),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test('start refuses when the target repo does not ignore .krn', async () => {
  const root = await repoFixture('');
  const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
  try {
    const result = spawnSync(
      process.execPath,
      [cli, 'start', '--job', 'S4c-refused', '--issue', 'I-S4c'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\.krn.*ignored|ignore.*\.krn/i);
    assert.equal(existsSync(join(root, '.krn', 'worktrees')), false);
    assert.equal(
      existsSync(join(root, '..', `${root.split('/').at(-1)}-jobs`)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('start refuses a worktrees symlink that escapes the target repo', async () => {
  const root = await repoFixture('.krn/\n');
  const external = await mkdtemp(join(tmpdir(), 'krn-s4c-external-'));
  const id = 'S4c-symlink';
  const externalWorktree = join(external, id);
  const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
  await mkdir(join(root, '.krn'), { recursive: true });
  await symlink(external, join(root, '.krn', 'worktrees'), 'dir');
  try {
    const result = spawnSync(
      process.execPath,
      [cli, 'start', '--job', id, '--issue', 'I-S4c'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /escape|inside|within/i);
    assert.equal(existsSync(externalWorktree), false);
    assert.doesNotMatch(
      spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      }).stdout,
      new RegExp(externalWorktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    spawnSync('git', [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      externalWorktree,
    ]);
    await rm(externalWorktree, { recursive: true, force: true });
    await unlink(join(root, '.krn', 'worktrees'));
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('B1 foreman waits for a checkpointing tool session to die before retrying', {
  timeout: testTimeoutFor(2),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'B1 foreman waits for a checkpointing tool session to die before retrying',
      ['bwrap'],
    )
  )
    return;
  const previousIsolation = process.env.KRN_ISOLATION;
  const root = await repoFixture();
  const outside = await mkdtemp(join(tmpdir(), 'krn-s4b-shell-'));
  const pidFile = join(outside, 'session-pid');
  const escapedPidFile = join(outside, 'escaped-pid');
  const escapedSource = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const ids=readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(.+)$/m)[1].trim().split(/\\s+/);",
    `writeFileSync(${JSON.stringify(escapedPidFile)}, ids[0]);`,
    'setInterval(()=>{},1000);',
  ].join('');
  const job = { id: 'B1', issue: 'I-1', worktree: root };
  const executable = await fakeCodex(
    outside,
    `
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const escaped = spawn('setsid', [process.execPath, '-e', ${JSON.stringify(escapedSource)}], {stdio:'ignore'});
const countFile = ${JSON.stringify(join(outside, 'count'))};
const allPidsFile = ${JSON.stringify(join(outside, 'all-pids'))};
let count = 0; try { count = Number((await import('node:fs')).readFileSync(countFile, 'utf8')); } catch {}
count++; writeFileSync(countFile, String(count));
await new Promise(resolve => escaped.once('spawn', resolve));
let escapedHostPid; const escapedPidDeadline=Date.now()+${SPAWNED_PROCESS_WAIT_MS}; while(Date.now()<escapedPidDeadline&&!escapedHostPid){try{escapedHostPid=Number(readFileSync(${JSON.stringify(escapedPidFile)},'utf8'))}catch{} if(!escapedHostPid) await new Promise(r=>setTimeout(r,10))}
const hostPid=Number(readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(\\d+)/m)[1]);
appendFileSync(allPidsFile, hostPid+'\\n'+escapedHostPid+'\\n');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t'+count})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4,total_tokens:16}})+'\\n');
if (count === 1) {
  writeFileSync(${JSON.stringify(join(root, 'worker-change.txt'))}, 'step A\\n');
  writeFileSync(${JSON.stringify(pidFile)}, hostPid+'\\n'+escapedHostPid);
  let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
  const match = /--session'?\\s+'?([0-9a-f-]+)/.exec(prompt); const sid=match[1];
  const args = [${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).pathname)}, 'checkpoint','--job','B1','--issue','I-1','--worktree',${JSON.stringify(root)},'--intent','intent:0','--session',sid,'--message','feat: step A','--next','step B'];
  const shell = spawn('setsid', ['bash','-c', "node " + args.map((x)=>JSON.stringify(x)).join(' ')], {stdio:'ignore'});
  await new Promise(r=>setTimeout(r, 120000));
} else {
  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
  process.exit(0);
}
`,
  );
  const host = new CodexHost({ executable });
  const realRelay = {
    ...relay,
    project: () => 'checkpoint test',
  };
  const { runJob } = await import('../src/foreman/run.ts');
  const cancelled: string[] = [];
  const started: string[] = [];
  try {
    process.env.KRN_ISOLATION = 'pid_namespace';
    // The fake runs the real CLI inside a distinct shell process group.
    const startedAt = Date.now();
    const outcome = await runJob(job, {
      budget: { maxResets: 1, maxRepairs: 0, session: { timeoutMs: 20_000 } },
      ledger: {
        readContract: async () => ({
          issueId: 'blockers',
          identifier: 'blockers',
          title: 'blockers fixture',
          description: 'blockers fixture',
          revision: 'r1',
          targetRepo: 'fixture/repo',
          checks: [],
        }),
        submitForReview: async () => 'submitted',
      },
      relay: realRelay,
      trace,
      hosts: {
        codex: {
          start: async (input) => {
            if (started.length) {
              const firstPids = (await readFile(pidFile, 'utf8'))
                .trim()
                .split('\n')
                .map(Number);
              const escapedPid = firstPids[1];
              if (escapedPid !== undefined && (await isAlive(escapedPid)))
                await writeFile(
                  join(outside, 'escaped-alive-before-second'),
                  'alive',
                );
              assert.ok(
                cancelled.includes(started[0] ?? ''),
                'session 1 must be cancelled before session 2 starts',
              );
            }
            const session = await host.start(input);
            started.push(session.id);
            return session;
          },
        },
        cancelTree: async (id) => {
          cancelled.push(id);
          await host.cancelTree(id);
        },
      },
      stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
    });
    assert.ok(
      Date.now() - startedAt < 15_000,
      'foreman cancellation must beat the host timeout',
    );
    assert.deepEqual(outcome.kind, 'stop');
    const lines = (
      await readFile(join(root, '.krn/runs/foreman/B1/trace.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const ends = lines.filter((event) => event.kind === 'session_ended');
    assert.equal(
      lines.filter((event) => event.kind === 'checkpoint').length,
      1,
    );
    assert.equal(cancelled.includes(started[0] ?? ''), true);
    assert.equal(ends.length, 2);
    assert.equal(ends[0].data.end.usage.totalTokens, 16);
    assert.equal(
      lines.filter((event) => event.kind === 'session_started').length,
      2,
    );
    assert.equal(
      lines.find((event) => event.kind === 'session_started')?.data.isolation,
      'pid_namespace',
    );
    const pids = (await readFile(join(outside, 'all-pids'), 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    for (const pid of pids) assert.equal(await isAlive(pid), false);
    assert.equal(
      existsSync(join(outside, 'escaped-alive-before-second')),
      false,
    );
  } finally {
    try {
      for (const pid of (await readFile(join(outside, 'all-pids'), 'utf8'))
        .trim()
        .split('\n')
        .map(Number))
        process.kill(pid, 'SIGKILL');
    } catch {}
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    if (previousIsolation === undefined) delete process.env.KRN_ISOLATION;
    else process.env.KRN_ISOLATION = previousIsolation;
  }
});

test('B2 a foreman SIGTERM cancels every detached session group and exits 130', {
  timeout: testTimeoutFor(12),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'B2 a foreman SIGTERM cancels every detached session group and exits 130',
      ['systemdUserScope'],
    )
  )
    return;
  const root = await repoFixture();
  const paperclip = await fakePaperclip('I-2', 3200);
  const pidFile = join(root, 'pids');
  const childPidFile = join(root, 'child-pid');
  const escapedPidFile = join(root, 'escaped-pid');
  const workerSource = (path: string) =>
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const ids=readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(.+)$/m)[1].trim().split(/\\s+/);",
      `writeFileSync(${JSON.stringify(path)}, ids[0]);`,
      'setInterval(()=>{},1000);',
    ].join('');
  const executable = await fakeCodex(
    root,
    `
import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify(workerSource(childPidFile))}],{stdio:'ignore'});
const escaped=spawn('setsid',[process.execPath,'-e',${JSON.stringify(workerSource(escapedPidFile))}],{stdio:'ignore'});
const waitPid=async(path)=>{const deadline=Date.now()+${SPAWNED_PROCESS_WAIT_MS}; while(Date.now()<deadline){try{return Number((await import('node:fs')).readFileSync(path,'utf8'))}catch{} await new Promise(r=>setTimeout(r,10))} throw new Error('child pid unavailable')};
await Promise.all([new Promise(r=>child.once('spawn',r)),new Promise(r=>escaped.once('spawn',r))]);
const hostPid=Number((await import('node:fs')).readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(\\d+)/m)[1]);
writeFileSync(${JSON.stringify(pidFile)},[hostPid,await waitPid(${JSON.stringify(childPidFile)}),await waitPid(${JSON.stringify(escapedPidFile)})].join('\\n'));
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n'); setInterval(()=>{},1000);
`,
  );
  if (
    typeof (new CodexHost({ executable }) as unknown as { cancelAll?: unknown })
      .cancelAll !== 'function'
  ) {
    await rm(root, { recursive: true, force: true });
    assert.fail(
      'CodexHost.cancelAll is required by the foreman signal handler',
    );
  }
  const live = new URL('../scripts/live-l1.mjs', import.meta.url).pathname;
  const waitForSessionStarted = async (
    job: string,
    process: ReturnType<typeof spawn>,
  ) => {
    let stdout = '';
    let stderr = '';
    process.stdout?.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    process.stderr?.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const tracePath = join(root, `.krn/runs/foreman/${job}/trace.jsonl`);
    const setupWaitMs = SPAWNED_PROCESS_WAIT_MS;
    const setupDeadline = Date.now() + setupWaitMs;
    let traceText = '';
    let sessionStarted = false;
    while (Date.now() < setupDeadline && !sessionStarted) {
      traceText = await readFile(tracePath, 'utf8').catch(() => '');
      sessionStarted = traceText.split('\n').some((line) => {
        try {
          return JSON.parse(line).kind === 'session_started';
        } catch {
          return false;
        }
      });
      if (process.exitCode !== null) break;
      if (!sessionStarted) await pause(20);
    }
    assert.ok(
      sessionStarted,
      `${job} foreman did not reach session_started within ${setupWaitMs}ms before PID readiness (exit=${process.exitCode}; stdout=${stdout}; stderr=${stderr}; trace=${traceText})`,
    );
  };
  let timed: ReturnType<typeof spawn> | undefined;
  let crashed: ReturnType<typeof spawn> | undefined;
  let resumed: ReturnType<typeof spawn> | undefined;
  const foreman = spawn(
    process.execPath,
    [
      live,
      '--http',
      '--repo',
      root,
      '--job',
      'B2-live',
      '--issue',
      'I-2',
      '--prompt',
      'hold',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        KRN_LIVE: '1',
        KRN_CODEX_BIN: executable,
        KRN_PAPERCLIP_API_URL: paperclip.apiUrl,
        KRN_PAPERCLIP_TOKEN: 'fixture-token',
        KRN_SESSION: 'fixture-session',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForSessionStarted('B2-live', foreman);
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    const liveTrace = (
      await readFile(
        join(root, '.krn/runs/foreman/B2-live/trace.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const started = liveTrace.find((event) => event.kind === 'session_started');
    assert.ok(started, 'actual live-l1 must persist session_started');
    assert.equal(started.data.isolation, 'systemd_scope');
    const registration = started.data.scopeRegistration as {
      readonly unit: string;
      readonly controlGroup: string;
      readonly pid: number;
      readonly startTicks: string;
    };
    assert.equal(
      registration.unit,
      `krn-B2-live-${started.data.sessionId}.scope`,
    );
    assert.equal(
      registration.controlGroup.split('/').at(-1),
      registration.unit,
    );
    assert.ok(Number.isSafeInteger(registration.pid) && registration.pid > 0);
    assert.match(registration.startTicks, /^\d+$/u);
    const cgroupPids = await readFile(
      join(
        '/sys/fs/cgroup',
        registration.controlGroup.slice(1),
        'cgroup.procs',
      ),
      'utf8',
    );
    assert.ok(cgroupPids.split(/\s+/u).includes(String(registration.pid)));
    const processStat = await readFile(
      `/proc/${registration.pid}/stat`,
      'utf8',
    );
    assert.equal(
      processStat
        .slice(processStat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u)[19],
      registration.startTicks,
    );
    foreman.kill('SIGTERM');
    const code = await new Promise((resolve) => foreman.once('close', resolve));
    assert.equal(code, 130);
    const pids = (await readFile(pidFile, 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    for (const pid of pids) assert.equal(await isAlive(pid), false);
    await unlink(pidFile);
    paperclip.resetBootstrapIssueReadPair();
    crashed = spawn(
      process.execPath,
      [
        live,
        '--http',
        '--repo',
        root,
        '--job',
        'B2-crash-recovery',
        '--issue',
        'I-2',
        '--prompt',
        'hold',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          KRN_LIVE: '1',
          KRN_CODEX_BIN: executable,
          KRN_PAPERCLIP_API_URL: paperclip.apiUrl,
          KRN_PAPERCLIP_TOKEN: 'fixture-token',
          KRN_SESSION: 'fixture-session',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await waitForSessionStarted('B2-crash-recovery', crashed);
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    const crashTracePath = join(
      root,
      '.krn/runs/foreman/B2-crash-recovery/trace.jsonl',
    );
    const crashEvents = (await readFile(crashTracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const crashStart = crashEvents.find(
      (event) => event.kind === 'session_started',
    );
    assert.ok(crashStart?.data.scopeRegistration);
    const deadScope = crashStart.data.scopeRegistration.unit as string;
    crashed.kill('SIGKILL');
    await new Promise((resolve) => crashed?.once('close', resolve));
    const systemdEnv = {
      ...process.env,
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR ??
        `/run/user/${process.getuid?.() ?? 1000}`,
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS ??
        `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
    };
    const drained = spawnSync(
      '/usr/bin/systemctl',
      ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', deadScope],
      { encoding: 'utf8', env: systemdEnv },
    );
    assert.equal(drained.status, 0, drained.stderr);
    await waitFor(async () => {
      const pids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split('\n')
        .map(Number);
      if ((await Promise.all(pids.map(isAlive))).some(Boolean))
        return undefined;
      const state = spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'show', deadScope, '-p', 'ActiveState', '--value'],
        { encoding: 'utf8', env: systemdEnv },
      );
      return state.status !== 0 || state.stdout.trim() === 'inactive'
        ? 'drained'
        : undefined;
    });
    await unlink(pidFile);
    paperclip.resetBootstrapIssueReadPair();
    resumed = spawn(
      process.execPath,
      [
        live,
        '--http',
        '--repo',
        root,
        '--job',
        'B2-crash-recovery',
        '--issue',
        'I-2',
        '--prompt',
        'hold',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          KRN_LIVE: '1',
          KRN_CODEX_BIN: executable,
          KRN_PAPERCLIP_API_URL: paperclip.apiUrl,
          KRN_PAPERCLIP_TOKEN: 'fixture-token',
          KRN_SESSION: 'fixture-session',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const recoveryDeadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    let recoveredEvents: Array<{
      kind: string;
      data: Record<string, unknown>;
    }> = [];
    while (Date.now() < recoveryDeadline && resumed.exitCode === null) {
      const contents = await readFile(crashTracePath, 'utf8');
      recoveredEvents = contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      if (
        recoveredEvents.some((event) => event.kind === 'session_lost') &&
        recoveredEvents.filter((event) => event.kind === 'session_started')
          .length >= 2
      )
        break;
      await pause(20);
    }
    assert.ok(
      recoveredEvents.some((event) => event.kind === 'session_lost'),
      'actual live-l1 must use the persisted witness to recover a drained scope',
    );
    assert.ok(
      recoveredEvents.filter((event) => event.kind === 'session_started')
        .length >= 2,
      'witness-gated recovery must permit the next session after confirmed drain',
    );
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    resumed.kill('SIGTERM');
    assert.equal(
      await new Promise((resolve) => resumed?.once('close', resolve)),
      130,
    );
    paperclip.resetBootstrapIssueReadPair();
    const timeoutForeman = spawn(
      process.execPath,
      [
        live,
        '--http',
        '--repo',
        root,
        '--job',
        'B2-timeout',
        '--issue',
        'I-2',
        '--prompt',
        'hold',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          KRN_LIVE: '1',
          KRN_CODEX_BIN: executable,
          KRN_LIVE_WALL_TIME_MS: '5000',
          KRN_PAPERCLIP_API_URL: paperclip.apiUrl,
          KRN_PAPERCLIP_TOKEN: 'fixture-token',
          KRN_SESSION: 'fixture-session',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    timed = timeoutForeman;
    await waitForSessionStarted('B2-timeout', timeoutForeman);
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).trim() || undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(
      await new Promise((resolve) => timeoutForeman.once('close', resolve)),
      124,
    );
    for (const pid of (await readFile(pidFile, 'utf8'))
      .trim()
      .split('\n')
      .map(Number))
      assert.equal(await isAlive(pid), false);
  } finally {
    foreman.kill('SIGKILL');
    if (crashed?.exitCode === null) crashed.kill('SIGKILL');
    if (resumed?.exitCode === null) resumed.kill('SIGKILL');
    if (timed?.exitCode === null) timed.kill('SIGKILL');
    try {
      for (const pid of (await readFile(pidFile, 'utf8'))
        .trim()
        .split('\n')
        .map(Number))
        process.kill(pid, 'SIGKILL');
    } catch {}
    for (const id of ['B2-live', 'B2-timeout'])
      spawnSync('git', [
        '-C',
        root,
        'worktree',
        'remove',
        '--force',
        join(`${root}-jobs`, id),
      ]);
    await rm(`${root}-jobs`, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await paperclip.close();
  }
});

test('default systemd scope isolation reaps a setsid descendant', {
  timeout: testTimeoutFor(1),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'default systemd scope isolation reaps a setsid descendant',
      ['systemdUserScope'],
    )
  )
    return;
  const root = await repoFixture();
  const pidFile = join(root, 'escaped-pid');
  const workerFile = join(root, 'setsid-worker.cjs');
  const executable = join(root, 'fake-codex.cjs');
  const previousIsolation = process.env.KRN_ISOLATION;
  delete process.env.KRN_ISOLATION;
  const job = { id: 'B2-fallback', issue: 'I-2', worktree: root };
  const host = new CodexHost({ executable });
  let ownedUnit: string | undefined;
  let ownedControlGroup: string | undefined;
  let pendingCancellation: Promise<void> | undefined;
  try {
    const workerSource = [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "const ids=readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(.+)$/m)[1].trim().split(/\\s+/);",
      `writeFileSync(${JSON.stringify(pidFile)}, ids[0]);`,
      'setInterval(()=>{},1000);',
    ].join('');
    await writeFile(workerFile, `${workerSource}\n`);
    const executableSource = `
const { spawn } = require('node:child_process');
const child = spawn('setsid', [process.execPath, ${JSON.stringify(workerFile)}], { stdio: 'inherit' });
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('spawn', () => {
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }) + '\\n');
  setInterval(() => {}, 1000);
});
`;
    await writeFile(executable, `#!/usr/bin/env node\n${executableSource}`);
    await Promise.all(
      [workerFile, executable].map((path) => chmod(path, 0o755)),
    );
    const intent = await trace.intent(job, 0);
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'hold',
      limits: { timeoutMs: 10_000 },
      checkpoint: {
        cli: 'fixture',
        job: job.id,
        issue: job.issue,
        worktree: root,
        intent,
      },
      onStarted: (id, pgid, isolation, registration) => {
        assert.equal(isolation, 'systemd_scope');
        assert.ok(registration, 'startup must provide the owned scope witness');
        ownedUnit = registration.unit;
        ownedControlGroup = registration.controlGroup;
        return trace.started(job, intent, id, pgid, isolation, registration);
      },
    });
    const pid = Number(
      await waitFor(async () => {
        try {
          return (await readFile(pidFile, 'utf8')).trim();
        } catch {
          return undefined;
        }
      }),
    );
    assert.ok(ownedUnit);
    const controlGroup = ownedControlGroup;
    assert.ok(controlGroup);
    assert.equal(
      await isAlive(pid),
      true,
      'the setsid descendant must be live',
    );
    const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
    assert.ok(
      membership.split('\n').some((line) => line.endsWith(controlGroup)),
      'the setsid descendant must remain in the exact owned systemd cgroup',
    );

    pendingCancellation = host.cancelTree(session.id);
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationSettled: boolean;
    try {
      cancellationSettled = await Promise.race([
        pendingCancellation.then(() => true),
        new Promise<boolean>((resolve) => {
          cancellationTimer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
    } finally {
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
    }
    assert.equal(
      cancellationSettled,
      true,
      'cancellation must drain the scope while the descendant holds inherited pipes',
    );
    await session.wait();
    if (await isAlive(pid)) {
      const state = spawnSync(
        'ps',
        ['-o', 'pid,ppid,pgid,sid,stat,args', '-p', String(pid)],
        { encoding: 'utf8' },
      );
      assert.fail(`fallback left descendant ${pid} alive: ${state.stdout}`);
    }
    const events = (
      await readFile(
        join(root, '.krn/runs/foreman/B2-fallback/trace.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      events.find((event) => event.kind === 'session_started')?.data.isolation,
      'systemd_scope',
    );
  } finally {
    if (previousIsolation === undefined) delete process.env.KRN_ISOLATION;
    else process.env.KRN_ISOLATION = previousIsolation;
    if (ownedUnit) {
      const systemdEnv = {
        ...process.env,
        XDG_RUNTIME_DIR:
          process.env.XDG_RUNTIME_DIR ??
          `/run/user/${process.getuid?.() ?? 1000}`,
        DBUS_SESSION_BUS_ADDRESS:
          process.env.DBUS_SESSION_BUS_ADDRESS ??
          `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
      };
      spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', ownedUnit],
        { encoding: 'utf8', env: systemdEnv },
      );
    }
    await pendingCancellation?.catch(() => undefined);
    await host.cancelAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('B3 live uses the requested repo and resumes an existing job by id', async () => {
  const repo = await repoFixture();
  const paperclip = await fakePaperclip('I-1');
  const bin = await fakeCodex(
    repo,
    `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n'); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');`,
  );
  const fakeHome = await mkdtemp(join(tmpdir(), 'krn-s4b-home-'));
  const args = [
    '--job',
    'same-job',
    '--http',
    '--issue',
    'I-1',
    '--prompt',
    'do it',
    '--repo',
    repo,
  ];
  const exec = (extra: string[] = []) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          [
            new URL('../scripts/live-l1.mjs', import.meta.url).pathname,
            ...args,
            ...extra,
          ],
          {
            cwd: new URL('..', import.meta.url).pathname,
            env: {
              ...process.env,
              HOME: fakeHome,
              KRN_LIVE: '1',
              KRN_CODEX_BIN: bin,
              KRN_PAPERCLIP_API_URL: paperclip.apiUrl,
              KRN_PAPERCLIP_TOKEN: 'fixture-token',
              KRN_SESSION: 'fixture-session',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout
          .setEncoding('utf8')
          .on('data', (chunk) => (stdout += chunk));
        child.stderr
          .setEncoding('utf8')
          .on('data', (chunk) => (stderr += chunk));
        child.once('close', (status) => resolve({ status, stdout, stderr }));
      },
    );
  try {
    const first = await exec();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const job = JSON.parse(lastOutputLine(first.stdout)).job;
    assert.equal(job.worktree, join(repo, '.krn', 'worktrees', 'same-job'));
    const resumed = await exec();
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(
      JSON.parse(lastOutputLine(resumed.stdout)).job.worktree,
      job.worktree,
    );
  } finally {
    const packageRoot = new URL('..', import.meta.url).pathname.replace(
      /\/$/,
      '',
    );
    for (const worktree of [
      join(repo, '.krn', 'worktrees', 'same-job'),
      join(packageRoot, '.krn', 'worktrees', 'same-job'),
    ]) {
      const parent = worktree.startsWith(`${repo}/`) ? repo : packageRoot;
      spawnSync('git', [
        '-C',
        parent,
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
      await rm(worktree, { recursive: true, force: true });
    }
    await rm(repo, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
    await paperclip.close();
  }
});

test('live SIGTERM reaps every Paperclip CLI group during contract loading', {
  timeout: testTimeoutFor(1),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'live SIGTERM reaps every Paperclip CLI group during contract loading',
      ['systemdUserScope'],
    )
  )
    return;
  const repo = await repoFixture();
  const fakeBin = await mkdtemp(join(tmpdir(), 'krn-s4b-paperclip-bin-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'krn-s4b-paperclip-home-'));
  const pidFile = join(fakeHome, 'descendants.txt');
  const executable = join(fakeBin, 'paperclip');
  await writeFile(
    executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.appendFileSync(process.env.PAPERCLIP_TEST_PID_FILE, String(child.pid) + '\\n');\nsetInterval(() => {}, 1000);\n`,
  );
  await chmod(executable, 0o755);
  const script = new URL('../scripts/live-l1.mjs', import.meta.url).pathname;
  const live = spawn(
    process.execPath,
    [
      script,
      '--repo',
      repo,
      '--job',
      'signal-during-ledger-read',
      '--issue',
      'I-SIGTERM',
      '--prompt',
      'hold during contract read',
    ],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HOME: fakeHome,
        KRN_LIVE: '1',
        PAPERCLIP_TEST_PID_FILE: pidFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  live.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  let pids: number[] = [];
  try {
    const recorded = await waitFor(async () => {
      try {
        const contents = await readFile(pidFile, 'utf8');
        pids = contents.trim().split('\n').filter(Boolean).map(Number);
        return pids.length >= 2 ? contents : undefined;
      } catch {
        return undefined;
      }
    });
    assert.ok(recorded);
    live.kill('SIGTERM');
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      live.once('close', (code, signal) => resolve({ code, signal })),
    );
    assert.ok(
      (await Promise.all(pids.map((pid) => isAlive(pid)))).every(
        (alive) => !alive,
      ),
      'SIGTERM must reap Paperclip CLI descendants before live-l1 exits',
    );
    assert.equal(result.code, 130, `${result.signal}: ${stderr}`);
  } finally {
    if (live.exitCode === null && live.signalCode === null)
      live.kill('SIGKILL');
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await Promise.all([
      rm(fakeBin, { recursive: true, force: true }),
      rm(fakeHome, { recursive: true, force: true }),
      rm(repo, { recursive: true, force: true }),
    ]);
  }
});

test('live SIGTERM during a real verdict waits for scope teardown before exit', {
  timeout: testTimeoutFor(2),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'live SIGTERM during a real verdict waits for scope teardown before exit',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const repoScratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(repoScratch, { recursive: true });
  const root = await repoFixture('.krn/\n', repoScratch);
  const fakeBin = await mkdtemp(join(tmpdir(), 'krn-s4b-verdict-bin-'));
  const diagnosticScratch = await mkdtemp(
    join(repoScratch, 'lon212-proof-sol2-'),
  );
  const jobId = 'signal-during-verdict';
  const issue = 'I-VERDICT-STOP';
  const submitMarker = join(fakeBin, 'submit-called');
  const scopeKillMarker = join(fakeBin, 'scope-kill-completed');
  const fakePaperclip = join(fakeBin, 'paperclip');
  const fakeCodexPath = join(fakeBin, 'codex');
  const toolchain = await mkdtemp(join(repoScratch, 'krn-s4b-toolchain-'));
  const scopeUnitMarker = join(toolchain, 'owned-scope-unit');
  const fakeMise = join(fakeBin, 'mise');
  const fakePnpm = join(toolchain, 'pnpm');
  const fakeSystemctl = join(toolchain, 'systemctl');
  const fakeObserverSystemctl = join(diagnosticScratch, 'systemctl');
  const fakeSystemdRun = join(toolchain, 'systemd-run');
  const storePath = join(toolchain, 'store', 'v11');
  await mkdir(storePath, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@12.10.1' }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [
        {
          id: 'sleeping-check',
          argv: ['/usr/bin/sleep', '30'],
          timeoutMs: 60_000,
        },
      ],
    }),
  );
  spawnSync('git', [
    '-C',
    root,
    'add',
    'krn.checks.json',
    'package.json',
    'pnpm-lock.yaml',
  ]);
  const committed = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'test: declare a sleeping verdict check',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(committed.status, 0, committed.stderr);
  await writeFile(
    fakeMise,
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(toolchain)}\n`,
  );
  await writeFile(
    fakePnpm,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
const store=args.find((value)=>value.startsWith('--store-dir='))?.slice('--store-dir='.length);
if(args.at(-2)==='store'&&args.at(-1)==='path')process.stdout.write(store?store+'/v11':${JSON.stringify(storePath)});
`,
  );
  await writeFile(
    fakeSystemctl,
    `#!/bin/sh
case "$*" in *" kill "*) sleep 2; /usr/bin/systemctl "$@"; status=$?; touch ${JSON.stringify(scopeKillMarker)}; exit $status ;; esac
exec /usr/bin/systemctl "$@"
`,
  );
  await writeFile(
    fakeObserverSystemctl,
    `#!/bin/sh
case "$*" in
  *" list-units "*--plain*)
    index=0
    while [ "$index" -lt 80 ]; do
      printf 'krn-check-stale-lon212-%03d.scope loaded inactive dead simulated-stale-metadata\n' "$index"
      index=$((index + 1))
    done
    /usr/bin/systemctl "$@"
    exit $?
    ;;
  *" show krn-check-stale-lon212-"*) sleep 0.5 ;;
esac
exec /usr/bin/systemctl "$@"
`,
  );
  await writeFile(
    fakeSystemdRun,
    `#!/bin/sh
previous=''
unit=''
has_sleeping_check=0
for argument do
  if [ "$previous" = '--unit' ]; then
    unit="$argument"
  fi
  if [ "$argument" = '/usr/bin/sleep' ]; then has_sleeping_check=1; fi
  previous="$argument"
done
if [ -n "$unit" ] && [ "$has_sleeping_check" -eq 1 ]; then
  case "$unit" in *.scope) ;; *) unit="$unit.scope" ;; esac
  printf '%s\\n' "$unit" > ${JSON.stringify(scopeUnitMarker)}
fi
exec /usr/bin/systemd-run "$@"
`,
  );
  const contract = {
    version: 1,
    targetRepo: 'fixture/repo',
    checks: ['sleeping-check'],
  };
  await writeFile(
    fakePaperclip,
    `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='issue'&&args[1]==='get')process.stdout.write(JSON.stringify({id:${JSON.stringify(issue)},identifier:${JSON.stringify(issue)},title:'Fixture',description:'\\x60\\x60\\x60krn-contract\\n'+${JSON.stringify(JSON.stringify(contract))}+'\\n\\x60\\x60\\x60',updatedAt:'2026-10-08T10:00:00.000Z',status:'in_progress',assigneeAgentId:'fixture-agent'}));
else if(args[0]==='activity'&&args[1]==='issue')process.stdout.write('[]');
else if(args[0]==='issue'&&args[1]==='update'){fs.writeFileSync(${JSON.stringify(submitMarker)},args.join(' '));process.stdout.write(JSON.stringify({id:${JSON.stringify(issue)}}));}
else {process.stderr.write('unexpected Paperclip command: '+args.join(' '));process.exit(2)}
`,
  );
  const fakeCodexBody = `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const root=${JSON.stringify(join(root, '.krn', 'worktrees', jobId))};
const cli=${JSON.stringify(new URL('../src/cli/main.ts', import.meta.url).pathname)};
const sid=/--session'?\\s+'?([0-9a-f-]+)/.exec(prompt)?.[1];
if(!sid) throw new Error('missing foreman session id');
writeFileSync(root+'/worker-change.txt','checkpoint change\\n');
execFileSync(process.execPath,[cli,'checkpoint','--job',${JSON.stringify(jobId)},'--issue',${JSON.stringify(issue)},'--worktree',root,'--intent','intent:0','--session',sid,'--message','feat: finish sleeping check fixture','--next','done'],{cwd:root});
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'sleep-check-session'})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'checkpointed'}})+'\\n');
`;
  await writeFile(fakeCodexPath, `#!/usr/bin/env node\n${fakeCodexBody}\n`);
  await Promise.all(
    [
      fakePaperclip,
      fakeCodexPath,
      fakeMise,
      fakePnpm,
      fakeSystemctl,
      fakeObserverSystemctl,
      fakeSystemdRun,
    ].map((file) => chmod(file, 0o755)),
  );
  const live = new URL('../scripts/live-l1.mjs', import.meta.url).pathname;
  const runner = spawn(
    process.execPath,
    [live, '--submit', '--repo', root, '--job', jobId, '--issue', issue],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${diagnosticScratch}:${fakeBin}:${process.env.PATH ?? ''}`,
        KRN_LIVE: '1',
        KRN_CODEX_BIN: fakeCodexPath,
        KRN_SESSION: 'fixture-session',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  runner.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  runner.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  let unit = '';
  let scopePids: number[] = [];
  const systemdEnv = {
    ...process.env,
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ??
      `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
  };
  try {
    const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    while (Date.now() < deadline && !unit && runner.exitCode === null) {
      const candidate = (
        await readFile(scopeUnitMarker, 'utf8').catch(() => '')
      ).trim();
      if (/^krn-check-[A-Za-z0-9-]+\.scope$/u.test(candidate)) {
        const state = spawnSync(
          'systemctl',
          ['--user', 'show', candidate, '-p', 'ActiveState', '--value'],
          { encoding: 'utf8', env: systemdEnv },
        );
        if (state.status === 0 && state.stdout.trim() === 'active')
          unit = candidate;
      }
      if (!unit) await pause(20);
    }
    let earlyTrace = '';
    try {
      earlyTrace = await readFile(
        join(root, '.krn', 'runs', 'foreman', jobId, 'trace.jsonl'),
        'utf8',
      );
    } catch {}
    const diagnosticsDirectory = join(
      root,
      '.krn',
      'runs',
      'foreman',
      jobId,
      'diagnostics',
    );
    const diagnosticNames = await readdir(diagnosticsDirectory).catch(() => []);
    const diagnostics = await Promise.all(
      diagnosticNames.map((name) =>
        readFile(join(diagnosticsDirectory, name), 'utf8'),
      ),
    );
    assert.ok(
      unit,
      `sleeping check never entered its systemd scope (owned unit=${await readFile(scopeUnitMarker, 'utf8').catch(() => '<missing>')}; runner exit=${runner.exitCode}; stdout=${stdout}; stderr=${stderr}; trace=${earlyTrace}; diagnostics=${diagnostics.join('---')})`,
    );
    const group = spawnSync(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ControlGroup', '--value'],
      { encoding: 'utf8', env: systemdEnv },
    );
    assert.equal(group.status, 0, group.stderr);
    const cgroupPath = join(
      '/sys/fs/cgroup',
      group.stdout.trim().replace(/^\/+/, ''),
    );
    const pidsPath = join(cgroupPath, 'cgroup.procs');
    const pidsDeadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    while (Date.now() < pidsDeadline && scopePids.length === 0) {
      try {
        scopePids = (await readFile(pidsPath, 'utf8'))
          .trim()
          .split(/\s+/u)
          .filter(Boolean)
          .map(Number);
      } catch {}
      if (!scopePids.length) await pause(10);
    }
    assert.ok(scopePids.length, 'sleeping scope had no observable PIDs');
    runner.kill('SIGTERM');
    const code = await new Promise((resolve) => runner.once('close', resolve));
    assert.equal(code, 130, stderr);
    assert.ok(
      existsSync(scopeKillMarker),
      'live-l1 exited before the scope kill completed',
    );
    assert.equal(
      existsSync(submitMarker),
      false,
      'SIGTERM must prevent the Paperclip update',
    );
    assert.ok(
      (await Promise.all(scopePids.map(isAlive))).every((alive) => !alive),
      'scope PIDs survived live-l1',
    );
    const after = spawnSync(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ActiveState', '--value'],
      { encoding: 'utf8', env: systemdEnv },
    );
    assert.ok(
      after.status !== 0 || after.stdout.trim() === 'inactive',
      `scope remains active: ${after.stdout} ${after.stderr}`,
    );
    const afterGroup = spawnSync(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ControlGroup', '--value'],
      { encoding: 'utf8', env: systemdEnv },
    );
    const remainingPids = afterGroup.stdout.trim()
      ? await readFile(
          join(
            '/sys/fs/cgroup',
            afterGroup.stdout.trim().replace(/^\/+/, ''),
            'cgroup.procs',
          ),
          'utf8',
        ).catch(() => '')
      : '';
    assert.equal(
      remainingPids.trim(),
      '',
      'cgroup still contains PIDs after live-l1 exited',
    );
    const traceFile = join(
      root,
      '.krn',
      'runs',
      'foreman',
      jobId,
      'trace.jsonl',
    );
    const events = (await readFile(traceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.kind === 'stopped'),
      'trace must record stopped',
    );
    assert.ok(
      !events.some((event) => event.kind === 'teardown_unconfirmed'),
      'confirmed teardown must not be recorded as unconfirmed',
    );
  } finally {
    if (runner.exitCode === null && runner.signalCode === null)
      runner.kill('SIGKILL');
    if (scopePids.length) {
      for (const pid of scopePids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    const ownedUnit = await readFile(scopeUnitMarker, 'utf8').catch(() => '');
    if (ownedUnit.trim())
      spawnSync(
        'systemctl',
        [
          '--user',
          'kill',
          '--kill-who=all',
          '--signal=SIGKILL',
          ownedUnit.trim(),
        ],
        { encoding: 'utf8', env: systemdEnv },
      );
    await rm(fakeBin, { recursive: true, force: true });
    await rm(diagnosticScratch, { recursive: true, force: true });
    await rm(toolchain, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('B4 checkpoint preserves worker action and decisions beside lease state', async () => {
  const root = await repoFixture();
  const job = { id: 'B4', issue: 'I-4', worktree: root };
  try {
    const capsule = await relay.load(job, { revision: 'r1' });
    const intent = await trace.intent(job, capsule.epoch);
    const bound = await relay.bindSession(job, capsule, 'session-4');
    assert.equal(bound.applied, true);
    await trace.started(job, intent, 'session-4');
    const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
    const args = [
      cli,
      'checkpoint',
      '--job',
      job.id,
      '--issue',
      job.issue,
      '--worktree',
      root,
      '--intent',
      intent,
      '--session',
      'session-4',
      '--message',
      'feat: checkpoint step A',
      '--next',
      'step B: verify',
      '--decision',
      'chose the narrow fix',
    ];
    const saved = await runIsolatedCheckpoint(args);
    assert.equal(saved.code, 0, `${saved.stdout}\n${saved.stderr}`);
    await relay.checkpoint(
      job,
      'session-4',
      'feat: checkpoint step A',
      'step B: verify',
      'chose the narrow fix',
    );
    const checkpointed = await relay.load(job, { revision: 'r1' });
    assert.equal(checkpointed.nextAction, 'step B: verify');
    assert.equal(checkpointed.lease, 'checkpointed');
    assert.equal(checkpointed.decisions.at(-1)?.text, 'chose the narrow fix');
    assert.equal(checkpointed.sessionId, 'session-4');
    await writeFile(join(root, 'README.md'), 'dirty after checkpoint\n');
    const dirty = await runIsolatedCheckpoint(args);
    assert.equal(dirty.code, 0, `${dirty.stdout}\n${dirty.stderr}`);
    assert.equal(
      (await relay.load(job, { revision: 'r1' })).decisions.some((decision) =>
        decision.text.includes('feat: checkpoint step A'),
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B5 trace stores only bounded session metadata and capsule ABI rejects newlines', async () => {
  const root = await repoFixture();
  const job = { id: 'B5', issue: 'I-5', worktree: root };
  const secret = 'MULTILINE FINAL MESSAGE';
  try {
    const intent = await trace.intent(job, 0);
    await trace.started(job, intent, 's5', 1234);
    await trace.log(job, intent, 's5', 'session_ended', {
      reasonKind: 'agent_message',
      reasonSha256: 'a'.repeat(64),
      reasonLength: secret.length,
      claimsDone: true,
      exitCode: 0,
      signal: null,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      finalMessage: secret,
      stderr: secret,
    } as never);
    const text = await readFile(
      join(root, '.krn/runs/foreman/B5/trace.jsonl'),
      'utf8',
    );
    assert.equal(text.includes(secret), false);
    assert.match(text, /"pgid":1234/);
    assert.match(text, /"sandbox":"workspace-write"/);
    const capsule = await relay.load(job, { revision: 'r1' });
    const capsulePath = join(root, '.krn/runs/foreman/B5/capsule.json');
    const originalCapsule = await readFile(capsulePath, 'utf8');
    assert.deepEqual(
      await relay.writeCapsule(
        job,
        { ...capsule, epoch: 1, nextAction: 'step A\nforged field' },
        0,
      ),
      { applied: false },
    );
    assert.equal(await readFile(capsulePath, 'utf8'), originalCapsule);
    assert.deepEqual(await relay.load(job, { revision: 'r1' }), capsule);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B6 parses a multi-megabyte JSONL session under a per-line limit', async (t) => {
  if (
    !requiresIsolation(
      t,
      'B6 parses a multi-megabyte JSONL session under a per-line limit',
      ['systemdUserScope'],
    )
  )
    return;
  const root = await repoFixture();
  const executable = await fakeCodex(
    root,
    `
for(let i=0;i<2200;i++) process.stdout.write(JSON.stringify({type:'progress',data:'x'.repeat(1800)})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:91000,output_tokens:12000,total_tokens:103000}})+'\\n');
`,
  );
  const host = new CodexHost({ executable });
  try {
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'finish',
      limits: { timeoutMs: 30_000 },
    });
    const end = await session.wait();
    assert.equal(end.claimsDone, true);
    assert.equal(end.usage.totalTokens, 103000);
    assert.equal(end.reasonLength, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B7 codex command grants workspace write without the git common dir', async (t) => {
  if (
    !requiresIsolation(
      t,
      'B7 codex command grants workspace write without the git common dir',
      ['systemdUserScope'],
    )
  )
    return;
  const root = await repoFixture();
  const worktree = join(`${root}-linked`, 'job');
  await mkdir(`${root}-linked`, { recursive: true });
  const added = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '--detach', worktree, 'HEAD'],
    { encoding: 'utf8' },
  );
  assert.equal(added.status, 0, added.stderr);
  const argsFile = join(root, 'args');
  const executable = await fakeCodex(
    root,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');`,
  );
  const host = new CodexHost({ executable });
  try {
    const job = { id: 'B7', issue: 'I-7', worktree };
    const intent = await trace.intent(job, 0);
    const session = await host.start({
      cwd: worktree,
      model: 'gpt-6-luna',
      prompt: 'work',
      limits: { timeoutMs: 10_000 },
      checkpoint: {
        cli: 'fixture',
        job: job.id,
        issue: job.issue,
        worktree,
        intent,
      },
      onStarted: (id, pgid, isolation, registration) =>
        trace.started(job, intent, id, pgid, isolation, registration),
    });
    await session.wait();
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    assert.deepEqual(
      args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2),
      ['--sandbox', 'workspace-write'],
    );
    assert.equal(args.includes('--add-dir'), false);
  } finally {
    await rm(join(worktree, '.krn'), { recursive: true, force: true });
    spawnSync('git', ['-C', root, 'worktree', 'remove', worktree]);
    await rm(`${root}-linked`, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  read: () => Promise<string | undefined>,
): Promise<string> {
  const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(20);
  }
  assert.fail('timed out waiting for fake process');
}

async function runIsolatedCheckpoint(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn(
    'bash',
    ['-c', `node ${args.map(quote).join(' ')}; code=$?; sleep .05; exit $code`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  return { code, stdout, stderr };
}

function lastOutputLine(output: string): string {
  const line = output.trim().split('\n').at(-1);
  assert.ok(line, 'command emitted a JSON result');
  return line;
}
