import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// Five stacks audit in parallel; a loaded host needs more than the default minute.
test('every applicable enforced record bites in each init stack', {
  timeout: 240_000,
}, async () => {
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

// The plainest hand-written Rust layouts: a workspace whose lock sits at the root, a library whose unwrap
// lives in its test module, an async test attribute, and the toolchain pinned by a rust-toolchain file.
test('the Rust records accept the plain layouts and refuse the plain violations', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'rust-records-'));
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(scratch, name)), { recursive: true });
    writeFileSync(join(scratch, name), text);
  };
  const check = (record: string) => {
    spawnSync('git', ['add', '-A'], { cwd: scratch });
    return spawnSync(
      process.execPath,
      [cli, 'standards', 'check', '--root', scratch, '--record', record],
      { encoding: 'utf8' },
    ).status;
  };
  try {
    spawnSync('git', [...identity, 'init', '-q', '-b', 'main'], {
      cwd: scratch,
    });
    write('Cargo.toml', '[workspace]\nmembers = ["crates/a"]\n');
    write('crates/a/Cargo.toml', '[package]\nname = "a"\nversion = "0.1.0"\n');
    write('Cargo.lock', 'version = 4\n');
    write(
      'crates/a/src/lib.rs',
      'pub fn f() -> i32 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    #[tokio::test]\n    async fn g() {\n        Some(1).unwrap();\n    }\n}\n',
    );
    write('rust-toolchain.toml', '[toolchain]\nchannel = "1.80"\n');
    write(
      '.github/workflows/ci.yml',
      'on: pull_request\njobs:\n  c:\n    steps:\n      - run: cargo clippy -- -D warnings\n',
    );
    for (const record of [
      's-rust-lock-committed',
      's-rust-no-library-unwrap',
      's-rust-pinned-toolchain',
      's-rust-tests-present',
      's-rust-clippy-deny-warnings',
    ])
      assert.equal(check(record), 0, record);
    write(
      'crates/a/src/lib.rs',
      'pub fn f() -> i32 {\n    Some(1).unwrap()\n}\n',
    );
    assert.equal(check('s-rust-no-library-unwrap'), 1);
    assert.equal(check('s-rust-tests-present'), 1);
    rmSync(join(scratch, 'Cargo.lock'));
    assert.equal(check('s-rust-lock-committed'), 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('every enforced boilerplate frontend and WordPress record has a plant, so the matrix bites on it', () => {
  const pack = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../standards/records.json', import.meta.url)),
      'utf8',
    ),
  ) as {
    id: string;
    status: string;
    provenance: { origin: string };
    enforcement: { kind: string };
  }[];
  const enforced = pack.filter(
    (r) =>
      r.status === 'accepted' &&
      r.provenance.origin.startsWith('boilerplate-2026 ') &&
      r.enforcement.kind !== 'advisory',
  );
  assert.ok(enforced.length >= 4, `only ${enforced.length} records`);
  for (const record of enforced)
    assert.ok(PLANTS[record.id], `${record.id} has no plant`);
});
