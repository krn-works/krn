import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { branchTicketFindings } from '../../src/task/branch-tickets.ts';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
  TaskUsageError,
} from '../../src/task/record.ts';
import { checkTaskDirectory, loadTaskIndex } from '../../src/task/store.ts';
import { runCliInProcess } from './claims-fixture.ts';
import {
  git,
  rawTask,
  runCli,
  runCliAsync,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

test('task check and parser identify malformed files, records, references, and cycles', async (t) => {
  const variants: Array<[string, string, string]> = [];
  variants.push(['invalid JSON', '{ nope\n', 'invalid JSON']);
  variants.push([
    'Git conflict markers',
    `<<<<<<< HEAD\n${serializeTask(validTask)}`,
    'Git conflict markers',
  ]);
  variants.push([
    'CRLF',
    serializeTask(validTask).replace(/\n/gu, '\r\n'),
    'contains CR characters',
  ]);
  variants.push([
    'missing trailing newline',
    serializeTask(validTask).trimEnd(),
    'missing trailing newline',
  ]);

  const reversed = Object.fromEntries(Object.entries(validTask).reverse());
  variants.push([
    'wrong key order',
    `${JSON.stringify(reversed, null, 2)}\n`,
    'wrong top-level key order',
  ]);

  const withExtra = { ...validTask, extra: true };
  variants.push([
    'extra key',
    `${JSON.stringify(withExtra, null, 2)}\n`,
    'extra key "extra"',
  ]);

  const { body: _body, ...withoutBody } = validTask;
  variants.push([
    'missing key',
    `${JSON.stringify(withoutBody, null, 2)}\n`,
    'missing key "body"',
  ]);

  const variantsByRecord: Array<[string, Partial<TaskRecord>, string]> = [
    ['bad status', { status: 'blocked' as TaskRecord['status'] }, 'status'],
    [
      'open with resolution',
      { resolution: { kind: 'done', ref: null, note: '' } },
      'open tasks must have a null resolution',
    ],
    [
      'closed without resolution',
      { status: 'closed' },
      'closed tasks require a resolution',
    ],
    [
      'duplicate without ref',
      {
        status: 'closed',
        resolution: { kind: 'duplicate', ref: null, note: '' },
      },
      'duplicate resolutions require a ref',
    ],
    [
      'superseded without ref',
      {
        status: 'closed',
        resolution: { kind: 'superseded', ref: null, note: '' },
      },
      'superseded resolutions require a ref',
    ],
    ['priority out of range', { priority: 4 }, 'must be between 0 and 3'],
    ['priority non-integer', { priority: 1.5 }, 'priority" must be an integer'],
    ['empty title', { title: '  ' }, 'title" must not be empty'],
    ['multi-line title', { title: 'one\ntwo' }, 'title" must be a single line'],
    ['bad created date', { created: '2026-02-30' }, 'real YYYY-MM-DD date'],
    ['invalid id', { id: 'bad_id' }, 'not a valid task id'],
  ];
  for (const [name, override, finding] of variantsByRecord) {
    const record = { ...validTask, ...override } as TaskRecord;
    variants.push([name, `${JSON.stringify(record, null, 2)}\n`, finding]);
  }
  variants.push([
    'unsorted after',
    rawTask({ after: ['T-2', 'T-1'] }),
    '"after" must be sorted',
  ]);
  variants.push([
    'duplicate after',
    rawTask({ after: ['T-1', 'T-1'] }),
    '"after" must not contain duplicates',
  ]);

  for (const [name, contents, expected] of variants) {
    await t.test(name, () => {
      const parsed = parseTaskDocument(contents);
      assert.ok(
        parsed.findings.some((finding) => finding.includes(expected)),
        parsed.findings.join('\n'),
      );
    });
  }

  const repo = await tempRepo('reference-findings-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1', after: ['T-9'] });
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-2'] });
    await writeTask(repo, {
      ...validTask,
      id: 'T-3',
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-9', note: '' },
    });
    await writeTask(repo, {
      ...validTask,
      id: 'T-4',
      status: 'closed',
      resolution: { kind: 'superseded', ref: 'T-9', note: '' },
    });
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /unknown after task "T-9"/u);
    assert.match(findings, /cannot depend on itself/u);
    assert.match(findings, /unknown resolution ref "T-9"/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check detects dependency cycles of length two and three', async () => {
  const repo = await tempRepo('cycles-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1', after: ['T-2'] });
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-1'] });
    await writeTask(repo, { ...validTask, id: 'T-3', after: ['T-4'] });
    await writeTask(repo, { ...validTask, id: 'T-4', after: ['T-5'] });
    await writeTask(repo, { ...validTask, id: 'T-5', after: ['T-3'] });
    const findings = checkTaskDirectory(repo).filter((finding) =>
      finding.includes('dependency cycle'),
    );
    assert.equal(findings.length, 2, findings.join('\n'));
    assert.match(findings.join('\n'), /T-1 -> T-2 -> T-1/u);
    assert.match(findings.join('\n'), /T-3 -> T-4 -> T-5 -> T-3/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check reports a UTF-8 BOM while preserving canonical byte checks', async () => {
  const repo = await tempRepo('bom-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, 'T-1.json'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(serializeTask(validTask)),
      ]),
    );
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /file starts with a byte order mark/u);
    assert.match(findings, /file does not use canonical task serialization/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check finds cycles through records with other validation errors', async () => {
  const repo = await tempRepo('partial-cycle-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1' });
    const partial = {
      ...validTask,
      id: 'T-1',
      after: ['T-2'],
    };
    const { body: _body, ...partialWithoutBody } = partial;
    await writeFile(
      join(repo, 'tasks', 'A-alias.json'),
      `${JSON.stringify(partialWithoutBody, null, 2)}\n`,
    );
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-1'] });
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /missing key "body"/u);
    assert.match(findings, /filename does not match id "T-1"/u);
    assert.match(findings, /dependency cycle T-1 -> T-2 -> T-1/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check handles a 20,000 task dependency chain iteratively', async () => {
  const repo = await tempRepo('long-chain-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    for (let index = 0; index < 20_000; index += 1) {
      const id = `T-${String(index).padStart(5, '0')}`;
      const after =
        index === 19_999 ? [] : [`T-${String(index + 1).padStart(5, '0')}`];
      writeFileSync(
        join(tasks, `${id}.json`),
        serializeTask({ ...validTask, id, after }),
      );
    }
    const result = await runCliAsync(repo, ['check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Task data is valid.\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function ticketRepo(): Promise<string> {
  const repo = await tempRepo('branch-tickets-');
  await writeTask(repo, { ...validTask, id: 'T-1' });
  await writeTask(repo, {
    ...validTask,
    id: 'T-2',
    status: 'closed',
    resolution: { kind: 'done', ref: null, note: '' },
  });
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add tasks');
  git(repo, 'switch', '--quiet', '--create', 'work');
  return repo;
}

function commit(repo: string, subject: string, trailers: string): string {
  git(repo, 'commit', '--allow-empty', '-qm', subject, '-m', trailers);
  return git(repo, 'rev-parse', '--short', 'HEAD');
}

function openTicket(id: string, commits: string[]): string {
  return `Ticket: ${id} (${commits.join(', ')}): the task is open on this branch; close it with \`krn task close ${id} --as done --note TEXT\`, or use Refs: ${id} for work that leaves it open`;
}

test('branch ticket findings refuse open and unknown Ticket tasks once each within base..head', async () => {
  const repo = await ticketRepo();
  try {
    const first = commit(repo, 'feat: work (T-1)', 'Ticket: T-1');
    const progress = commit(repo, 'chore: progress (T-1)', 'Refs: T-1');
    commit(repo, 'chore(retro): lessons (T-2)', 'Ticket: T-2');
    const last = commit(repo, 'fix: wrong ids', 'ticket: T-9, T-1');
    const index = loadTaskIndex(repo);
    assert.deepEqual(branchTicketFindings(repo, index, 'main', 'HEAD'), [
      openTicket('T-1', [first, last]),
      `Ticket: T-9 (${last}) names no task`,
    ]);
    assert.deepEqual(branchTicketFindings(repo, index, 'main', first), [
      openTicket('T-1', [first]),
    ]);
    assert.deepEqual(branchTicketFindings(repo, index, first, 'HEAD~1'), []);
    assert.deepEqual(branchTicketFindings(repo, index, first, progress), []);
    const unusable: Array<[string, string]> = [
      ['missing', '--base missing is not a commit here'],
      ['-p', '--base must name a commit'],
    ];
    for (const [base, message] of unusable)
      assert.throws(
        () => branchTicketFindings(repo, index, base, 'HEAD'),
        (error) =>
          error instanceof TaskUsageError && error.message.startsWith(message),
      );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check --base exits 65 while the branch leaves its Ticket task open and 0 once it closes it', async () => {
  const repo = await ticketRepo();
  try {
    const work = commit(
      repo,
      'feat: work (T-1)',
      'Ticket: T-1\nCo-Authored-By: KRN <krn@example.invalid>',
    );
    const refused = runCli(repo, ['check', '--base', 'main']);
    assert.equal(refused.status, 65);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, `${openTicket('T-1', [work])}\n`);

    await writeTask(repo, {
      ...validTask,
      id: 'T-1',
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: 'delivered' },
    });
    git(repo, 'commit', '-qam', 'chore(tasks): close T-1', '-m', 'Ticket: T-1');
    const closed = runCli(repo, ['check', '--base', 'main', '--json']);
    assert.equal(closed.status, 0, closed.stderr);
    assert.deepEqual(JSON.parse(closed.stdout), { ok: true, findings: [] });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check takes --head only with --base and each option once', async () => {
  const repo = await ticketRepo();
  try {
    commit(repo, 'feat: work (T-1)', 'Ticket: T-1');
    const bounded = await runCliInProcess(repo, [
      'check',
      '--base',
      'main',
      '--head',
      'main',
      '--json',
    ]);
    assert.equal(bounded.status, 0, bounded.stderr);
    const usages: Array<[string[], string]> = [
      [['check', '--head', 'HEAD'], '--head requires --base\n'],
      [
        ['check', '--base', 'main', '--base', 'main'],
        '--base may be supplied once\n',
      ],
      [['check', '--since', 'main'], 'unknown check option "--since"\n'],
    ];
    for (const [args, message] of usages) {
      const result = await runCliInProcess(repo, args);
      assert.equal(result.status, 64, args.join(' '));
      assert.equal(result.stderr, message);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
