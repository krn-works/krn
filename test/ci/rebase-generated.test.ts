import assert from 'node:assert/strict';
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
import {
  generatedFiles,
  rebaseGenerated,
} from '../../src/ci/rebase-generated.ts';
import { run } from '../../src/deliver/transport.ts';

// KRN-12: a real temporary git repository and the real git rebase; the generator is a
// small script at the path the registry names, writing one line per src header.
const generator = `import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const lines = readdirSync('src').sort().map((f) => f + ': ' + readFileSync('src/' + f, 'utf8').split('\\n')[0]);
writeFileSync('docs/generated/capability-index.md', lines.join('\\n') + '\\n');
`;
const indexFile = 'docs/generated/capability-index.md';

function git(cwd: string, ...args: string[]): string {
  const result = run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
  );
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function edit(cwd: string, file: string, text: string, message: string) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
}

function commitRegenerated(cwd: string, file: string, header: string) {
  writeFileSync(join(cwd, file), `${header}\n`);
  assert.equal(
    run('node', ['scripts/claude/capability-index.ts'], cwd).code,
    0,
  );
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', header);
}

function setup(): { work: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'rebase-generated-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const main = join(root, 'main');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  for (const dir of ['src', 'docs/generated', 'scripts/claude'])
    mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'src/a.ts'), '// a\n');
  writeFileSync(join(work, 'src/b.ts'), '// b\n');
  writeFileSync(join(work, 'scripts/claude/capability-index.ts'), generator);
  assert.equal(
    run('node', ['scripts/claude/capability-index.ts'], work).code,
    0,
  );
  git(work, 'checkout', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, main);
  // The rebase under test commits with the repository's own identity (CI has no global one).
  for (const repo of [work, main]) {
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
  }
  return { work, main };
}

test('a conflict only in the generated index is regenerated from the rebased src', () => {
  const { work, main } = setup();
  git(work, 'checkout', '-q', '-b', 'lane');
  commitRegenerated(work, 'src/b.ts', '// b changed by the lane');
  commitRegenerated(main, 'src/a.ts', '// a changed on main');
  git(main, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin', 'main');

  assert.equal(rebaseGenerated(work, 'main', run), true);
  assert.equal(
    readFileSync(join(work, indexFile), 'utf8'),
    'a.ts: // a changed on main\nb.ts: // b changed by the lane\n',
  );
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(
    git(work, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'),
    '',
  );
});

test('a branch that merges cleanly is left untouched', () => {
  const { work, main } = setup();
  git(work, 'checkout', '-q', '-b', 'lane');
  edit(work, 'src/b.ts', '// b lane\n', 'lane');
  edit(main, 'src/a.ts', '// a main\n', 'main');
  git(main, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin', 'main');
  const before = git(work, 'rev-parse', 'HEAD');

  assert.equal(rebaseGenerated(work, 'main', run), false);
  assert.equal(git(work, 'rev-parse', 'HEAD'), before);
});

test('a conflict in any other file exits 76 and leaves no rebase running', () => {
  const { work, main } = setup();
  git(work, 'checkout', '-q', '-b', 'lane');
  commitRegenerated(work, 'src/a.ts', '// a lane');
  commitRegenerated(main, 'src/a.ts', '// a main');
  git(main, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin', 'main');
  const before = git(work, 'rev-parse', 'HEAD');

  assert.throws(
    () => rebaseGenerated(work, 'main', run),
    (error: Error & { exitCode?: number }) =>
      error.exitCode === 76 && /src\/a\.ts/u.test(error.message),
  );
  assert.equal(git(work, 'rev-parse', 'HEAD'), before);
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test('every registered generated file names a generator script this repository has', () => {
  for (const [file, [command, args]] of Object.entries(generatedFiles)) {
    assert.equal(command, 'node', file);
    assert.ok(existsSync(args[0] ?? ''), `${file}: ${args[0]} missing`);
    assert.ok(existsSync(file), `${file} missing`);
  }
});
