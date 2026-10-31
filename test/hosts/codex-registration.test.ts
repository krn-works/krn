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
import { CodexHost } from '../../src/hosts/codex.ts';
import {
  codexScopeUnit,
  processHasIdentity,
  processStartTicks,
  systemdScopeActive,
  validateSystemdScopeRegistration,
  waitForSystemdScopeRegistration,
} from '../../src/hosts/systemd-scope.ts';
import {
  CONDITION_WAIT_MS,
  conditionTimeoutFor,
  waitForCondition as waitFor,
} from '../helpers/condition-wait.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import { systemdEnvironment } from '../helpers/systemd-environment.ts';

const scopeEnvironment = systemdEnvironment;

test('Codex onStarted waits for observed registration and persists live identity', {
  timeout: conditionTimeoutFor(1),
}, async (t) => {
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
  krn-registration-*) : > ${JSON.stringify(launchMarker)} ;;
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
      limits: { timeoutMs: 2 * CONDITION_WAIT_MS },
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
          ['--user', 'show', unit, '-p', 'ControlGroup', '--value'],
          { encoding: 'utf8', env: scopeEnvironment() },
        );
        if (shown.status === 0) {
          const controlGroup = shown.stdout.trim();
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

test('cancellation during onStarted cannot deliver a prompt or return a session', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
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
  let callbackEntered = false;
  let releaseCallback!: () => void;
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
      limits: { timeoutMs: 2 * CONDITION_WAIT_MS },
      checkpoint: {
        cli: 'unused',
        job: 'callback-cancel',
        issue: 'callback-cancel',
        worktree: directory,
        intent: 'intent:0',
      },
      onStarted: async () => {
        callbackEntered = true;
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
    let settledOutcome: Awaited<typeof startingOutcome> | undefined;
    void startingOutcome.then((outcome) => {
      settledOutcome = outcome;
    });
    await waitFor(
      async () => (callbackEntered ? true : undefined),
      'onStarted never became eligible',
    );
    await host.cancelAll();
    releaseCallback();
    const settled = await waitFor(
      async () => settledOutcome,
      'callback cancellation did not settle startup',
    );
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

test('child exit during blocked onStarted remains cancellable and hands back the lease', {
  timeout: conditionTimeoutFor(5),
}, async (t) => {
  const testName =
    'child exit during blocked onStarted remains cancellable and hands back the lease';
  if (!requiresIsolation(t, testName, ['systemdUserScope'])) return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-closed-callback-'));
  const executable = join(directory, 'fake-codex');
  const workerPidFile = join(directory, 'worker-pid');
  const host = new CodexHost({ executable });
  let callbackEntered = false;
  let releaseCallback!: () => void;
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let workerIdentity: { pid: number; startTicks: string } | undefined;
  let workerUnit: string | undefined;
  let handbacks = 0;
  try {
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(workerPidFile)}\nexec /usr/bin/cat\n`,
    );
    await chmod(executable, 0o755);
    const starting = host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'must not arrive',
      limits: { timeoutMs: 2 * CONDITION_WAIT_MS },
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
        }, 'the owned Codex worker identity was not observed');
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
        callbackEntered = true;
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
    let settledOutcome: Awaited<typeof startingOutcome> | undefined;
    void startingOutcome.then((outcome) => {
      settledOutcome = outcome;
    });
    await waitFor(
      async () => (callbackEntered ? true : undefined),
      'onStarted never became eligible',
    );
    const identity = workerIdentity;
    const unit = workerUnit;
    assert.ok(identity && unit, 'the owned worker identity must be captured');
    terminateFixtureWorker(identity.pid, identity.startTicks);
    await waitFor(
      async () =>
        processHasIdentity(identity.pid, identity.startTicks)
          ? undefined
          : true,
      'the owned worker did not exit after the test released it',
    );
    await waitFor(
      async () => (systemdScopeInactive(unit) ? true : undefined),
      'the exact worker scope did not become inactive',
    );

    // Keep the callback blocked until cancelAll has completed, matching the
    // callback-gate contract while proving the worker itself already exited.
    await host.cancelAll();
    releaseCallback();
    const settled = await waitFor(
      async () => settledOutcome,
      'close-during-callback cancellation did not settle startup',
    );
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

test('failed close verification retains an uncertain cancellation handle', {
  timeout: conditionTimeoutFor(3),
}, async (t) => {
  const testName =
    'failed close verification retains an uncertain cancellation handle';
  if (!requiresIsolation(t, testName, ['systemdUserScope'])) return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-failed-drain-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(directory, 'fake-codex');
  const systemctl = join(fakeBin, 'systemctl');
  const workerPidFile = join(directory, 'worker-pid');
  const unitFile = join(directory, 'owned-unit');
  const denyFile = join(directory, 'deny-owned-unit');
  const previousPath = process.env.PATH;
  const host = new CodexHost({ executable });
  let workerIdentity: { pid: number; startTicks: string } | undefined;
  let workerUnit: string | undefined;
  let callbackEntered = false;
  let releaseCallback!: () => void;
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let handbacks = 0;
  try {
    await mkdir(fakeBin);
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(workerPidFile)}\nexec /usr/bin/cat\n`,
    );
    await writeFile(
      systemctl,
      `#!/bin/sh
unit=''
for argument do
  case "$argument" in krn-*.scope) unit="$argument" ;; esac
done
if [ -f ${JSON.stringify(denyFile)} ] &&
   [ "$unit" = "$(/usr/bin/cat ${JSON.stringify(unitFile)})" ]; then
  printf 'synthetic manager verification failure\\n' >&2
  exit 1
fi
exec /usr/bin/systemctl "$@"
`,
    );
    await Promise.all(
      [executable, systemctl].map((path) => chmod(path, 0o755)),
    );
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    const starting = host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'must not arrive',
      limits: { timeoutMs: 2 * CONDITION_WAIT_MS },
      checkpoint: {
        cli: 'unused',
        job: 'failed-drain',
        issue: 'failed-drain',
        worktree: directory,
        intent: 'intent:0',
      },
      onStarted: async (sessionId) => {
        workerUnit = codexScopeUnit('failed-drain', sessionId);
        workerIdentity = await waitFor(async () => {
          const value = await readFile(workerPidFile, 'utf8').catch(() => '');
          const pid = Number(value.trim());
          const startTicks = processStartTicks(pid);
          return startTicks ? { pid, startTicks } : undefined;
        }, 'the failed-close worker PID file and live process identity');
        const { pid, startTicks } = workerIdentity;
        const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
        assert.ok(
          membership
            .split('\n')
            .some((line) => line.endsWith(`/${workerUnit}`)),
          'the worker must be physically registered in its exact owned scope',
        );
        terminateFixtureWorker(pid, startTicks);
        await waitFor(
          async () => (processHasIdentity(pid, startTicks) ? undefined : true),
          'the owned worker did not exit after the test released it',
        );
        await writeFile(unitFile, `${workerUnit}\n`);
        await writeFile(denyFile, 'deny exact owned unit\n');
        callbackEntered = true;
        await callbackGate;
        throw new Error('injected onStarted failure after worker exit');
      },
      onStartCancelled: async () => {
        handbacks += 1;
      },
    });
    const startingOutcome = starting.then(
      (session) => ({ status: 'fulfilled' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    let settledOutcome: Awaited<typeof startingOutcome> | undefined;
    void startingOutcome.then((outcome) => {
      settledOutcome = outcome;
    });
    await waitFor(
      async () => (callbackEntered ? true : undefined),
      'onStarted never reached its gate',
    );
    releaseCallback();
    const settled = await waitFor(
      async () => settledOutcome,
      'failed cleanup did not settle startup',
    );
    if (settled.status !== 'rejected')
      assert.fail('startup must reject when exact-unit drain is unverified');
    assert.ok(
      settled.error instanceof AggregateError,
      'startup must report both callback and cleanup failure',
    );
    assert.equal(
      handbacks,
      0,
      'an uncertain drain must not acknowledge lease handback',
    );
    await assert.rejects(
      host.cancelAll(),
      (error: unknown) => error instanceof AggregateError,
      'a later cancellation must not become a successful no-op',
    );
  } finally {
    releaseCallback();
    await rm(denyFile, { force: true });
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (
      workerIdentity &&
      processHasIdentity(workerIdentity.pid, workerIdentity.startTicks)
    ) {
      try {
        process.kill(workerIdentity.pid, 'SIGKILL');
      } catch {}
    }
    if (workerUnit) {
      spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', workerUnit],
        { encoding: 'utf8', env: scopeEnvironment() },
      );
    }
    await host.cancelAll().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('named scope properties classify captured orders and fail closed on malformed output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-systemd-status-'));
  const fakeBin = join(directory, 'bin');
  const systemctl = join(fakeBin, 'systemctl');
  const stateFile = join(directory, 'active-state');
  const unit = 'krn-status-fixture.scope';
  const previousPath = process.env.PATH;
  try {
    await mkdir(fakeBin);
    await writeFile(
      systemctl,
      `#!/bin/sh
unit=''
for argument do
  case "$argument" in krn-*.scope) unit="$argument" ;; esac
done
if [ "$unit" = ${JSON.stringify(unit)} ]; then
  /usr/bin/cat ${JSON.stringify(stateFile)}
  exit 0
fi
exec /usr/bin/systemctl "$@"
`,
    );
    await chmod(systemctl, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    const capturedActiveControlGroupFirst =
      'ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/krn-status-fixture.scope\nActiveState=active\n';
    await writeFile(stateFile, capturedActiveControlGroupFirst);
    assert.equal(
      systemdScopeActive(unit),
      true,
      'captured systemd 257 property order keeps a live scope active',
    );
    await writeFile(
      stateFile,
      'ActiveState=active\nControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/krn-status-fixture.scope\n',
    );
    assert.equal(
      systemdScopeActive(unit),
      true,
      'the other named property order also keeps a live scope active',
    );
    await writeFile(stateFile, 'ControlGroup=\nActiveState=inactive\n');
    assert.equal(
      systemdScopeActive(unit),
      false,
      'captured post-GC output preserves an empty ControlGroup value',
    );
    await writeFile(stateFile, 'ControlGroup=\nActiveState=deactivating\n');
    assert.equal(
      systemdScopeActive(unit),
      null,
      'a transitional state without a cgroup is not proof of inactivity',
    );
    for (const malformed of [
      'ActiveState=inactive\n',
      'ControlGroup=\nActiveState=inactive\nControlGroup=\n',
      'ControlGroup=\nActiveState=inactive\nOther=value\n',
    ]) {
      await writeFile(stateFile, malformed);
      assert.equal(
        systemdScopeActive(unit),
        null,
        `malformed named scope properties remain unknown: ${malformed}`,
      );
    }
    await writeFile(stateFile, 'ControlGroup=\nActiveState=failed\n');
    assert.equal(systemdScopeActive(unit), false, 'known failed remains false');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration observer bounds synthetic cgroup membership bytes and PID scans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cgroup-budget-'));
  const fakeBin = join(directory, 'bin');
  const systemctl = join(fakeBin, 'systemctl');
  const unit = 'krn-bounded-observer-fixture.scope';
  const controlGroup = `/user.slice/user-${process.getuid?.() ?? 1000}.slice/user@${process.getuid?.() ?? 1000}.service/app.slice/${unit}`;
  const previousPath = process.env.PATH;
  try {
    await mkdir(fakeBin);
    await writeFile(
      systemctl,
      `#!/bin/sh
unit=''
for argument do
  case "$argument" in krn-*.scope) unit="$argument" ;; esac
done
if [ "$unit" = ${JSON.stringify(unit)} ]; then
  printf 'ControlGroup=%s\\nActiveState=active\\n' ${JSON.stringify(controlGroup)}
  exit 0
fi
exec /usr/bin/systemctl "$@"
`,
    );
    await chmod(systemctl, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    const observerUrl = new URL(
      '../../src/hosts/systemd-scope.ts',
      import.meta.url,
    ).href;
    const childSource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const observerUrl = ${JSON.stringify(observerUrl)};
const virtualPath = ${JSON.stringify(`/sys/fs/cgroup${controlGroup}/cgroup.procs`)};
const virtualFd = 2147483000;
const stats = { membershipBytes: 0, pidStatReads: 0 };
let membership = '';
let virtualOffset = 0;
const original = {
  readFileSync: fs.readFileSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
};
const pathText = (path) =>
  typeof path === 'string' ? path : path.toString();
fs.readFileSync = (path, options) => {
  const filename = pathText(path);
  if (filename === virtualPath) {
    stats.membershipBytes += Buffer.byteLength(membership);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? membership : Buffer.from(membership);
  }
  if (/^\\/proc\\/\\d+\\/stat$/u.test(filename)) stats.pidStatReads += 1;
  return original.readFileSync(path, options);
};
fs.openSync = (path, ...args) => {
  if (pathText(path) === virtualPath) {
    virtualOffset = 0;
    return virtualFd;
  }
  return original.openSync(path, ...args);
};
fs.readSync = (fd, buffer, offset, length, position) => {
  if (fd !== virtualFd)
    return original.readSync(fd, buffer, offset, length, position);
  const bytes = Buffer.from(membership);
  const start = position ?? virtualOffset;
  const count = bytes.copy(
    buffer,
    offset,
    start,
    Math.min(start + length, bytes.length),
  );
  virtualOffset = start + count;
  stats.membershipBytes += count;
  return count;
};
fs.closeSync = (fd) => fd === virtualFd ? undefined : original.closeSync(fd);
syncBuiltinESMExports();
const { waitForSystemdScopeRegistration } = await import(observerUrl);
const unit = ${JSON.stringify(unit)};
const byteBudget = 16 * 1024 + 2;
const pidBudget = 256;
membership = Array.from({ length: 3000 }, () => '99999999').join('\\n') + '\\n' + process.pid + '\\n';
const oversized = await waitForSystemdScopeRegistration(unit, () => stats.membershipBytes > 0)
  .then(() => 'accepted', () => 'refused');
if (oversized !== 'refused') throw new Error('oversized synthetic membership was accepted');
if (stats.membershipBytes <= 0 || stats.membershipBytes > byteBudget)
  throw new Error('membership read exceeded 16 KiB plus two overflow bytes: ' + stats.membershipBytes);
if (stats.pidStatReads > pidBudget)
  throw new Error('PID identity scan exceeded 256 candidates: ' + stats.pidStatReads);
stats.membershipBytes = 0;
stats.pidStatReads = 0;
membership = process.pid + '\\n';
const small = await waitForSystemdScopeRegistration(unit, () => false);
if (small.pid !== process.pid || small.unit !== unit)
  throw new Error('honest one-PID synthetic control was not supported');
console.log(JSON.stringify({ oversized, smallPid: small.pid }));
`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${previousPath ?? ''}` },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const outcome = JSON.parse(result.stdout) as {
      readonly oversized: string;
      readonly smallPid: number;
    };
    assert.equal(outcome.oversized, 'refused');
    assert.ok(Number.isSafeInteger(outcome.smallPid) && outcome.smallPid > 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
      `#!/bin/sh\nunit=''\nfor argument do\n  case "$argument" in krn-*.scope) unit="$argument" ;; esac\ndone\nif [ "$unit" = ${JSON.stringify(unit)} ]; then\n  : > ${JSON.stringify(responseMarker)}\n  printf 'ControlGroup=%s/%s\\nActiveState=active\\n' ${JSON.stringify(traversalPrefix)} "$unit"\n  exit 0\nfi\nexec /usr/bin/systemctl "$@"\n`,
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

test('cancelling a pending registration kills its owned launcher before callback or prompt', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
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
  krn-pending-*) echo "$$" > ${JSON.stringify(launcherMarker)}; echo "$unit" > ${JSON.stringify(unitMarker)}; exec /usr/bin/cat ;;
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
        limits: { timeoutMs: 2 * CONDITION_WAIT_MS },
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
    }, 'owned systemd-run launcher was not observed');
    launchedUnit = await waitFor(
      async () =>
        (await readFile(unitMarker, 'utf8').catch(() => '')).trim() ||
        undefined,
      'the owned systemd-run launcher unit marker',
    );
    let settledOutcome:
      | [
          PromiseSettledResult<Awaited<typeof starting>>,
          PromiseSettledResult<void>,
        ]
      | undefined;
    void Promise.allSettled([starting, host.cancelAll()]).then((outcome) => {
      settledOutcome = outcome;
    });
    const settled = await waitFor(
      async () => settledOutcome,
      'pending-launch cancellation did not settle',
    );
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

function terminateFixtureWorker(pid: number, startTicks: string): void {
  if (!processHasIdentity(pid, startTicks)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
