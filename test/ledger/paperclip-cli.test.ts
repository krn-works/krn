import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLedger } from '../../src/ledger/index.ts';
import {
  loadLiveContract,
  withLiveSubmissionGate,
} from '../../src/ledger/live.ts';
import { createPaperclipCliTransport } from '../../src/ledger/paperclip-cli.ts';

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
  const deadline = Date.now() + 1000;
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

test('readContract uses CLI JSON without KRN credentials and default reads never update', async () => {
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

test('CLI update carries status and comment in one argv-safe invocation', async () => {
  const fake = await fakeCli();
  await writeFile(
    fake.executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(fake.capture)}, JSON.stringify(args));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    const comment = 'review $HOME; $(must stay one argument)';
    const receipt = await createPaperclipCliTransport({
      executable: fake.executable,
    }).updateIssue('LON-200', 'in_review', comment);
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
  } finally {
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test('CLI activity conflicts use the read-only issue activity command', async () => {
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

test('CLI transport refuses oversized output and timed out commands', async () => {
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

test('timeout returns promptly when a setsid descendant holds CLI pipes', async () => {
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

test('aborting a CLI request kills and waits for its process group', async () => {
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
    for (
      let attempt = 0;
      attempt < 100 && descendantPid === undefined;
      attempt++
    ) {
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
