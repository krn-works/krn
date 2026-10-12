import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

test('krn review maps a runtime failure to exit code 70', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-review-runtime-'));
  const outside = await mkdtemp(join(tmpdir(), 'krn-review-runtime-state-'));
  try {
    const lens = join(directory, 'lens.md');
    await writeFile(lens, 'Review the change.\n');
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
    await writeFile(join(directory, 'README.md'), 'runtime fixture\n');
    git('add', 'README.md', 'lens.md');
    git('commit', '-qm', 'create review fixture');
    const head = git('rev-parse', 'HEAD');
    await symlink(outside, join(directory, '.krn'));
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'review',
        '--repo',
        directory,
        '--base',
        head,
        '--head',
        head,
        '--lens',
        lens,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /unsafe repository state directory/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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
  assert.equal(reviewOutcomeExitCode('OVERRIDE'), 0);
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

test('unknown commands forward arguments, streams, and exit code to the legacy binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-'));
  try {
    const legacy = join(directory, 'legacy.mjs');
    await writeFile(
      legacy,
      [
        'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), forwarded: process.env.KRN_FORWARDED }));',
        "process.stderr.write('legacy stderr\\n');",
        'process.exitCode = 23;',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [cli, 'legacy-command', 'one'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: legacy, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 23);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['legacy-command', 'one'],
      forwarded: '1',
    });
    assert.equal(result.stderr, 'legacy stderr\n');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('forwarding guard blocks a recursive legacy invocation', () => {
  const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
    encoding: 'utf8',
    env: { ...process.env, KRN_LEGACY_ENTRY: cli, KRN_FORWARDED: '' },
  });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /recursion blocked/u);
});

test('legacy entry defaults under the current Codex installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-home-'));
  try {
    const legacy = join(directory, '.codex/krn/current/scripts/krn.mjs');
    await mkdir(join(directory, '.codex/krn/current/scripts'), {
      recursive: true,
    });
    await writeFile(legacy, "process.stdout.write('default legacy');");
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        KRN_LEGACY_ENTRY: '',
        KRN_FORWARDED: '',
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'default legacy');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('realpath recursion guard blocks a symlink to the CLI itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-cli-link-'));
  try {
    const alias = join(directory, 'legacy-link.mjs');
    await symlink(cli, alias);
    const result = spawnSync(process.execPath, [cli, 'legacy-command'], {
      encoding: 'utf8',
      env: { ...process.env, KRN_LEGACY_ENTRY: alias, KRN_FORWARDED: '' },
    });
    assert.equal(result.status, 70);
    assert.match(result.stderr, /recursion blocked/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
