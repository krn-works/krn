import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requiresIsolation } from '../helpers/isolation.ts';

test('onStarted rejection waits for the fake Codex process tree to stop', async (t) => {
  const testName =
    'onStarted rejection waits for the fake Codex process tree to stop';
  if (!requiresIsolation(t, testName, ['systemdUserScope'])) return;
  const hostModule = await import('../../src/hosts/codex.ts').catch(
    () => undefined,
  );
  assert.ok(
    hostModule && 'CodexHost' in hostModule,
    'Codex host must expose cancellable sessions',
  );

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-onstarted-'));
  const pidFile = join(directory, 'pids');
  const executable = join(directory, 'fake-codex');
  const host = new hostModule.CodexHost({ executable });
  const callbackError = new Error('onStarted rejected');
  let observedPids: number[] | undefined;
  let cancellationAcknowledged = false;
  try {
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$$" > "${pidFile}"\n/bin/sleep 15 &\nprintf '%s\\n' "$!" >> "${pidFile}"\nwait\n`,
    );
    await chmod(executable, 0o755);

    const startInput = Object.assign(
      {
        cwd: directory,
        model: 'gpt-6-luna' as const,
        prompt: 'wait',
        limits: { timeoutMs: 30_000 },
        onStarted: async (
          _sessionId: string,
          _pgid?: number,
          isolation?: string,
        ) => {
          assert.equal(isolation, 'systemd_scope');
          const pids = await waitFor(async () => {
            try {
              const lines = (await readFile(pidFile, 'utf8'))
                .trim()
                .split('\n');
              if (lines.length !== 2) return undefined;
              const values = lines.map(Number);
              return values.every((pid) => Number.isSafeInteger(pid) && pid > 0)
                ? values
                : undefined;
            } catch {
              return undefined;
            }
          });
          observedPids = pids;
          assert.deepEqual(
            await Promise.all(pids.map(isAlive)),
            [true, true],
            'the launcher and descendant must exist before onStarted rejects',
          );
          throw callbackError;
        },
      },
      {
        onStartCancelled: async (sessionId: string) => {
          assert.ok(
            sessionId,
            'acknowledgement identifies the cancelled session',
          );
          const pids = observedPids;
          assert.ok(pids, 'the owned fixture PIDs must be captured');
          assert.deepEqual(
            await Promise.all(pids.map(isAlive)),
            [false, false],
            'cancellation acknowledgement must follow verified process cleanup',
          );
          cancellationAcknowledged = true;
        },
      },
    );
    await assert.rejects(
      host.start(startInput),
      (error) => error === callbackError,
    );
    assert.equal(cancellationAcknowledged, true);

    const pids = observedPids;
    assert.ok(pids, 'onStarted must capture both fixture PIDs');
    await waitFor(async () => {
      const alive = await Promise.all(pids.map(isAlive));
      return alive.every((running) => !running) ? alive : undefined;
    }, 'CodexHost.start must reject only after both owned fixture processes stop');
  } finally {
    try {
      await host.cancelAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('startup cancellation failure does not acknowledge lease handback', async (t) => {
  if (
    !requiresIsolation(
      t,
      'startup cancellation failure does not acknowledge lease handback',
      ['systemdUserScope'],
    )
  )
    return;
  const hostModule = await import('../../src/hosts/codex.ts');
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-cancel-failure-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(directory, 'fake-codex');
  const systemdRun = join(fakeBin, 'systemd-run');
  const systemctl = join(fakeBin, 'systemctl');
  const callbackMarker = join(directory, 'callback-called');
  const pidFile = join(directory, 'pids');
  const host = new hostModule.CodexHost({ executable });
  const callbackError = new Error('onStarted rejected');
  const previousPath = process.env.PATH;
  let pids: number[] | undefined;
  let acknowledgements = 0;
  try {
    await mkdir(fakeBin);
    await writeFile(
      systemdRun,
      `#!/bin/sh
exec /usr/bin/systemd-run "$@"
`,
    );
    await writeFile(
      systemctl,
      `#!/bin/sh
case "$*" in
  *list-units*) printf "[]\\n" ;;
  *" show "*)
    if [ -e "${callbackMarker}" ]; then echo "fake verification unavailable" >&2; exit 1; fi
    exec /usr/bin/systemctl "$@" ;;
  *) exec /usr/bin/systemctl "$@" ;;
esac
`,
    );
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$$" > "${pidFile}"
/bin/sleep 30 &
printf '%s\\n' "$!" >> "${pidFile}"
wait
`,
    );
    await Promise.all(
      [systemdRun, systemctl, executable].map((path) => chmod(path, 0o755)),
    );
    process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${previousPath ?? ''}`;
    const startInput = Object.assign(
      {
        cwd: directory,
        model: 'gpt-6-luna' as const,
        prompt: 'wait',
        limits: { timeoutMs: 30_000 },
        onStarted: async () => {
          await writeFile(callbackMarker, 'called');
          pids = await waitFor(async () => {
            try {
              const values = (await readFile(pidFile, 'utf8'))
                .trim()
                .split('\n')
                .map(Number);
              return values.length === 2 && values.every((pid) => pid > 0)
                ? values
                : undefined;
            } catch {
              return undefined;
            }
          });
          throw callbackError;
        },
      },
      {
        onStartCancelled: async () => {
          acknowledgements += 1;
        },
      },
    );
    await assert.rejects(host.start(startInput), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], callbackError);
      assert.match(error.message, /cancellation could not be verified/);
      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    const ownedPids = pids;
    if (ownedPids) {
      for (const pid of ownedPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await waitFor(async () =>
        (await Promise.all(ownedPids.map(isAlive))).every((alive) => !alive),
      ).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(acknowledgements, 0);
});

test('timeout cleanup verification failure reaches wait without an unhandled rejection', {
  timeout: 20_000,
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'timeout cleanup verification failure reaches wait without an unhandled rejection',
      ['systemdUserScope'],
    )
  )
    return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-timeout-cleanup-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(directory, 'fake-codex');
  const systemctl = join(fakeBin, 'systemctl');
  const registrationPath = join(directory, 'registration.json');
  const waitPath = join(directory, 'wait.json');
  const failUnit = join(directory, 'fail-unit');
  const failureLog = join(directory, 'show-failures');
  const systemdEnv = { ...process.env };
  systemdEnv.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.() ?? 1000}`;
  systemdEnv.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${systemdEnv.XDG_RUNTIME_DIR}/bus`;
  const childModuleUrl = pathToFileURL(
    join(process.cwd(), 'src/hosts/codex.ts'),
  ).href;
  let registration:
    | {
        sessionId: string;
        isolation: string;
        unit: string;
        controlGroup: string;
        pid: number;
        startTicks: string;
        processState: string;
      }
    | undefined;
  try {
    await mkdir(fakeBin);
    await writeFile(
      executable,
      `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
    );
    await writeFile(
      systemctl,
      `#!/bin/sh
if [ "$1" = "--user" ] && [ "$2" = "show" ]; then
  for arg in "$@"; do case "$arg" in krn-*.scope) unit="$arg";; esac; done
  expected=$(cat "$KRN_F2_FAIL_UNIT_FILE" 2>/dev/null)
  if [ -n "$expected" ] && [ "$unit" = "$expected" ]; then
    printf "%s\\n" "$unit" >> "$KRN_F2_FAILURE_LOG"
    printf "injected registered-scope verification failure\\n" >&2
    exit 42
  fi
fi
exec /usr/bin/systemctl "$@"
`,
    );
    await Promise.all(
      [executable, systemctl].map((path) => chmod(path, 0o755)),
    );
    const childSource = `
import { readFileSync, writeFileSync } from 'node:fs';
const { CodexHost } = await import(process.env.KRN_F2_MODULE_URL);
const host = new CodexHost({ executable: process.env.KRN_F2_CODEX });
const session = await host.start({
  cwd: process.env.KRN_F2_CWD,
  model: 'gpt-6-luna',
  prompt: 'hold until timeout cancellation',
  limits: { timeoutMs: 650 },
  onStarted: async (sessionId, _pid, isolation, registration) => {
    if (isolation !== 'systemd_scope' || !registration) throw new Error('scope registration missing');
    const raw = readFileSync('/proc/' + registration.pid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\\s+/u);
    const members = readFileSync('/sys/fs/cgroup/' + registration.controlGroup.slice(1) + '/cgroup.procs', 'utf8').trim().split(/\\s+/u).map(Number);
    if (fields[19] !== registration.startTicks || !members.includes(registration.pid)) throw new Error('registered process identity not in cgroup');
    writeFileSync(process.env.KRN_F2_REGISTRATION_FILE, JSON.stringify({sessionId, isolation, ...registration, processState: fields[0]}));
    writeFileSync(process.env.KRN_F2_FAIL_UNIT_FILE, registration.unit + '\\n');
    return true;
  },
});
const outcome = await session.wait().then(
  (result) => ({kind: 'resolved', result}),
  (error) => ({kind: 'rejected', errorName: error?.name ?? typeof error, errorMessage: String(error?.message ?? error)}),
);
writeFileSync(process.env.KRN_F2_WAIT_FILE, JSON.stringify(outcome));
process.stdout.write('WAIT_RESULT ' + JSON.stringify(outcome) + '\\n');
await new Promise((resolve) => setTimeout(resolve, 800));
`;
    const childEnv = {
      ...systemdEnv,
      KRN_F2_MODULE_URL: childModuleUrl,
      KRN_F2_CODEX: executable,
      KRN_F2_CWD: directory,
      KRN_F2_REGISTRATION_FILE: registrationPath,
      KRN_F2_WAIT_FILE: waitPath,
      KRN_F2_FAIL_UNIT_FILE: failUnit,
      KRN_F2_FAILURE_LOG: failureLog,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    };
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closePromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 18_000);
    const close = await closePromise;
    clearTimeout(watchdog);
    registration = await readFile(registrationPath, 'utf8')
      .then((raw) => JSON.parse(raw) as NonNullable<typeof registration>)
      .catch(() => undefined);
    const waitResult = await readFile(waitPath, 'utf8')
      .then(
        (raw) =>
          JSON.parse(raw) as {
            kind: string;
            errorName?: string;
            errorMessage?: string;
          },
      )
      .catch(() => undefined);
    const injectedFailures = (
      await readFile(failureLog, 'utf8').catch(() => '')
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    t.diagnostic(
      JSON.stringify({
        close,
        timedOut,
        registration,
        waitResult,
        injectedFailures,
        stdout,
        stderr,
      }),
    );
    assert.equal(timedOut, false);
    assert.ok(
      registration,
      'the actual test-owned systemd scope registration was recorded',
    );
    const verifiedRegistration = registration;
    assert.equal(verifiedRegistration.isolation, 'systemd_scope');
    assert.equal(close.signal, null);
    assert.equal(
      close.code,
      0,
      `cancellation must be joined rather than crash Node: ${stderr}`,
    );
    assert.equal(waitResult?.kind, 'rejected');
    assert.deepEqual(injectedFailures, [verifiedRegistration.unit]);
    assert.ok(
      Number.isSafeInteger(verifiedRegistration.pid) &&
        verifiedRegistration.pid > 0,
    );
    assert.match(verifiedRegistration.startTicks, /^\d+$/u);
    assert.ok(!['Z', 'X'].includes(verifiedRegistration.processState));
  } finally {
    const ownedRegistration = registration;
    if (ownedRegistration) {
      spawnSync(
        '/usr/bin/systemctl',
        [
          '--user',
          'kill',
          '--kill-who=all',
          '--signal=SIGKILL',
          ownedRegistration.unit,
        ],
        { encoding: 'utf8', timeout: 5000, env: systemdEnv },
      );
      spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'stop', ownedRegistration.unit],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: systemdEnv,
        },
      );
      const physicalCleanup = await waitFor(async () => {
        const stat = await readFile(
          `/proc/${ownedRegistration.pid}/stat`,
          'utf8',
        )
          .then((raw) => {
            const fields = raw
              .slice(raw.lastIndexOf(')') + 2)
              .trim()
              .split(/\s+/u);
            return { state: fields[0], startTicks: fields[19] };
          })
          .catch(() => undefined);
        const shown = spawnSync(
          '/usr/bin/systemctl',
          [
            '--user',
            'show',
            '--property=ActiveState',
            '--property=ControlGroup',
            '--value',
            ownedRegistration.unit,
          ],
          { encoding: 'utf8', timeout: 5000, env: systemdEnv },
        );
        const [active = '', controlGroup = ''] = shown.stdout
          .trimEnd()
          .split(/\r?\n/u);
        const members = controlGroup.startsWith('/')
          ? await readFile(
              join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs'),
              'utf8',
            )
              .then((raw) => raw.trim().split(/\s+/u).filter(Boolean))
              .catch(() => [])
          : [];
        const processGone =
          !stat ||
          stat.startTicks !== ownedRegistration.startTicks ||
          stat.state === 'Z' ||
          stat.state === 'X';
        const scopeGone =
          shown.status !== 0 ||
          (['inactive', 'failed'].includes(active) && members.length === 0);
        return processGone && scopeGone
          ? {
              unit: ownedRegistration.unit,
              pid: ownedRegistration.pid,
              processGone,
              scopeGone,
            }
          : undefined;
      }, 'the exact registered Codex scope and PID must be physically gone');
      t.diagnostic(
        JSON.stringify({
          result: 'F2_VERIFIED',
          registration: ownedRegistration,
          injectedFailures: (await readFile(failureLog, 'utf8'))
            .trim()
            .split(/\r?\n/u),
          physicalCleanup,
        }),
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation kills the Codex process tree and keeps the session identity', async (t) => {
  if (
    !requiresIsolation(
      t,
      'cancellation kills the Codex process tree and keeps the session identity',
      ['systemdUserScope'],
    )
  )
    return;
  const hostModule = await import('../../src/hosts/codex.ts').catch(
    () => undefined,
  );
  assert.ok(
    hostModule && 'CodexHost' in hostModule,
    'Codex host must expose cancellable sessions',
  );

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-cancel-'));
  try {
    const initialized = spawnSync('git', ['-C', directory, 'init', '-q']);
    assert.equal(initialized.status, 0);
    const pidFile = join(directory, 'pids');
    const executable = join(directory, 'fake-codex');
    const source = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } }) + '\\n');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n' + String(child.pid));
});
setInterval(() => {}, 1000);
`;
    await writeFile(executable, source);
    await chmod(executable, 0o755);

    const host = new hostModule.CodexHost({ executable });
    let startupCancellationNotifications = 0;
    const session = await host.start(
      Object.assign(
        {
          cwd: directory,
          model: 'gpt-6-luna' as const,
          prompt: 'wait',
          limits: { timeoutMs: 10_000 },
        },
        {
          onStartCancelled: async () => {
            startupCancellationNotifications += 1;
          },
        },
      ),
    );
    const identity = session.id;
    const pids = await waitFor(async () => {
      try {
        const lines = (await readFile(pidFile, 'utf8')).trim().split('\n');
        return lines.length === 2 ? lines.map(Number) : undefined;
      } catch {
        return undefined;
      }
    });

    await host.cancelTree(identity);
    assert.equal(startupCancellationNotifications, 0);
    const result = await session.wait();
    assert.equal(result.sessionId, identity);
    assert.equal(result.threadId, 'thread-123');
    assert.deepEqual(result.usage, {
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
    });
    await waitFor(async () =>
      (await Promise.all(pids.map(isAlive))).every((alive) => !alive),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMessage = 'timed out waiting for the fake Codex process tree',
): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(timeoutMessage);
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
