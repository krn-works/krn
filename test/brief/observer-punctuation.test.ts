import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const cli = resolve('src/cli/main.ts');
const observer = 'test/cli/verify-strict-evidence.test.ts';

test('brief check takes a Proof observer path that ends in punctuation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  mkdirSync(join(dir, 'spec'));
  writeFileSync(
    join(dir, 'spec/worker-scope.json'),
    JSON.stringify({
      supportedVersions: ['0.166.0'],
      forbidden: ['tasks/**'],
      review: [],
    }),
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'fixture',
  );
  writeFileSync(join(dir, 'checklist'), '- `symlink`: paths\n');
  for (const proof of [
    `Observer \`${observer}\`: it extends test/cli/verify.test.ts.`,
    `Observer ${observer}, then test/cli/verify.test.ts.`,
    `(${observer}) and test/cli/verify.test.ts.`,
  ]) {
    writeFileSync(
      join(dir, 'brief'),
      `## Allowed paths\n${observer}\n## Steps\n1. Write ${observer} and run it red\n## Proof\n${proof}\n## Hardening\n- symlink: covered\n`,
    );
    const r = spawnSync(
      process.execPath,
      [
        cli,
        'brief',
        'check',
        'brief',
        '--checklist',
        'checklist',
        '--repo',
        dir,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${proof}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^PASS /mu);
    assert.ok(r.stdout.includes(`--observer '${observer}'`), r.stdout);
  }
});
