import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listCiChecks, wiredCommand } from '../../scripts/lib/ci-checks.ts';

const root = join(import.meta.dirname, '../..');

interface Own {
  id: string;
  applies: { paths: string[] };
  enforcement: { kind: string; run?: string };
  provenance: { evidence: string[] };
  recorded_at: string;
}

function ownRecords(): Own[] {
  return JSON.parse(
    readFileSync(join(root, '.agents/standards.json'), 'utf8'),
  ) as Own[];
}

function unmapped(checks: readonly string[], records: readonly Own[]) {
  const wired = new Set(records.map((r) => r.enforcement.run));
  return checks.filter((check) => !wired.has(wiredCommand(check)));
}

test('every check CI runs maps to one enforced, scoped, dated record with evidence', () => {
  const checks = listCiChecks(root);
  assert.ok(checks.length >= 38, `read ${checks.length} checks`);
  const records = ownRecords();
  assert.deepEqual(unmapped(checks, records), []);
  for (const check of checks) {
    const mapped = records.filter(
      (r) => r.enforcement.run === wiredCommand(check),
    );
    assert.equal(mapped.length, 1, `${check}: ${mapped.length} records`);
    const record = mapped[0] as Own;
    assert.equal(record.enforcement.kind, 'command', record.id);
    assert.ok(record.applies.paths.length > 0, `${record.id}: path scope`);
    assert.ok(record.provenance.evidence.length > 0, `${record.id}: evidence`);
    assert.match(record.recorded_at, /^\d{4}-\d{2}-\d{2}$/u, record.id);
  }
});

test('the lists come from package.json and the workflow, not a copy', () => {
  const checks = listCiChecks(root);
  for (const expected of [
    'biome check --error-on-warnings .',
    'node scripts/boundaries.ts',
    'node src/cli/main.ts task check --quality',
    'tsc --noEmit',
    'node scripts/commit-title.ts',
    'node src/cli/main.ts task check',
    'npm test',
  ])
    assert.ok(checks.includes(expected), expected);
  assert.ok(
    checks.includes('node --test test/rules/shard-weight-coverage.test.mjs'),
  );
});

test('a new CI step or guard test without a record is reported unmapped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-rule-coverage-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'test/rules'), { recursive: true });
    cpSync(
      join(root, '.github/workflows/ci.yml'),
      join(dir, '.github/workflows/ci.yml'),
    );
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    cpSync(join(root, 'krn.json'), join(dir, 'krn.json'));
    writeFileSync(join(dir, 'test/rules/new-guard.test.ts'), '');
    const checks = listCiChecks(dir);
    assert.deepEqual(unmapped(checks, ownRecords()), [
      'node --test test/rules/new-guard.test.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the wiring command passes for a CI check and fails for any other', () => {
  const run = (check: string) =>
    spawnSync('node', ['scripts/ci-check-wired.ts', check], {
      cwd: root,
      encoding: 'utf8',
    });
  assert.equal(run('npm test').status, 0);
  const other = run('npm run nothing');
  assert.equal(other.status, 1);
  assert.match(other.stderr, /not a check CI runs: npm run nothing/u);
});
