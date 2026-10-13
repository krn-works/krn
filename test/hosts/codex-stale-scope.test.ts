import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost } from '../../src/hosts/codex.ts';
import { codexScopeRuntimeGraceMs } from '../../src/hosts/systemd-scope.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const sessionTimeoutMs = 700;

test('systemd scope ends after parent SIGKILL within timeout plus grace', async (t) => {
  if (
    !requiresIsolation(
      t,
      'systemd scope ends after parent SIGKILL within timeout plus grace',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-host-hard-timeout-'));
  const pidFile = join(directory, 'judge.json');
  let parent: ReturnType<typeof spawn> | undefined;
  let scope:
    | { readonly pid: number; readonly unit: string; readonly cgroup: string }
    | undefined;
  try {
    const fake = await fakeCodex(directory, pidFile);
    const runner = await parentRunner(directory);
    const launched = launchParent(runner, fake, pidFile, sessionTimeoutMs);
    parent = launched.child;
    const closed = parentClosed(parent);
    scope = await readScope(pidFile);
    await waitFor(() => readyPid(launched.ready) === parent?.pid);
    assert.equal(parent.kill('SIGKILL'), true);
    await closed;
    const stoppedAt = Date.now();
    await waitFor(
      () =>
        !isProcessAlive(scope?.pid ?? -1) && !scopeIsPopulated(scope?.cgroup),
    );
    assert.ok(
      Date.now() - stoppedAt <= codexScopeRuntimeGraceMs + 1500,
      'systemd must reap the child within the configured runtime grace',
    );
    assertScopeInactive(scope.unit);
  } finally {
    if (parent?.exitCode === null && parent.signalCode === null)
      parent.kill('SIGKILL');
    if (scope) await killScope(scope.unit, scope.cgroup);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new host reaps an orphaned scope by prefix and owner metadata', async (t) => {
  if (
    !requiresIsolation(
      t,
      'a new host reaps an orphaned scope by prefix and owner metadata',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-host-stale-scope-'));
  const pidFile = join(directory, 'judge.json');
  let parent: ReturnType<typeof spawn> | undefined;
  let scope:
    | { readonly pid: number; readonly unit: string; readonly cgroup: string }
    | undefined;
  try {
    const fake = await fakeCodex(directory, pidFile);
    const runner = await parentRunner(directory);
    const launched = launchParent(runner, fake, pidFile, 60_000);
    parent = launched.child;
    const closed = parentClosed(parent);
    scope = await readScope(pidFile);
    await waitFor(() => readyPid(launched.ready) === parent?.pid);
    assert.equal(scopeIsPopulated(scope.cgroup), true);
    assert.equal(parent.kill('SIGKILL'), true);
    await closed;

    const completedFake = await fakeCodex(directory);
    const host = new CodexHost({ executable: completedFake });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'finish',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    assert.ok(
      result.reapedScopes?.some(({ unit }) => unit === scope?.unit),
      'CodexHost should report the stale scope it stopped',
    );
    assert.equal(isProcessAlive(scope.pid), false);
    assert.equal(scopeIsPopulated(scope.cgroup), false);
    assertScopeInactive(scope.unit);
  } finally {
    if (parent?.exitCode === null && parent.signalCode === null)
      parent.kill('SIGKILL');
    if (scope) await killScope(scope.unit, scope.cgroup);
    await rm(directory, { recursive: true, force: true });
  }
});

async function fakeCodex(directory: string, pidFile?: string): Promise<string> {
  const executable = join(directory, 'fake-codex.mjs');
  const behavior = pidFile
    ? `writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`
    : "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n'); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');";
  await writeFile(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\n${behavior}\n`,
  );
  await chmod(executable, 0o700);
  return executable;
}

async function parentRunner(directory: string): Promise<string> {
  const runner = join(directory, 'orphan-parent.mjs');
  const hostModule = new URL('../../src/hosts/codex.ts', import.meta.url).href;
  await writeFile(
    runner,
    `import { CodexHost } from ${JSON.stringify(hostModule)};\nimport { writeFileSync } from 'node:fs';\nconst host=new CodexHost({executable:process.env.KRN_FAKE_CODEX});\nconst session=await host.start({cwd:process.env.KRN_SCOPE_CWD,model:'gpt-6-luna',prompt:'wait',limits:{timeoutMs:Number(process.env.KRN_SESSION_TIMEOUT)}});\nwriteFileSync(process.env.KRN_PARENT_READY,String(process.pid));\nawait session.wait();\n`,
  );
  return runner;
}

function launchParent(
  runner: string,
  fake: string,
  pidFile: string,
  timeoutMs: number,
): { readonly child: ReturnType<typeof spawn>; readonly ready: string } {
  const ready = `${pidFile}.parent`;
  const parent = spawn(process.execPath, [runner], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...systemdEnvironment(),
      KRN_FAKE_CODEX: fake,
      KRN_SCOPE_CWD: join(pidFile, '..'),
      KRN_PARENT_READY: ready,
      KRN_SESSION_TIMEOUT: String(timeoutMs),
    },
  });
  parent.stderr?.resume();
  return { child: parent, ready };
}

async function parentClosed(parent: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolveClose) =>
    parent.once('close', () => resolveClose()),
  );
}

function readyPid(path: string): number | undefined {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return undefined;
  }
}

async function readScope(pidFile: string): Promise<{
  readonly pid: number;
  readonly unit: string;
  readonly cgroup: string;
}> {
  const pid = await waitFor(async () => {
    try {
      return Number((await readFile(pidFile, 'utf8')).trim());
    } catch {
      return undefined;
    }
  });
  const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3);
  const unit = cgroup?.split('/').at(-1);
  assert.ok(cgroup);
  assert.ok(unit);
  assert.match(unit, /^krn-.+\.scope$/u);
  return { pid, unit, cgroup };
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail('timed out waiting for the Codex scope');
}

function isProcessAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return (
      stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    );
  } catch {
    return false;
  }
}

function scopeIsPopulated(cgroup: string | undefined): boolean {
  if (!cgroup) return false;
  try {
    const events = readFileSync(
      join('/sys/fs/cgroup', cgroup, 'cgroup.events'),
      'utf8',
    );
    return /^populated 1$/mu.test(events);
  } catch {
    return false;
  }
}

function assertScopeInactive(unit: string): void {
  const state = spawnSync(
    'systemctl',
    ['--user', 'show', unit, '--property=ActiveState', '--value'],
    { encoding: 'utf8', env: systemdEnvironment() },
  );
  assert.ok(state.status !== 0 || state.stdout.trim() !== 'active');
}

async function killScope(unit: string, cgroup: string): Promise<void> {
  spawnSync(
    'systemctl',
    ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
    { encoding: 'utf8', env: systemdEnvironment() },
  );
  const deadline = Date.now() + 5000;
  while (scopeIsPopulated(cgroup) && Date.now() < deadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}

function systemdEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
  };
}
