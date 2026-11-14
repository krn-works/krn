import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: a real testless git repository through the real `krn adopt` entry and the real Stop gate.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function testless(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-bootstrap-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'index.php'), '<?php echo "hi";\n');
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('adopt on a testless repository exits 0, keeps the adoption set and records the bootstrap state', () => {
  const root = testless();
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /canary bootstrap: .*vacuous.*Stop gate refused it \(exit 2\)/u,
  );
  assert.doesNotMatch(run.stderr, /everything adopt wrote was removed/u);
  assert.ok(existsSync(join(root, 'krn.json')));
  assert.ok(existsSync(join(root, '.claude/settings.json')));
  assert.ok(existsSync(join(root, 'tasks')));
  const contract = JSON.parse(readFileSync(join(root, 'krn.json'), 'utf8'));
  assert.equal(contract.vacuous, true);
});

test('--canary on a bootstrap repository reports bootstrap, not a skip, and exits 0', () => {
  const root = testless();
  assert.equal(
    spawnSync(process.execPath, [cli, 'adopt', root, '--no-canary'], {
      encoding: 'utf8',
    }).status,
    0,
  );
  const run = spawnSync(process.execPath, [cli, 'adopt', root, '--canary'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary bootstrap:/u);
});
