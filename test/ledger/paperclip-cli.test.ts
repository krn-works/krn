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
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(fake.capture)}, JSON.stringify(args));\nprocess.stdout.write('{}');\n`,
  );
  await chmod(fake.executable, 0o755);
  try {
    const comment = 'review $HOME; $(must stay one argument)';
    await createPaperclipCliTransport({
      executable: fake.executable,
    }).updateIssue('LON-200', 'in_review', comment);
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
      '#!/usr/bin/env node\nsetTimeout(() => process.stdout.write("{}"), 5000);\n',
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
        timeoutMs: 25,
      }).readIssue('LON-200'),
      /timed out after 25 ms/u,
    );
  } finally {
    await Promise.all([
      rm(oversized.directory, { recursive: true, force: true }),
      rm(hanging.directory, { recursive: true, force: true }),
    ]);
  }
});
