import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
} from '../../src/task/record.ts';
import { checkTaskDirectory } from '../../src/task/store.ts';
import {
  rawTask,
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
