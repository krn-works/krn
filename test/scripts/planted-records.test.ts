import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLANTS } from '../../scripts/lib/record-plants.ts';
import {
  biteReport,
  INIT_STACK_NAMES,
  initProject,
  plantedMatrix,
} from '../../scripts/standards-audit.ts';

// KRN-12: the real receiver. Every enforced pack record that applies to a project born by
// `krn adopt --init` is violated in the plainest way; its check goes red naming the record and its
// remedy, and green after the revert. A record without a plant fails the matrix.
const audit = fileURLToPath(
  new URL('../../scripts/standards-audit.ts', import.meta.url),
);
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function run(stack: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [audit, '--planted', stack], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('every applicable enforced record bites in each init stack', async () => {
  const runs = await Promise.all(INIT_STACK_NAMES.map((stack) => run(stack)));
  for (const [index, done] of runs.entries()) {
    const stack = INIT_STACK_NAMES[index];
    assert.equal(done.status, 0, `${stack}: ${done.out}`);
    const match = /(\d+)\/(\d+) records bite/.exec(done.out);
    assert.ok(match, `${stack}: no report line in ${done.out}`);
    assert.equal(match[1], match[2], `${stack}: ${done.out}`);
    assert.ok(Number(match[1]) >= 30, `${stack}: only ${match[1]} records`);
  }
});

test('an enforced record without a plant, and a plant that does not bite, fail the matrix', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'planted-test-'));
  try {
    const { 's-go-vet-run': _removed, ...rest } = PLANTS;
    const results = plantedMatrix('go', scratch, {
      ...rest,
      's-go-wrapped-errors': () => ({}),
    });
    const status = (id: string) => results.find((r) => r.id === id)?.status;
    assert.equal(status('s-go-vet-run'), 'no-plant');
    assert.equal(status('s-go-wrapped-errors'), 'stays-green');
    assert.equal(status('s-go-sum-committed'), 'bites');
    assert.match(
      biteReport(results),
      /^go s-go-vet-run: no-plant/m,
      'the report names the record without a plant',
    );
    assert.doesNotMatch(biteReport(results), /(\d+)\/\1 records bite/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the real standards check names the record a plant turns red', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'planted-test-'));
  try {
    const dir = initProject('go', scratch);
    const check = () =>
      spawnSync(
        process.execPath,
        [
          cli,
          'standards',
          'check',
          '--root',
          dir,
          '--record',
          's-no-secrets-tracked',
        ],
        { encoding: 'utf8' },
      );
    assert.equal(check().status, 0);
    writeFileSync(join(dir, '.env'), 'TOKEN=1\n');
    spawnSync('git', ['add', '.env'], { cwd: dir });
    const red = check();
    assert.equal(red.status, 1);
    assert.match(red.stdout + red.stderr, /s-no-secrets-tracked/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
