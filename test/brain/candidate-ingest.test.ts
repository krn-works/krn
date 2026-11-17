import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseVerdict, VERDICT_DIR } from '../../src/brain/candidate-ingest.ts';
import { schemaPath } from '../../src/repo/formats.ts';
import { validate } from '../rules/json-schema-subset.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'src/cli/main.ts');
const today = new Date().toISOString().slice(0, 10);
const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
const schema = (name: string) =>
  JSON.parse(readFileSync(join(repo, schemaPath(`krn.${name}`, 1)), 'utf8'));

// The plainest candidate the ADR names: exactly its fields, nothing else.
const plain = () => ({
  schema: 'krn.candidate/v1',
  id: 'c-reflect',
  source: {
    url: 'https://arxiv.org/abs/2601.00001',
    quote: 'reflection helps',
    sha256: 'abc',
  },
  pillar: 'recall',
  claim: 'Ask for the failing test before editing.',
  record_draft: {
    id: 'r-c-reflect',
    type: 'standard',
    text: 'Name the failing test before you edit.',
    provenance: { origin: 'https://arxiv.org/abs/2601.00001' },
    status: 'trial',
    recorded_at: today,
    valid_from: today,
    valid_to: null,
  },
  experiment: {
    population: 'recall-eval cases',
    metric: 'first-push-green',
    predicted_delta: 0.05,
    min_n: 20,
  },
  expires: nextYear,
  motivated_by: 'recall-eval case wp-17 failed',
});

function repoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-candidate-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents/records.json'), '[]\n');
  return root;
}

function ingest(root: string, candidate: unknown) {
  const file = join(root, `in-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(candidate));
  return spawnSync(
    process.execPath,
    [cli, 'standards', 'propose', '--from-candidate', file, '--root', root],
    { encoding: 'utf8' },
  );
}

test('the candidate and verdict schemas validate the plain examples and refuse a missing motivated_by', () => {
  assert.deepEqual(validate(schema('candidate'), plain()), []);
  const { motivated_by: _, ...unmotivated } = plain();
  assert.ok(validate(schema('candidate'), unmotivated).length > 0);
  const verdict = {
    schema: 'krn.verdict/v1',
    id: 'c-reflect',
    n: 20,
    delta: 0.04,
    p: 0.03,
    cost_usd: 2.5,
    decision: 'accept',
    recorded_at: today,
  };
  assert.deepEqual(validate(schema('verdict'), verdict), []);
  assert.ok(
    validate(schema('verdict'), { ...verdict, decision: 'maybe' }).length > 0,
  );
  assert.equal(parseVerdict(verdict).cost_usd, 2.5);
});

test('--from-candidate ingests the plain candidate: the file, then a trial record', () => {
  const root = repoRoot();
  const run = ingest(root, plain());
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /ingested \.agents\/research-candidates\/c-reflect\.json/u,
  );
  const records = JSON.parse(
    readFileSync(join(root, '.agents/records.json'), 'utf8'),
  ) as { id: string; status: string }[];
  assert.deepEqual(
    records.map((r) => [r.id, r.status]),
    [['r-c-reflect', 'trial']],
  );
  const again = ingest(root, plain());
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already ingested/u);
});

test('--from-candidate refuses a candidate without motivated_by, naming the field', () => {
  const root = repoRoot();
  const { motivated_by: _, ...unmotivated } = plain();
  const run = ingest(root, unmotivated);
  assert.equal(run.status, 65);
  assert.match(run.stderr, /motivated_by/u);
  assert.equal(existsSync(join(root, '.agents/research-candidates')), false);
  const blank = ingest(root, { ...plain(), motivated_by: '  ' });
  assert.equal(blank.status, 65);
  assert.match(blank.stderr, /motivated_by/u);
});

test('--from-candidate refuses an unknown schema major with exit 78', () => {
  const run = ingest(repoRoot(), { ...plain(), schema: 'krn.candidate/v2' });
  assert.equal(run.status, 78, run.stderr);
});

test('--from-candidate refuses a record draft that is not a trial', () => {
  const draft = { ...plain().record_draft, status: 'accepted' };
  const run = ingest(repoRoot(), { ...plain(), record_draft: draft });
  assert.equal(run.status, 65);
  assert.match(run.stderr, /record_draft\.status/u);
});

test('a second candidate inside a week is refused with exit 75', () => {
  const root = repoRoot();
  assert.equal(ingest(root, plain()).status, 0);
  const second = { ...plain(), id: 'c-two' };
  const run = ingest(root, second);
  assert.equal(run.status, 75, run.stderr);
  assert.match(run.stderr, /weekly cap/u);
});

test('a week with 10 USD of verdict cost refuses a new candidate with exit 75', () => {
  const root = repoRoot();
  mkdirSync(join(root, VERDICT_DIR), { recursive: true });
  writeFileSync(
    join(root, VERDICT_DIR, 'old.json'),
    JSON.stringify({
      schema: 'krn.verdict/v1',
      id: 'old',
      n: 30,
      delta: 0,
      p: 0.9,
      cost_usd: 10,
      decision: 'reject',
      recorded_at: today,
    }),
  );
  const run = ingest(root, plain());
  assert.equal(run.status, 75, run.stderr);
  assert.match(run.stderr, /10 USD/u);
});
