import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/product-release.sh', import.meta.url),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Writes a fake bin/krn whose smoke (`doctor`) exits with `code`. */
async function entry(work: string, code: number): Promise<void> {
  await mkdir(join(work, 'bin'), { recursive: true });
  await writeFile(join(work, 'bin', 'krn'), `#!/bin/sh\nexit ${code}\n`);
  await chmod(join(work, 'bin', 'krn'), 0o755);
}

test('the pinned Product checkout follows origin/main, not the working checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-product-release-'));
  try {
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    git(work, 'config', 'user.email', 't@example.invalid');
    git(work, 'config', 'user.name', 't');
    await writeFile(join(work, 'a'), '1');
    await entry(work, 0);
    git(work, 'add', 'a', 'bin/krn');
    git(work, 'commit', '-qm', 'one');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const first = git(work, 'rev-parse', 'HEAD');

    const run = (flag: string) =>
      execFileSync('bash', [script, flag], {
        cwd: work,
        encoding: 'utf8',
      }).trim();
    assert.equal(
      run('--entry'),
      join(work, '.krn', 'product-release', 'bin', 'krn'),
    );
    assert.equal(run('--commit'), first);

    // Switching the working checkout to another branch does not move the entry.
    git(work, 'checkout', '-q', '-b', 'feature');
    await writeFile(join(work, 'a'), '2');
    git(work, 'commit', '-qam', 'feature');
    const release = join(work, '.krn', 'product-release');
    assert.equal(git(release, 'rev-parse', 'HEAD'), first);
    assert.equal(await readFile(join(release, 'a'), 'utf8'), '1');

    // After origin/main moves, a refresh advances the pinned checkout.
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const second = git(work, 'rev-parse', 'HEAD');
    assert.equal(run('--commit'), second);
    assert.equal(git(release, 'rev-parse', 'HEAD'), second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a candidate that fails its smoke leaves the previous commit and names it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-product-release-'));
  try {
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    git(work, 'config', 'user.email', 't@example.invalid');
    git(work, 'config', 'user.name', 't');
    await entry(work, 0);
    git(work, 'add', 'bin/krn');
    git(work, 'commit', '-qm', 'good');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const good = git(work, 'rev-parse', 'HEAD');
    const first = execFileSync('bash', [script], {
      cwd: work,
      encoding: 'utf8',
    });
    assert.match(first, /^previous=none$/mu);
    assert.match(first, new RegExp(`^commit=${good}$`, 'mu'));

    await entry(work, 1);
    git(work, 'commit', '-qam', 'broken');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const broken = git(work, 'rev-parse', 'HEAD');
    const failed = spawnSync('bash', [script], { cwd: work, encoding: 'utf8' });
    assert.equal(failed.status, 78);
    assert.equal(
      failed.stderr,
      `product-release: candidate ${broken} failed bin/krn doctor; kept previous=${good}\n`,
    );
    const release = join(work, '.krn', 'product-release');
    assert.equal(git(release, 'rev-parse', 'HEAD'), good);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
