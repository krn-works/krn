import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBrief, readRegularFile } from '../../src/brief/index.ts';
import { briefCommand } from '../../src/cli/brief.ts';
import { requireReviewChecklist } from '../../src/deliver/checklist.ts';
import { DeliveryFailure, deliver } from '../../src/deliver/delivery.ts';
import { type Runner, run } from '../../src/deliver/transport.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repository, 'src/cli/krn.mjs');
const checklistPath = 'docs/program/hardening-checklist.md';
const checklist = '- `race`: races are closed.\n';

function temp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'krn-checklist-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function evaluate(
  t: { after(fn: () => void): void },
  brief: string | Buffer,
  classes: string | Buffer = checklist,
): string[] {
  const dir = temp(t);
  const briefPath = join(dir, 'brief.md');
  const classesPath = join(dir, 'checklist.md');
  writeFileSync(briefPath, brief);
  writeFileSync(classesPath, classes);
  return checkBrief(briefPath, classesPath);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('invalid UTF-8 is refused for briefs and checklists with the right label', (t) => {
  const invalid = Buffer.from([0x2d, 0x20, 0xff, 0x0a]);
  assert.deepEqual(evaluate(t, invalid), ['brief must be UTF-8 text']);
  assert.deepEqual(
    evaluate(t, '# Brief\n\n## Hardening\n- race: covered\n', invalid),
    ['checklist must be UTF-8 text'],
  );

  const briefCheckDir = temp(t);
  const invalidBrief = join(briefCheckDir, 'invalid-brief.md');
  const invalidBriefChecklist = join(briefCheckDir, 'invalid-checklist.md');
  const validBrief = join(briefCheckDir, 'brief.md');
  const validChecklist = join(briefCheckDir, 'checklist.md');
  writeFileSync(invalidBrief, invalid);
  writeFileSync(invalidBriefChecklist, invalid);
  writeFileSync(validBrief, '# Brief\n\n## Hardening\n- race: covered\n');
  writeFileSync(validChecklist, checklist);
  const briefCli = (briefPath: string, classesPath: string) =>
    spawnSync(
      process.execPath,
      [cli, 'brief', 'check', briefPath, '--checklist', classesPath],
      { cwd: briefCheckDir, encoding: 'utf8' },
    );
  const invalidBriefResult = briefCli(invalidBrief, validChecklist);
  assert.equal(invalidBriefResult.status, 65);
  assert.match(invalidBriefResult.stderr, /brief must be UTF-8 text/u);
  const invalidChecklistResult = briefCli(validBrief, invalidBriefChecklist);
  assert.equal(invalidChecklistResult.status, 65);
  assert.match(invalidChecklistResult.stderr, /checklist must be UTF-8 text/u);

  const dir = temp(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'tracked'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'fixture');
  const head = git(dir, 'rev-parse', 'HEAD');
  const lens = join(dir, 'lens.md');
  const invalidChecklist = join(dir, 'invalid-checklist.md');
  writeFileSync(lens, 'Check behavior.\n');
  writeFileSync(invalidChecklist, invalid);
  const review = spawnSync(
    process.execPath,
    [
      cli,
      'review',
      '--repo',
      dir,
      '--base',
      head,
      '--head',
      head,
      '--lens',
      lens,
      '--prepass',
      '--checklist',
      invalidChecklist,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(review.status, 64);
  assert.equal(review.stdout, '');
  assert.match(review.stderr, /--checklist must be UTF-8 text/u);
});

test('valid BOM text keeps the byte digest used by review and deliver', (t) => {
  const bytes = Buffer.from('\uFEFF- `race`: covered\r\n');
  const dir = temp(t);
  const file = join(dir, 'checklist.md');
  writeFileSync(file, bytes);
  const decoded = readRegularFile(file, 32 * 1024, 'checklist');
  assert.equal(decoded, bytes.toString('utf8'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    createHash('sha256').update(decoded, 'utf8').digest('hex'),
    digest,
  );

  const blob = 'a'.repeat(40);
  const sha = 'b'.repeat(40);
  const calls: string[][] = [];
  const runner: Runner = (_command, args) => {
    calls.push(args);
    if (args[0] === 'ls-tree')
      return {
        code: 0,
        stdout: `100644 blob ${blob}\t${checklistPath}\n`,
        stderr: '',
      };
    if (args[0] === 'cat-file' && args[1] === '-s')
      return { code: 0, stdout: `${bytes.byteLength}\n`, stderr: '' };
    if (args[0] === 'cat-file' && args[1] === 'blob')
      return {
        code: 0,
        stdout: bytes.toString('utf8'),
        stdoutBytes: bytes,
        stderr: '',
      };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.doesNotThrow(() =>
    requireReviewChecklist(
      {
        base: sha,
        headSha: sha,
        checklist: { sha256: digest },
        prepass: { state: 'complete', findings: [], sessionId: 'fixture' },
      },
      dir,
      runner,
    ),
  );
  const sizeIndex = calls.findIndex((args) => args[1] === '-s');
  const blobIndex = calls.findIndex((args) => args[1] === 'blob');
  assert.ok(sizeIndex >= 0);
  assert.ok(blobIndex > sizeIndex);
});

test('placeholder answers are empty after emphasis is stripped', (t) => {
  for (const answer of [
    '<required behaviour and its readiness case>',
    'TODO',
    'tbd',
    'fIxMe',
    '?',
    '...',
    '…',
    '---',
    '..-.-.',
    '**TODO**',
    '`<fill this in>`',
  ])
    assert.deepEqual(
      evaluate(t, `# Brief\n\n## Hardening\n- race: ${answer}\n`),
      ['empty answer for id race at line 4'],
      answer,
    );
});

test('HTML comment blocks hide headings, answers, and checklist ids', (t) => {
  assert.deepEqual(
    evaluate(
      t,
      '  <!-- example\n## Hardening\n-->\n## Hardening\n- race: covered\n',
    ),
    [],
  );
  assert.deepEqual(
    evaluate(t, '## Hardening\n<!--\n- race: covered\n-- comment -->\n'),
    ['missing id race'],
  );
  assert.deepEqual(
    evaluate(
      t,
      '## Hardening\n- race: covered\n',
      '<!--\n- `ignored`: hidden\n-- end -->\n- `race`: required\n',
    ),
    [],
  );
  assert.deepEqual(
    evaluate(t, '<!-- ## Hardening -->\n## Hardening\n- race: covered\n'),
    [],
  );
});

test('nested list items are ignored instead of parsed as unknown answers', (t) => {
  assert.deepEqual(
    evaluate(t, '# Brief\n\n## Hardening\n- race: covered\n  - case: x\n'),
    [],
  );
});

test('brief paths with control characters fail with usage before printing a result', (t) => {
  const dir = temp(t);
  const brief = join(dir, 'brief.md');
  const classes = join(dir, 'checklist.md');
  writeFileSync(brief, '# Brief\n\n## Hardening\n- race: covered\n');
  writeFileSync(classes, checklist);
  for (const args of [
    ['check', `${brief}\u0001`, '--checklist', classes],
    ['check', brief, '--checklist', `${classes}\u0001`],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'brief', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /control character/u);
  }
});

test('deliver refuses oversized checklist blobs at bind before reading the blob', async (t) => {
  const dir = temp(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'tracked'), 'fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, 'docs/program'), { recursive: true });
  const bytes = Buffer.alloc(40_000, 0x61);
  writeFileSync(join(dir, checklistPath), bytes);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'head');
  const head = git(dir, 'rev-parse', 'HEAD');

  const reviewPath = fileURLToPath(
    new URL('../flow/fixtures/review-record-v1.fixture', import.meta.url),
  );
  const record = JSON.parse(readFileSync(reviewPath, 'utf8'));
  record.base = base;
  record.headSha = head;
  record.contracts = [];
  record.checklist = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  record.prepass = {
    state: 'complete',
    findings: [],
    sessionId: 'fixture',
  };
  const recordPath = join(dir, 'record.json');
  writeFileSync(recordPath, JSON.stringify(record));

  const pull = JSON.parse(
    readFileSync(
      new URL('../deliver/fixtures/pull.fixture', import.meta.url),
      'utf8',
    ),
  );
  Object.assign(pull, { state: 'open', merged: false, merge_commit_sha: null });
  pull.head = { sha: head, ref: 'feature/checklist' };
  pull.base.sha = base;
  const calls: string[][] = [];
  const runner: Runner = (command, args, cwd, input) => {
    calls.push([command, ...args]);
    if (command === 'gh')
      return { code: 0, stdout: JSON.stringify(pull), stderr: '' };
    return run(command, args, cwd, input);
  };

  await assert.rejects(
    deliver(
      {
        repo: pull.base.repo.full_name,
        pr: pull.number,
        record: recordPath,
        dryRun: true,
        loadThreshold: 6,
        timeoutMs: 100,
        pollMs: 10,
      },
      { cwd: dir, run: runner },
    ),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryFailure);
      assert.equal(error.stage, 'bind');
      assert.equal(error.exitCode, 71);
      assert.match(error.message, /32768/u);
      return true;
    },
  );
  const sizeIndex = calls.findIndex(
    (args) => args[0] === 'git' && args[1] === 'cat-file' && args[2] === '-s',
  );
  assert.ok(sizeIndex >= 0);
  assert.equal(
    calls.some(
      (args) =>
        args[0] === 'git' && args[1] === 'cat-file' && args[2] === 'blob',
    ),
    false,
  );
});

test('a deleted head checklist explains how to recover from a stale base', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const calls: string[][] = [];
  const runner: Runner = (_command, args) => {
    calls.push(args);
    return {
      code: 0,
      stdout:
        args[2] === base
          ? `100644 blob ${'c'.repeat(40)}\t${checklistPath}\n`
          : '',
      stderr: '',
    };
  };
  assert.throws(
    () =>
      requireReviewChecklist(
        {
          base,
          headSha: head,
          checklist: { sha256: 'd'.repeat(64) },
          prepass: { state: 'complete', findings: [], sessionId: 'fixture' },
        },
        '.',
        runner,
      ),
    /head lacks the checklist; rebase onto the current base/u,
  );
  assert.equal(calls.length, 2);
});

test('brief command rejects control characters before writing stdout', () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.throws(
      () => briefCommand(['check', 'brief\u0001.md']),
      (error: unknown) =>
        error instanceof Error && 'exitCode' in error && error.exitCode === 64,
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(writes, []);
});
