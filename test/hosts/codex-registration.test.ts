import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexHost } from '../../src/hosts/codex.ts';
import {
  codexScopeUnit,
  processHasIdentity,
  processStartTicks,
  validateSystemdScopeRegistration,
  waitForSystemdScopeRegistration,
} from '../../src/hosts/systemd-scope.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const scopeEnvironment = () => ({
  ...process.env,
  XDG_RUNTIME_DIR:
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
  DBUS_SESSION_BUS_ADDRESS:
    process.env.DBUS_SESSION_BUS_ADDRESS ??
    `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
});

test('Codex onStarted waits for observed registration and persists live identity', async (t) => {
  if (
    !requiresIsolation(
      t,
      'Codex onStarted waits for observed registration and persists live identity',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-registration-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(directory, 'fake-codex');
  const systemdRun = join(fakeBin, 'systemd-run');
  const launchMarker = join(directory, 'manager-launch');
  const promptMarker = join(directory, 'prompt-delivered');
  const previousPath = process.env.PATH;
  let host: CodexHost | undefined;
  let observed: unknown;
  let callbackAfterManagerLaunch = false;
  let callbackBeforePrompt = false;
  let callbackSawMember = false;
  let callbackSawIdentity = false;
  try {
    await mkdir(fakeBin);
    await writeFile(
      systemdRun,
      `#!/bin/sh
previous=''
unit=''
for argument do
  if [ "$previous" = '--unit' ]; then unit="$argument"; fi
  previous="$argument"
done
case "$unit" in
  krn-registration-*) /usr/bin/sleep 0.4; : > ${JSON.stringify(launchMarker)} ;;
esac
exec /usr/bin/systemd-run "$@"
`,
    );
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r prompt || true
: > ${JSON.stringify(promptMarker)}
`,
    );
    await Promise.all(
      [systemdRun, executable].map((path) => chmod(path, 0o755)),
    );
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    host = new CodexHost({ executable });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'registered prompt',
      limits: { timeoutMs: 10_000 },
      checkpoint: {
        cli: 'unused',
        job: 'registration',
        issue: 'registration',
        worktree: directory,
        intent: 'intent:0',
      },
      onStarted: async (...args: unknown[]) => {
        const [sessionId, , isolation, registration] = args;
        assert.equal(isolation, 'systemd_scope');
        assert.equal(typeof sessionId, 'string');
        observed = registration;
        callbackAfterManagerLaunch = await readFile(launchMarker, 'utf8')
          .then(() => true)
          .catch(() => false);
        callbackBeforePrompt = await readFile(promptMarker, 'utf8')
          .then(() => false)
          .catch(() => true);
        const unit = `krn-registration-${String(sessionId)}.scope`;
        const shown = spawnSync(
          '/usr/bin/systemctl',
          [
            '--user',
            'show',
            unit,
            '-p',
            'ActiveState',
            '-p',
            'ControlGroup',
            '--value',
          ],
          { encoding: 'utf8', env: scopeEnvironment() },
        );
        if (shown.status === 0) {
          const [, controlGroup = ''] = shown.stdout.trimEnd().split(/\r?\n/u);
          const members = controlGroup
            ? await readFile(
                join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs'),
                'utf8',
              ).catch(() => '')
            : '';
          const proof = registration as
            | { readonly pid?: unknown; readonly startTicks?: unknown }
            | undefined;
          callbackSawMember =
            typeof proof?.pid === 'number' &&
            members.split(/\s+/u).includes(String(proof.pid));
          if (
            typeof proof?.pid === 'number' &&
            typeof proof.startTicks === 'string'
          ) {
            const stat = await readFile(
              `/proc/${proof.pid}/stat`,
              'utf8',
            ).catch(() => '');
            callbackSawIdentity =
              stat
                .slice(stat.lastIndexOf(')') + 2)
                .trim()
                .split(/\s+/u)[19] === proof.startTicks;
          }
        }
        return true;
      },
    });
    await session.wait();
    assert.equal(
      callbackAfterManagerLaunch,
      true,
      'callback must follow manager registration request',
    );
    assert.equal(
      callbackBeforePrompt,
      true,
      'prompt must remain withheld until callback accepts',
    );
    assert.equal(
      callbackSawMember,
      true,
      'witness PID must be observed in cgroup before callback',
    );
    assert.equal(
      callbackSawIdentity,
      true,
      'witness process identity must be live before callback',
    );
    assert.ok(
      observed && typeof observed === 'object',
      'onStarted must receive positive systemd registration metadata',
    );
    const proof = observed as {
      readonly unit?: unknown;
      readonly controlGroup?: unknown;
      readonly pid?: unknown;
      readonly startTicks?: unknown;
    };
    assert.equal(typeof proof.unit, 'string');
    assert.equal(typeof proof.controlGroup, 'string');
    assert.equal(typeof proof.pid, 'number');
    assert.equal(typeof proof.startTicks, 'string');
  } finally {
    if (host) await host.cancelAll().catch(() => undefined);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation during onStarted cannot deliver a prompt or return a session', async (t) => {
  if (
    !requiresIsolation(
      t,
      'cancellation during onStarted cannot deliver a prompt or return a session',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-callback-cancel-'));
  const executable = join(directory, 'fake-codex');
  const promptMarker = join(directory, 'prompt-delivered');
  const host = new CodexHost({ executable });
  let enterCallback!: () => void;
  let releaseCallback!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterCallback = resolve;
  });
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let handbacks = 0;
  try {
    await writeFile(
      executable,
      `#!/bin/sh\nIFS= read -r prompt || true\n: > ${JSON.stringify(promptMarker)}\n`,
    );
    await chmod(executable, 0o755);
    const starting = host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'must not arrive',
      limits: { timeoutMs: 10_000 },
      checkpoint: {
        cli: 'unused',
        job: 'callback-cancel',
        issue: 'callback-cancel',
        worktree: directory,
        intent: 'intent:0',
      },
      onStarted: async () => {
        enterCallback();
        await callbackGate;
        return true;
      },
      onStartCancelled: async () => {
        handbacks += 1;
      },
    });
    const startingOutcome = starting.then(
      (session) => ({ status: 'fulfilled' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await Promise.race([
      entered,
      delay(5000).then(() => assert.fail('onStarted never became eligible')),
    ]);
    await host.cancelAll();
    releaseCallback();
    const settled = await Promise.race([
      startingOutcome,
      delay(4000).then(() => undefined),
    ]);
    assert.ok(settled, 'callback cancellation must remain bounded');
    if (settled.status !== 'rejected')
      assert.fail('cancelled startup must not return a session');
    assert.match(
      String(settled.error),
      /cancel/i,
      'startup must reject because it was cancelled during onStarted',
    );
    assert.equal(
      handbacks,
      1,
      'a bound callback must receive post-cleanup handback',
    );
    assert.equal(
      await readFile(promptMarker, 'utf8')
        .then(() => true)
        .catch(() => false),
      false,
      'cancellation during callback must withhold the prompt',
    );
  } finally {
    releaseCallback();
    await host.cancelAll().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('child exit during blocked onStarted remains cancellable and hands back the lease', async (t) => {
  const testName =
    'child exit during blocked onStarted remains cancellable and hands back the lease';
  if (!requiresIsolation(t, testName, ['systemdUserScope'])) return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-closed-callback-'));
  const executable = join(directory, 'fake-codex');
  const workerPidFile = join(directory, 'worker-pid');
  const host = new CodexHost({ executable });
  let enterCallback!: () => void;
  let releaseCallback!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterCallback = resolve;
  });
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let workerIdentity: { pid: number; startTicks: string } | undefined;
  let workerUnit: string | undefined;
  let handbacks = 0;
  try {
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(workerPidFile)}\nexec /usr/bin/sleep 1.5\n`,
    );
    await chmod(executable, 0o755);
    const starting = host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'must not arrive',
      limits: { timeoutMs: 10_000 },
      checkpoint: {
        cli: 'unused',
        job: 'closed-callback',
        issue: 'closed-callback',
        worktree: directory,
        intent: 'intent:0',
      },
      onStarted: async (sessionId) => {
        workerIdentity = await waitFor(async () => {
          try {
            const pid = Number((await readFile(workerPidFile, 'utf8')).trim());
            const startTicks = processStartTicks(pid);
            return startTicks ? { pid, startTicks } : undefined;
          } catch {
            return undefined;
          }
        });
        workerUnit = codexScopeUnit('closed-callback', sessionId);
        const membership = await readFile(
          `/proc/${workerIdentity.pid}/cgroup`,
          'utf8',
        );
        assert.ok(
          membership
            .split('\n')
            .some((line) => line.endsWith(`/${workerUnit}`)),
          'the exiting fixture must be inside its exact owned scope',
        );
        enterCallback();
        await callbackGate;
        return true;
      },
      onStartCancelled: async () => {
        handbacks += 1;
      },
    });
    const startingOutcome = starting.then(
      (session) => ({ status: 'fulfilled' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await Promise.race([
      entered,
      delay(5000).then(() => assert.fail('onStarted never became eligible')),
    ]);
    const identity = workerIdentity;
    const unit = workerUnit;
    assert.ok(identity && unit, 'the owned worker identity must be captured');
    await waitFor(async () =>
      processHasIdentity(identity.pid, identity.startTicks) ? undefined : true,
    );
    await waitFor(async () => (systemdScopeInactive(unit) ? true : undefined));
    await delay(1100);

    // Keep the callback blocked until cancelAll has completed, matching the
    // callback-gate contract while proving the worker itself already exited.
    await host.cancelAll();
    releaseCallback();
    const settled = await Promise.race([
      startingOutcome,
      delay(4000).then(() => undefined),
    ]);
    assert.ok(settled, 'close-during-callback cancellation must be bounded');
    if (settled.status !== 'rejected')
      assert.fail('a closed, cancelled startup must not return a session');
    assert.match(String(settled.error), /cancel/i);
    assert.equal(
      handbacks,
      1,
      'verified cleanup must hand back the bound lease',
    );
  } finally {
    releaseCallback();
    await host.cancelAll().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('traversal ControlGroup cannot supply a registration proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-traversal-'));
  const fakeBin = join(directory, 'bin');
  const systemctl = join(fakeBin, 'systemctl');
  const responseMarker = join(directory, 'manager-response');
  const unit = codexScopeUnit('traversal', 'session');
  const previousPath = process.env.PATH;
  const cgroupRoot = join(directory, 'owned-cgroup');
  const target = join(cgroupRoot, unit);
  const traversalPrefix = `/${relative('/sys/fs/cgroup', cgroupRoot)}`;
  try {
    await mkdir(target, { recursive: true });
    await mkdir(fakeBin);
    await writeFile(join(target, 'cgroup.procs'), `${process.pid}\n`);
    await writeFile(
      systemctl,
      `#!/bin/sh\nunit=''\nprevious=''\nfor argument do\n  if [ "$previous" = '--value' ]; then unit="$argument"; fi\n  previous="$argument"\ndone\nif [ "$unit" = ${JSON.stringify(unit)} ]; then\n  : > ${JSON.stringify(responseMarker)}\n  printf 'active\\n%s/%s\\n' ${JSON.stringify(traversalPrefix)} "$unit"\n  exit 0\nfi\nexec /usr/bin/systemctl "$@"\n`,
    );
    await chmod(systemctl, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    const startTicks = processStartTicks(process.pid);
    assert.ok(startTicks, 'the owned canary process must have a live identity');
    const structurallyValid = {
      unit,
      controlGroup: `/user.slice/user-${process.getuid?.() ?? 1000}.slice/user@${process.getuid?.() ?? 1000}.service/app.slice/${unit}`,
      pid: process.pid,
      startTicks,
    };
    assert.deepEqual(
      validateSystemdScopeRegistration(structurallyValid, unit),
      structurallyValid,
      'valid structural manager paths remain accepted',
    );
    const traversalControlGroup = `${traversalPrefix}/${unit}`;
    assert.equal(
      resolve('/sys/fs/cgroup', traversalControlGroup.slice(1)),
      target,
      'the malformed manager path resolves only to the owned temp canary',
    );
    assert.equal(
      (await readFile(join(target, 'cgroup.procs'), 'utf8')).trim(),
      String(process.pid),
      'the owned temp canary contains this live process',
    );
    await assert.rejects(
      waitForSystemdScopeRegistration(unit, () => false),
      /did not register a live process/u,
      'an owned temp cgroup.procs outside the cgroup root is not proof',
    );
    assert.equal(
      await readFile(responseMarker, 'utf8')
        .then(() => true)
        .catch(() => false),
      true,
      'the fake manager must return the malformed response',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelling a pending registration kills its owned launcher before callback or prompt', async (t) => {
  if (
    !requiresIsolation(
      t,
      'cancelling a pending registration kills its owned launcher before callback or prompt',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-pending-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(directory, 'fake-codex');
  const systemdRun = join(fakeBin, 'systemd-run');
  const launcherMarker = join(directory, 'launcher-pid');
  const unitMarker = join(directory, 'launcher-unit');
  const promptMarker = join(directory, 'prompt-delivered');
  const previousPath = process.env.PATH;
  const host = new CodexHost({ executable });
  let callbacks = 0;
  let launcherPid: number | undefined;
  let launchedUnit: string | undefined;
  try {
    await mkdir(fakeBin);
    await writeFile(
      systemdRun,
      `#!/bin/sh
previous=''
unit=''
for argument do
  if [ "$previous" = '--unit' ]; then unit="$argument"; fi
  previous="$argument"
done
case "$unit" in
  krn-pending-*) echo "$$" > ${JSON.stringify(launcherMarker)}; echo "$unit" > ${JSON.stringify(unitMarker)}; exec /usr/bin/sleep 30 ;;
esac
exec /usr/bin/systemd-run "$@"
`,
    );
    await writeFile(
      executable,
      `#!/bin/sh
IFS= read -r prompt || true
: > ${JSON.stringify(promptMarker)}
`,
    );
    await Promise.all(
      [systemdRun, executable].map((path) => chmod(path, 0o755)),
    );
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const starting = host
      .start({
        cwd: directory,
        model: 'gpt-6-luna',
        prompt: 'must not arrive',
        limits: { timeoutMs: 10_000 },
        checkpoint: {
          cli: 'unused',
          job: 'pending',
          issue: 'pending',
          worktree: directory,
          intent: 'intent:0',
        },
        onStarted: async () => {
          callbacks += 1;
          return true;
        },
      })
      .then(
        (session) => session.wait(),
        (error: unknown) => Promise.reject(error),
      );
    launcherPid = await waitFor(async () => {
      try {
        const pid = Number((await readFile(launcherMarker, 'utf8')).trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    });
    launchedUnit = (await readFile(unitMarker, 'utf8')).trim();
    const settled = await Promise.race([
      Promise.allSettled([starting, host.cancelAll()]),
      delay(4000).then(() => undefined),
    ]);
    assert.ok(settled, 'pending-launch cancellation must be bounded');
    const [startResult] = settled;
    assert.equal(
      startResult.status,
      'rejected',
      'cancelled startup must not return a session',
    );
    assert.equal(callbacks, 0, 'readiness cancellation must precede onStarted');
    assert.equal(
      await readFile(promptMarker, 'utf8')
        .then(() => true)
        .catch(() => false),
      false,
      'cancelled startup must not deliver the prompt',
    );
    assert.equal(
      await processIsAlive(launcherPid),
      false,
      'owned launcher must be reaped',
    );
    const after = spawnSync(
      '/usr/bin/systemctl',
      ['--user', 'show', launchedUnit, '-p', 'ActiveState', '--value'],
      { encoding: 'utf8', env: scopeEnvironment() },
    );
    assert.ok(
      after.status !== 0 || after.stdout.trim() === 'inactive',
      'a pending cancellation must drain any late exact-unit registration',
    );
  } finally {
    if (launcherPid && (await processIsAlive(launcherPid))) {
      try {
        process.kill(launcherPid, 'SIGKILL');
      } catch {}
    }
    await host.cancelAll().catch(() => undefined);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

function systemdScopeInactive(unit: string): boolean {
  const shown = spawnSync(
    '/usr/bin/systemctl',
    ['--user', 'show', unit, '--property=ActiveState', '--value'],
    { encoding: 'utf8', env: scopeEnvironment() },
  );
  return shown.status !== 0 || shown.stdout.trim() === 'inactive';
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail('timed out waiting for owned systemd-run launcher');
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
