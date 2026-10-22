import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLedger } from '../../src/ledger/index.ts';
import {
  loadLiveContract,
  withLiveSubmissionGate,
} from '../../src/ledger/live.ts';
import { createPaperclipCliTransport } from '../../src/ledger/paperclip-cli.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  SPAWNED_PROCESS_WAIT_MS,
  testTimeoutFor,
} from '../support/process-wait.ts';

const issue = {
  id: 'ca71eba4-3f82-4a19-acc8-7bbae1315e58',
  identifier: 'LON-200',
  title: 'CLI transport fixture',
  description:
    '```krn-contract\n{"version":1,"targetRepo":"krn-works/krn","checks":["gate"]}\n```',
  updatedAt: '2026-10-08T10:00:00.000Z',
  status: 'in_progress',
  secret: 'must-not-escape-parser',
};

async function fakeCli() {
  const directory = await mkdtemp(join(tmpdir(), 'krn-paperclip-cli-'));
  const capture = join(directory, 'capture.json');
  const executable = join(directory, 'paperclip');
  return { directory, capture, executable };
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`process ${pid} survived best-effort cleanup`);
}

test('readContract uses CLI JSON without KRN credentials and default reads never update', async (t) => {
  if (
    !requiresIsolation(
      t,
      'readContract uses CLI JSON without KRN credentials and default reads never update',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  // Embed the capture path after creation so the fake executable stays isolated.
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(fake.capture)}, JSON.stringify({args, env: Object.keys(process.env)}) + '\\n');\nprocess.stdout.write(JSON.stringify(${JSON.stringify(issue)}));\n`,
  );
  await chmod(fake.executable, 0o755);
  const originalPath = process.env.PATH;
  const originalPaperclip = process.env.PAPERCLIP_TEST_CONTEXT;
  const originalKrn = process.env.KRN_PAPERCLIP_TOKEN;
  process.env.PATH = `${fake.directory}:${originalPath ?? ''}`;
  process.env.PAPERCLIP_TEST_CONTEXT = 'board-context';
  process.env.KRN_PAPERCLIP_TOKEN = 'must-not-be-forwarded';
  try {
    const ledger = createLedger({
      session: '',
      transport: createPaperclipCliTransport(),
    });
    const live = await loadLiveContract(ledger, 'LON-200', {
      origin: 'git@github.com:krn-works/krn.git',
    });
    assert.deepEqual(live.contract, {
      issueId: 'LON-200',
      identifier: 'LON-200',
      title: issue.title,
      description: issue.description,
      revision: issue.updatedAt,
      targetRepo: 'krn-works/krn',
      checks: ['gate'],
    });
    assert.equal(
      await withLiveSubmissionGate(ledger, false).submitForReview(
        { id: 'live', issue: 'LON-200', worktree: process.cwd() },
        live.contract,
        {
          kind: 'verdict_pass',
          sha: 'a'.repeat(40),
          checks: [
            { id: 'gate', exitCode: 0, durationMs: 1, sha256: 'b'.repeat(64) },
          ],
        },
        'a'.repeat(40),
      ),
      'ready_for_review',
    );
    const calls = (await readFile(fake.capture, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; env: string[] });
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.deepEqual(call.args, ['issue', 'get', 'LON-200', '--json']);
    assert.ok(calls[0]?.env.includes('PAPERCLIP_TEST_CONTEXT'));
    assert.ok(!calls[0]?.env.includes('KRN_PAPERCLIP_TOKEN'));
    assert.ok(calls.every((call) => !call.args.includes('-c')));
    assert.ok(calls.every((call) => !call.args.includes('sh')));
    assert.ok(calls.every((call) => !call.args.includes('update')));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPaperclip === undefined)
      delete process.env.PAPERCLIP_TEST_CONTEXT;
    else process.env.PAPERCLIP_TEST_CONTEXT = originalPaperclip;
    if (originalKrn === undefined) delete process.env.KRN_PAPERCLIP_TOKEN;
    else process.env.KRN_PAPERCLIP_TOKEN = originalKrn;
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI reads parse stdout JSON when stderr contains a warning', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI reads parse stdout JSON when stderr contains a warning',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nprocess.stderr.write('warning: deprecated option\\n');\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    let value: unknown;
    try {
      value = await createPaperclipCliTransport({
        executable: fake.executable,
      }).readIssue('LON-200');
    } catch {
      value = undefined;
    }
    assert.equal(
      (value as { id?: string } | undefined)?.id,
      'LON-200',
      'valid stdout JSON must be parsed despite a stderr warning',
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI failures include stderr details without forwarded credentials', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI failures include stderr details without forwarded credentials',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  const token = 'paperclip-test-token-for-redaction';
  const originalToken = process.env.PAPERCLIP_AUTH_TOKEN;
  try {
    process.env.PAPERCLIP_AUTH_TOKEN = token;
    await writeFile(
      fake.executable,
      `#!/usr/bin/env node\nprocess.stderr.write('request failed with ${token}');\nprocess.exitCode = 2;\n`,
    );
    await chmod(fake.executable, 0o755);
    let message = '';
    try {
      await createPaperclipCliTransport({
        executable: fake.executable,
      }).readIssue('LON-200');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /request failed/u);
    assert.equal(message.includes(token), false);
  } finally {
    if (originalToken === undefined) delete process.env.PAPERCLIP_AUTH_TOKEN;
    else process.env.PAPERCLIP_AUTH_TOKEN = originalToken;
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI update carries status and comment in one argv-safe invocation', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI update carries status and comment in one argv-safe invocation',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(fake.capture)}, JSON.stringify(args));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    const comment = 'review $HOME; $(must stay one argument)';
    const transport = createPaperclipCliTransport({
      executable: fake.executable,
    });
    const receipt = await transport.updateIssue(
      'LON-200',
      'in_review',
      comment,
    );
    assert.equal((receipt as { id: string }).id, 'LON-200');
    const args = JSON.parse(await readFile(fake.capture, 'utf8')) as string[];
    assert.deepEqual(args, [
      'issue',
      'update',
      'LON-200',
      '--status',
      'in_review',
      '--comment',
      comment,
      '--json',
    ]);
    assert.ok(transport.createComment);
    await transport.createComment('LON-200', comment);
    const commentArgs = JSON.parse(
      await readFile(fake.capture, 'utf8'),
    ) as string[];
    assert.deepEqual(commentArgs, [
      'issue',
      'update',
      'LON-200',
      '--comment',
      comment,
      '--json',
    ]);
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI activity conflicts use the read-only issue activity command', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI activity conflicts use the read-only issue activity command',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify(args));\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    assert.deepEqual(
      await createPaperclipCliTransport({
        executable: fake.executable,
      }).readActivity('LON-200'),
      ['activity', 'issue', 'LON-200', '--json'],
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI submit reconciles its own update and comment activity without a conflict write', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI submit reconciles its own update and comment activity without a conflict write',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(fake.capture)};
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { status: 'in_progress', updatedAt: ${JSON.stringify(issue.updatedAt)}, events: [], writes: 0, reads: 0 };
if (args[0] === 'issue' && args[1] === 'get') {
  state.reads++;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ ...${JSON.stringify(issue)}, status: state.status, updatedAt: state.updatedAt }));
} else if (args[0] === 'activity' && args[1] === 'issue') {
  process.stdout.write(JSON.stringify(state.events));
} else if (args[0] === 'issue' && args[1] === 'update') {
  const comment = args[args.indexOf('--comment') + 1];
  state.writes++;
  state.status = 'in_review';
  state.updatedAt = new Date().toISOString();
  state.events.push(
    { id: 'update-1', action: 'issue.updated', entityId: ${JSON.stringify(issue.id)}, createdAt: state.updatedAt, details: { changes: { status: { from: 'in_progress', to: 'in_review' } } } },
    { id: 'comment-1', action: 'issue.commented', entityId: ${JSON.stringify(issue.id)}, createdAt: state.updatedAt, details: { body: comment } }
  );
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ ...${JSON.stringify(issue)}, status: state.status, updatedAt: state.updatedAt }));
} else {
  process.stderr.write('unexpected fake Paperclip command: ' + args.join(' '));
  process.exit(2);
}
`,
  );
  await chmod(fake.executable, 0o755);
  try {
    const ledger = createLedger({
      session: 'session-from-trailer',
      transport: createPaperclipCliTransport({ executable: fake.executable }),
    });
    const contract = await ledger.readContract(issue.id);
    assert.equal(
      await ledger.submitForReview(
        { id: 'cli-submit', issue: issue.id, worktree: process.cwd() },
        contract,
        {
          kind: 'verdict_pass',
          sha: 'a'.repeat(40),
          checks: [
            { id: 'gate', exitCode: 0, durationMs: 1, sha256: 'b'.repeat(64) },
          ],
        },
        'a'.repeat(40),
      ),
      'submitted',
    );
    const state = JSON.parse(await readFile(fake.capture, 'utf8')) as {
      writes: number;
    };
    assert.equal(state.writes, 1);
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI submit reconciliation reads issue comments with JSON output', async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI submit reconciliation reads issue comments with JSON output',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify(args));\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    assert.deepEqual(
      await createPaperclipCliTransport({
        executable: fake.executable,
      }).readComments('LON-200'),
      ['issue', 'comments', 'LON-200', '--limit', '500', '--json'],
    );
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI transport refuses oversized output and timed out commands', {
  timeout: testTimeoutFor(1),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'CLI transport refuses oversized output and timed out commands',
      ['systemdUserScope'],
    )
  )
    return;
  const oversized = await fakeCli();
  const hanging = await fakeCli();
  await Promise.all([
    writeFile(
      oversized.executable,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(128));\n",
    ),
    writeFile(
      hanging.executable,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(hanging.capture)}, String(descendant.pid));\nsetInterval(() => {}, 1000);\n`,
    ),
  ]);
  await Promise.all([
    chmod(oversized.executable, 0o755),
    chmod(hanging.executable, 0o755),
  ]);
  try {
    await assert.rejects(
      createPaperclipCliTransport({
        executable: oversized.executable,
        maxOutputBytes: 64,
      }).readIssue('LON-200'),
      /exceeds 64 bytes/u,
    );
    await assert.rejects(
      createPaperclipCliTransport({
        executable: hanging.executable,
        timeoutMs: 250,
      }).readIssue('LON-200'),
      /timed out after 250 ms/u,
    );
    const descendantPid = Number(await readFile(hanging.capture, 'utf8'));
    await waitForPidGone(descendantPid);
  } finally {
    try {
      const descendantPid = Number(await readFile(hanging.capture, 'utf8'));
      process.kill(descendantPid, 'SIGKILL');
    } catch {}
    await Promise.all([
      rm(oversized.directory, { recursive: true, force: true }),
      rm(hanging.directory, { recursive: true, force: true }),
    ]);
  }
});

test('timeout returns promptly when a setsid descendant holds CLI pipes', {
  timeout: testTimeoutFor(1),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'timeout returns promptly when a setsid descendant holds CLI pipes',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });\nfs.writeFileSync(${JSON.stringify(fake.capture)}, String(descendant.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  await chmod(fake.executable, 0o755);
  let pending: Promise<unknown> | undefined;
  try {
    const startedAt = Date.now();
    pending = createPaperclipCliTransport({
      executable: fake.executable,
      timeoutMs: 250,
    }).readIssue('LON-200');
    const returned = await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 450)),
    ]);
    assert.equal(
      returned,
      true,
      `timeout refusal took longer than 450 ms (${Date.now() - startedAt} ms)`,
    );
    assert.ok(Date.now() - startedAt <= 450);
    const descendantPid = Number(await readFile(fake.capture, 'utf8'));
    await waitForPidGone(descendantPid);
  } finally {
    try {
      const descendantPid = Number(await readFile(fake.capture, 'utf8'));
      process.kill(descendantPid, 'SIGKILL');
    } catch {}
    await pending?.catch(() => {});
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('Paperclip CLI refuses to launch when systemd user scopes are unavailable', async () => {
  const fake = await fakeCli();
  const systemdRun = join(fake.directory, 'systemd-run');
  await writeFile(systemdRun, '#!/bin/sh\nexit 1\n');
  await chmod(systemdRun, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fake.directory;
  try {
    await assert.rejects(
      createPaperclipCliTransport({ executable: fake.executable }).readIssue(
        'LON-200',
      ),
      /systemd user scopes are unavailable; refusing to launch/u,
    );
    assert.equal(
      await readFile(fake.capture, 'utf8').catch(() => ''),
      '',
      'Paperclip must not launch outside a systemd user scope',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('aborting a CLI request kills and waits for its process group', {
  timeout: testTimeoutFor(2),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'aborting a CLI request kills and waits for its process group',
      ['systemdUserScope'],
    )
  )
    return;
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(fake.capture)}, String(descendant.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  await chmod(fake.executable, 0o755);
  const controller = new AbortController();
  let descendantPid: number | undefined;
  try {
    const pending = createPaperclipCliTransport({
      executable: fake.executable,
      timeoutMs: 5_000,
      signal: controller.signal,
    }).readIssue('LON-200');
    const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    while (Date.now() < deadline && descendantPid === undefined) {
      try {
        descendantPid = Number(await readFile(fake.capture, 'utf8'));
      } catch {
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    assert.ok(descendantPid, 'fake CLI must fork its descendant');
    controller.abort();
    await assert.rejects(pending, /request aborted/u);
    await waitForPidGone(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {}
    }
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('cancelAll retains physical scope failures after their calls leave the active set', {
  timeout: testTimeoutFor(2),
}, async (t) => {
  const testName =
    'cancelAll retains physical scope failures after their calls leave the active set';
  if (!requiresIsolation(t, testName, ['systemdUserScope'])) return;
  const directory = await mkdtemp(join(tmpdir(), 'krn-paperclip-cancel-all-'));
  const fakeBin = join(directory, 'bin');
  const executable = join(fakeBin, 'paperclip');
  const systemdRun = join(fakeBin, 'systemd-run');
  const systemctl = join(fakeBin, 'systemctl');
  const unitsPath = join(directory, 'units');
  const startedPath = join(directory, 'started.jsonl');
  const failUnitPath = join(directory, 'fail-unit');
  const failureLogPath = join(directory, 'failures');
  const originalPath = process.env.PATH;
  const systemdEnv = { ...process.env };
  systemdEnv.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.() ?? 1000}`;
  systemdEnv.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${systemdEnv.XDG_RUNTIME_DIR}/bus`;
  const identities: Array<{ pid: number; startTicks: string }> = [];
  let units: string[] = [];
  let transport: ReturnType<typeof createPaperclipCliTransport> | undefined;
  let firstSignal: AbortController | undefined;
  let requests: Promise<unknown>[] = [];
  try {
    await mkdir(fakeBin);
    await writeFile(
      executable,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const fields = readFileSync('/proc/self/stat', 'utf8').slice(readFileSync('/proc/self/stat', 'utf8').lastIndexOf(')') + 2).trim().split(/\\s+/u);
appendFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid, startTicks: fields[19], issue: process.argv[3] }) + '\\n');
setInterval(() => {}, 1000);
`,
    );
    await writeFile(
      systemdRun,
      `#!/bin/sh
previous=""
for arg in "$@"; do
  if [ "$previous" = "--unit" ]; then
    case "$arg" in krn-paperclip-*.scope) printf "%s\\n" "$arg" >> ${JSON.stringify(unitsPath)};; esac
  fi
  previous="$arg"
done
exec /usr/bin/systemd-run "$@"
`,
    );
    await writeFile(
      systemctl,
      `#!/bin/sh
if [ "$1" = "--user" ] && [ "$2" = "show" ]; then
  for arg in "$@"; do case "$arg" in krn-paperclip-*.scope) unit="$arg";; esac; done
  expected=$(cat ${JSON.stringify(failUnitPath)} 2>/dev/null)
  if [ -n "$expected" ] && [ "$unit" = "$expected" ]; then
    printf "%s\\n" "$unit" >> ${JSON.stringify(failureLogPath)}
    printf "injected registered-scope verification failure\\n" >&2
    exit 42
  fi
fi
exec /usr/bin/systemctl "$@"
`,
    );
    await Promise.all(
      [executable, systemdRun, systemctl].map((path) => chmod(path, 0o755)),
    );
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    const activeTransport = createPaperclipCliTransport({
      executable,
      timeoutMs: 10_000,
    });
    transport = activeTransport;
    const activeFirstSignal = new AbortController();
    firstSignal = activeFirstSignal;
    const firstCall = activeTransport.readIssue(
      'LON-201',
      activeFirstSignal.signal,
    );
    const secondCall = activeTransport.readIssue('LON-202');
    const firstSettled = firstCall.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const secondSettled = secondCall.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    requests = [firstSettled, secondSettled];
    const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    let registrations: Array<{
      unit: string;
      pid: number;
      startTicks: string;
    }> = [];
    while (Date.now() < deadline) {
      const unitRows = (await readFile(unitsPath, 'utf8').catch(() => ''))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean);
      const startedRows = (await readFile(startedPath, 'utf8').catch(() => ''))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { pid: number; startTicks: string });
      if (unitRows.length === 2 && startedRows.length === 2) {
        const qualified: typeof registrations = [];
        for (const unit of unitRows) {
          const shown = spawnSync(
            '/usr/bin/systemctl',
            [
              '--user',
              'show',
              '--property=ActiveState',
              '--property=ControlGroup',
              '--value',
              unit,
            ],
            { encoding: 'utf8', timeout: 3000, env: systemdEnv },
          );
          const [active = '', controlGroup = ''] = shown.stdout
            .trimEnd()
            .split(/\r?\n/u);
          if (
            shown.status !== 0 ||
            active !== 'active' ||
            !controlGroup.startsWith('/') ||
            !controlGroup.endsWith(unit)
          )
            continue;
          const members = readFileSync(
            join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs'),
            'utf8',
          )
            .trim()
            .split(/\s+/u)
            .map(Number);
          const identity = startedRows.find(({ pid, startTicks }) => {
            if (!members.includes(pid)) return false;
            try {
              const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
              const fields = raw
                .slice(raw.lastIndexOf(')') + 2)
                .trim()
                .split(/\s+/u);
              return fields[19] === startTicks;
            } catch {
              return false;
            }
          });
          if (identity) qualified.push({ unit, ...identity });
        }
        registrations = qualified;
        if (registrations.length === 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (registrations.length !== 2)
      t.diagnostic(
        JSON.stringify({
          unitRows: (await readFile(unitsPath, 'utf8').catch(() => ''))
            .trim()
            .split(/\r?\n/u)
            .filter(Boolean),
          startedRows: (await readFile(startedPath, 'utf8').catch(() => ''))
            .trim()
            .split(/\r?\n/u)
            .filter(Boolean),
        }),
      );
    assert.equal(registrations.length, 2, 'both independent scopes register');
    const firstRegistration = registrations[0];
    assert.ok(firstRegistration);
    units = registrations.map(({ unit }) => unit);
    identities.push(
      ...registrations.map(({ pid, startTicks }) => ({ pid, startTicks })),
    );
    const members = registrations.map(({ unit, pid, startTicks }) => {
      const shown = spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'show', '--property=ControlGroup', '--value', unit],
        { encoding: 'utf8', timeout: 3000, env: systemdEnv },
      );
      assert.equal(shown.status, 0, shown.stderr);
      const cgroup = join('/sys/fs/cgroup', shown.stdout.trim().slice(1));
      const pids = readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
        .trim()
        .split(/\s+/u)
        .map(Number);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u);
      assert.equal(fields[19], startTicks);
      assert.ok(pids.includes(pid), `${pid} belongs to ${unit}`);
      return { unit, pid, startTicks, cgroup };
    });

    await writeFile(failUnitPath, `${firstRegistration.unit}\n`);
    activeFirstSignal.abort();
    const firstResult = await firstSettled;
    assert.equal(firstResult.ok, false);
    if (firstResult.ok)
      assert.fail('injected cleanup failure must reject first call');
    assert.match(
      firstResult.error instanceof Error
        ? firstResult.error.message
        : String(firstResult.error),
      /scope could not be stopped and verified/u,
    );
    assert.equal(
      (await readFile(failureLogPath, 'utf8')).trim(),
      firstRegistration.unit,
      'only the first exact registered scope has a failed verification',
    );

    const cancelAll = activeTransport.cancelAll;
    if (!cancelAll)
      throw new Error('Paperclip transport must expose cancelAll');
    await assert.rejects(
      cancelAll.call(activeTransport),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        error.errors[0] instanceof Error &&
        /Paperclip CLI scope could not be stopped and verified/u.test(
          error.errors[0].message,
        ),
    );
    const secondResult = await secondSettled;
    assert.equal(secondResult.ok, false);
    if (secondResult.ok) assert.fail('cancelAll must abort second request');
    assert.match(
      secondResult.error instanceof Error
        ? secondResult.error.message
        : String(secondResult.error),
      /request aborted/u,
    );
    t.diagnostic(
      JSON.stringify({
        registrations,
        members,
        injectedUnit: firstRegistration.unit,
        cancelAllRetainedOneVerificationFailure: true,
      }),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    firstSignal?.abort();
    if (transport?.cancelAll)
      await transport.cancelAll().catch(() => undefined);
    await Promise.all(requests);
    units = (await readFile(unitsPath, 'utf8').catch(() => ''))
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    identities.splice(
      0,
      identities.length,
      ...(await readFile(startedPath, 'utf8').catch(() => ''))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { pid: number; startTicks: string }),
    );
    for (const unit of units) {
      spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
        { encoding: 'utf8', timeout: 5000, env: systemdEnv },
      );
      spawnSync('/usr/bin/systemctl', ['--user', 'stop', unit], {
        encoding: 'utf8',
        timeout: 5000,
        env: systemdEnv,
      });
    }
    const cleanupDeadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    let cleaned = false;
    while (Date.now() < cleanupDeadline) {
      cleaned =
        units.every((unit) => {
          const shown = spawnSync(
            '/usr/bin/systemctl',
            [
              '--user',
              'show',
              '--property=ActiveState',
              '--property=ControlGroup',
              '--value',
              unit,
            ],
            { encoding: 'utf8', timeout: 3000, env: systemdEnv },
          );
          if (shown.status !== 0) return true;
          const [active = '', controlGroup = ''] = shown.stdout
            .trimEnd()
            .split(/\r?\n/u);
          let pids: number[] = [];
          if (controlGroup.startsWith('/'))
            try {
              pids = readFileSync(
                join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs'),
                'utf8',
              )
                .trim()
                .split(/\s+/u)
                .filter(Boolean)
                .map(Number);
            } catch {}
          return ['inactive', 'failed'].includes(active) && pids.length === 0;
        }) &&
        identities.every(({ pid, startTicks }) => {
          try {
            const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = raw
              .slice(raw.lastIndexOf(')') + 2)
              .trim()
              .split(/\s+/u);
            return (
              fields[19] !== startTicks ||
              fields[0] === 'Z' ||
              fields[0] === 'X'
            );
          } catch {
            return true;
          }
        });
      if (cleaned) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await rm(directory, { recursive: true, force: true });
    assert.ok(
      cleaned,
      'all exact transient scopes and recorded processes stopped',
    );
  }
});
