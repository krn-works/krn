import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseUnified } from '../../src/brain/record.ts';
import { queryStandards } from '../../src/brain/worker-packet.ts';

// KRN-12: the real `krn standards query` entry reads the decisions file of a repository.
const repo = join(import.meta.dirname, '../..');
const krn = join(repo, 'bin/krn');

/** The plainest hand-written decision: id, type, text, three dates, source. */
const PLAIN =
  '{"id":"dec-x","type":"decision","text":"Merges go through auto-merge on the required Check.","recorded_at":"2026-11-01","valid_from":"2026-11-01","valid_to":null,"source":"ADR 0014"}';

function fixture(decisions: string): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-decisions-'));
  spawnSync('git', ['-C', root, 'init', '-q']);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents/decisions.json'), decisions);
  return root;
}

function query(root: string, ...args: string[]) {
  return spawnSync(krn, ['standards', 'query', ...args, '--root', root], {
    encoding: 'utf8',
  });
}

test('the schema accepts the three unserved types and the four new fields', () => {
  const [row] = parseUnified([
    {
      ...JSON.parse(PLAIN),
      type: 'preference',
      subject: 'merge-path',
      evidence_kind: 'operator-verbatim',
      superseded_by: 'dec-y',
      review_by: '2027-01-01',
    },
  ]);
  assert.equal(row?.type, 'preference');
  assert.equal(row?.evidence_kind, 'operator-verbatim');
  assert.throws(
    () => parseUnified([{ ...JSON.parse(PLAIN), evidence_kind: 'rumor' }]),
    /evidence_kind/u,
  );
});

test('query --type decision answers from a hand-written decisions file', () => {
  const root = fixture(`[${PLAIN}]`);
  const done = query(root, '--type', 'decision', 'auto-merge', '--json');
  assert.equal(done.status, 0, done.stderr);
  const rows = JSON.parse(done.stdout) as { id: string }[];
  assert.deepEqual(
    rows.map((row) => row.id),
    ['dec-x'],
  );
});

test('a decision is never served without the type filter', () => {
  const root = fixture(`[${PLAIN}]`);
  assert.deepEqual(
    queryStandards(root, {
      text: 'auto-merge required Check',
      files: [],
      asOf: '2026-11-16',
    })
      .map((hit) => hit.id)
      .filter((id) => id === 'dec-x'),
    [],
  );
  const done = query(root, 'auto-merge', '--json');
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stdout, /dec-x/u);
});

test('a superseded decision is not in force', () => {
  const closed = JSON.stringify({
    ...JSON.parse(PLAIN),
    valid_to: '2026-11-02',
    superseded_by: 'dec-y',
  });
  const root = fixture(`[${closed}]`);
  const done = query(root, '--type', 'decision', 'auto-merge', '--json');
  assert.deepEqual(JSON.parse(done.stdout), []);
});

test('this repository answers the task proof: at least one decision row for auto-merge', () => {
  const done = query(repo, '--type', 'decision', 'auto-merge', '--json');
  assert.equal(done.status, 0, done.stderr);
  assert.ok((JSON.parse(done.stdout) as unknown[]).length >= 1);
  for (const file of ['standards/records.json', '.agents/records.json']) {
    const types = (
      JSON.parse(readFileSync(join(repo, file), 'utf8')) as { type: string }[]
    ).map((row) => row.type);
    assert.ok(
      !types.some((t) => ['decision', 'preference', 'fact'].includes(t)),
    );
  }
});
