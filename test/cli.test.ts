import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('krn review maps invalid argument values to exit code 64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-invalid-'));
  try {
    const lens = join(directory, 'lens.md');
    await writeFile(lens, 'Review the change.\n');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        'b'.repeat(40),
        '--head',
        'c'.repeat(40),
        '--lens',
        lens,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 64, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('krn review maps an invalid base revision to exit code 64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-base-'));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('config', 'user.name', 'KRN CLI test');
    git('config', 'user.email', 'krn-test@example.invalid');
    await writeFile(join(directory, 'README.md'), 'review fixture\n');
    await writeFile(join(directory, 'lens.md'), 'Review the change.\n');
    git('add', 'README.md', 'lens.md');
    git('commit', '-qm', 'create review fixture');
    const head = git('rev-parse', 'HEAD');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        'missing-review-base',
        '--head',
        head,
        '--lens',
        join(directory, 'lens.md'),
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 64, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('review verdict and error exit codes are stable', async () => {
  const mainSource = readFileSync(
    new URL('../src/cli/main.ts', import.meta.url),
    'utf8',
  );
  const flowSource = readFileSync(
    new URL('../src/flow/cli.ts', import.meta.url),
    'utf8',
  );
  assert.match(mainSource, /export function reviewOutcomeExitCode/u);
  assert.match(flowSource, /export class ReviewUsageError/u);
  const [{ reviewErrorExitCode, reviewOutcomeExitCode }, { ReviewUsageError }] =
    await Promise.all([
      import('../src/cli/main.ts'),
      import('../src/flow/cli.ts'),
    ]);

  assert.equal(reviewOutcomeExitCode('PASS'), 0);
  assert.equal(reviewOutcomeExitCode('FAIL'), 1);
  assert.equal(reviewOutcomeExitCode('INCOMPLETE'), 2);
  assert.equal(reviewErrorExitCode(new ReviewUsageError('bad arguments')), 64);
  assert.equal(reviewErrorExitCode(new Error('runtime failure')), 70);
});

test('krn --version reports the package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'krn 0.1.0\n');
});

test('unknown and retired commands exit 64 with a clear stderr message and print nothing to stdout', () => {
  for (const command of ['ship', 'gate', 'verify', 'start', 'delegate']) {
    const result = spawnSync(process.execPath, [cli, command], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 64, command);
    assert.equal(result.stdout, '', command);
    assert.match(result.stderr, new RegExp(`unknown command "${command}"`));
  }
});

test('state runs the named legacy entry with its arguments and exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-state-forward-'));
  try {
    const entry = join(directory, 'krn.mjs');
    await writeFile(
      entry,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n',
    );
    const result = spawnSync(
      process.execPath,
      [cli, 'state', 'check', '--root', '.'],
      { encoding: 'utf8', env: { ...process.env, KRN_STATE_ENTRY: entry } },
    );
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      'state',
      'check',
      '--root',
      '.',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('state exits 69 naming the missing legacy entry and prints nothing to stdout', () => {
  const entry = join(tmpdir(), 'krn-state-missing', 'krn.mjs');
  const result = spawnSync(process.execPath, [cli, 'state', 'resume'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_STATE_ENTRY: entry },
  });
  assert.equal(result.status, 69);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(entry), result.stderr);
});

test('krn --help lists only the owned commands and exits 0', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /krn task /);
  assert.doesNotMatch(result.stdout, /legacy|krn ship|krn gate/);
});
