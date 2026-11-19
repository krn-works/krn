import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exposureOf, readExposures } from '../../src/brain/exposures.ts';
import { incidentRecords } from '../../src/brain/principle-check.ts';
import { laneCandidates } from '../../src/brain/worker-packet.ts';
import { parseContractFile } from '../../src/repo/contract.ts';
import {
  assertFormat,
  FORMAT_MAJORS,
  FormatError,
  schemaPath,
} from '../../src/repo/formats.ts';
import { loadTaskIndex } from '../../src/task/store.ts';
import { validate } from './json-schema-subset.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'src/cli/main.ts');
const read = (path: string): unknown =>
  JSON.parse(readFileSync(join(repo, path), 'utf8'));
const schema = (name: string) =>
  read(schemaPath(`krn.${name}`, 1)) as Record<string, unknown>;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-formats-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const handTask = {
  id: 't-abc',
  status: 'open',
  resolution: null,
  created: '2026-11-15',
  priority: 1,
  title: 'A task',
  after: [],
  body: ['Outcome: x'],
};

test('every format this build reads has a schema file and krn.json declares each', () => {
  const declared = (read('krn.json') as { formats: string[] }).formats;
  for (const [name, major] of Object.entries(FORMAT_MAJORS)) {
    assert.ok(declared.includes(`${name}/v${major}`), `${name} declared`);
    assert.equal(schema(name.slice(4)).$id as string, `${name}/v${major}`);
  }
});

test('every committed task file conforms to krn.task/v1', () => {
  const files = readdirSync(join(repo, 'tasks')).filter((f) =>
    f.endsWith('.json'),
  );
  assert.ok(files.length > 0);
  const failures = files.flatMap((file) =>
    validate(schema('task'), read(`tasks/${file}`), file),
  );
  assert.deepEqual(failures, []);
});

test('every committed record file conforms to krn.record/v1', () => {
  for (const file of ['standards/records.json', '.agents/records.json']) {
    const rows = read(file) as unknown[];
    assert.ok(rows.length > 0);
    const failures = rows.flatMap((row, i) =>
      validate(schema('record'), row, `${file}[${i}]`),
    );
    assert.deepEqual(failures, []);
  }
});

test('krn.json conforms to krn.contract/v1', () => {
  assert.deepEqual(validate(schema('contract'), read('krn.json')), []);
});

test('an exposure line the writer produces conforms to krn.exposure/v1, and so does a hand-written one', () => {
  const written = exposureOf({
    run: 'r1',
    task: undefined,
    channel: 'session',
    served: ['r-a'],
    withheld: [],
    laneOk: true,
    proof: 'p',
  });
  assert.deepEqual(validate(schema('exposure'), written), []);
  const plain =
    '{"schema":"krn.exposure/v1","at":"2026-11-15T10:00:00.000Z","run":"x","task":null,"channel":"session","attempt":1,"served":[],"withheld":[],"tokens":0,"violated":{},"outcome":{},"lane_ok":true}';
  assert.deepEqual(validate(schema('exposure'), JSON.parse(plain)), []);
});

test('a malformed file does not conform', () => {
  const { id: _id, ...noId } = handTask;
  assert.ok(validate(schema('task'), noId).length > 0);
  assert.ok(
    validate(schema('task'), { ...handTask, status: 'maybe' }).length > 0,
  );
  assert.ok(validate(schema('task'), { ...handTask, extra: 1 }).length > 0);
  assert.ok(validate(schema('exposure'), { run: 'x' }).length > 0);
});

test('the contract reader refuses an unknown major with exit 78 and accepts the known one', () => {
  assert.deepEqual(parseContractFile('{"formats":["krn.task/v1"]}').formats, [
    'krn.task/v1',
  ]);
  assert.throws(
    () => parseContractFile('{"formats":["krn.task/v2"]}'),
    (error) => error instanceof FormatError && error.exitCode === 78,
  );
  assert.throws(
    () => parseContractFile('{"formats":["krn.unknown/v1"]}'),
    FormatError,
  );
  assert.throws(() => parseContractFile('{"formats":"krn.task/v1"}'), /array/u);
});

test('krn repo contract exits 78 on an unknown major', () => {
  const root = fixture({
    'krn.json': '{"test":"true","formats":["krn.contract/v2"]}',
  });
  const run = spawnSync('node', [cli, 'repo', 'contract', '--root', root], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /krn\.contract\/v2/u);
});

test('the task reader refuses an unknown task major with exit 78 and reads a declared v1', () => {
  const task = `${JSON.stringify(handTask, null, 2)}\n`;
  const good = fixture({
    'krn.json': '{"test":"true","formats":["krn.task/v1"]}',
    'tasks/t-abc.json': task,
  });
  assert.equal(loadTaskIndex(good).size, 1);
  const bad = fixture({
    'krn.json': '{"test":"true","formats":["krn.task/v2"]}',
    'tasks/t-abc.json': task,
  });
  assert.throws(() => loadTaskIndex(bad), FormatError);
  spawnSync('git', ['init', '--quiet'], { cwd: bad });
  const run = spawnSync('node', [cli, 'task', 'list', '--json'], {
    cwd: bad,
    encoding: 'utf8',
  });
  assert.equal(run.status, 78, run.stderr);
});

test('the record and exposure readers refuse an unknown major', () => {
  const root = fixture({
    'krn.json': '{"test":"true","formats":["krn.record/v3","krn.exposure/v2"]}',
    '.krn/brain/exposures.jsonl': '',
    '.agents/records.json': '[]',
  });
  assert.throws(() => laneCandidates(root), FormatError);
  assert.throws(() => readExposures(root), FormatError);
  assert.throws(() => assertFormat(root, 'krn.record'), /major 3/u);
});

// A task created with `--stack` failed this check with "unsupported keyword minItems" and
// "uniqueItems" because the validator did not know the keywords task.v1 uses on stack (t-y9gvftp).
test('a task stack of distinct names conforms and an empty or duplicated one is refused', () => {
  const stack = (
    read('spec/schema/task.v1.json') as {
      properties: { stack: Record<string, unknown> };
    }
  ).properties.stack;
  assert.deepEqual(validate(stack, ['typescript', 'node']), []);
  assert.deepEqual(validate(stack, []), ['$: fewer than 1 items']);
  assert.deepEqual(validate(stack, ['node', 'node']), ['$: duplicate items']);
});

// Records that still retell one incident. The list only shrinks: a rewritten record leaves it.
const INCIDENT_ALLOWED = new Set<string>();

test('every record text states a principle, so a hand edit cannot retell one incident', () => {
  const flagged = ['.agents/records.json', 'standards/records.json'].flatMap(
    (file) =>
      incidentRecords(read(file) as Parameters<typeof incidentRecords>[0]).map(
        (row) => ({ ...row, file }),
      ),
  );
  assert.deepEqual(
    flagged.filter((row) => !INCIDENT_ALLOWED.has(row.id)),
    [],
    'state the principle and move the incident into provenance.evidence',
  );
  assert.deepEqual(
    [...INCIDENT_ALLOWED].filter((id) => !flagged.some((r) => r.id === id)),
    [],
    'remove the rewritten record from INCIDENT_ALLOWED',
  );
});
