import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  harnessPlan,
  importClosure,
  layHarness,
  overlayFiles,
  relativeImports,
} from '../../evals/d23/harness.ts';

test('the replay harness keeps every file the merged change touched at the parent version', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-harness-'));
  const repo = join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (f: string, body: string) => {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body);
  };
  try {
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    put('AGENTS.md', 'v1\n');
    put('scripts/claude/a.ts', 'v1\n');
    put('scripts/claude/old.ts', 'v1\n');
    put('src/x.ts', 'v1\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');
    put('scripts/claude/a.ts', 'merged solution\n');
    git('commit', '-qam', 'merge');
    const merge = git('rev-parse', 'HEAD');
    put('AGENTS.md', 'v3\n');
    put('scripts/claude/a.ts', 'v3\n');
    put('scripts/claude/b.ts', 'v3\n');
    git('rm', '-q', 'scripts/claude/old.ts');
    git('add', '.');
    git('commit', '-qm', 'ref');
    const ref = git('rev-parse', 'HEAD');
    const plan = harnessPlan(repo, ref, parent, merge);
    assert.deepEqual(plan, {
      write: ['AGENTS.md', 'scripts/claude/b.ts'],
      remove: ['scripts/claude/old.ts'],
    });
    git('checkout', '-q', parent);
    layHarness(repo, repo, ref, plan);
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'v3\n');
    assert.equal(
      readFileSync(join(repo, 'scripts/claude/a.ts'), 'utf8'),
      'v1\n',
    );
    assert.equal(
      git('status', '--short'),
      'M AGENTS.md\n D scripts/claude/old.ts\n?? scripts/claude/b.ts'.trim(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the worker tree lists no lead-only rule line, lead skill or positive workflow paragraph', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-worker-rules-'));
  const repo = join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (f: string, body: string) => {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body);
  };
  const real = join(import.meta.dirname, '../..');
  try {
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    put('src/x.ts', 'v1\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');
    put('src/x.ts', 'merged\n');
    git('commit', '-qam', 'merge');
    const merge = git('rev-parse', 'HEAD');
    put('spec/rules.json', readFileSync(join(real, 'spec/rules.json'), 'utf8'));
    put('AGENTS.md', readFileSync(join(real, 'AGENTS.md'), 'utf8'));
    for (const skill of ['krn-lead', 'krn-handoff', 'krn-retro', 'typescript'])
      put(`.agents/skills/${skill}/SKILL.md`, `${skill}\n`);
    git('add', '.');
    git('commit', '-qm', 'ref');
    const ref = git('rev-parse', 'HEAD');
    git('checkout', '-q', parent);
    layHarness(repo, repo, ref, harnessPlan(repo, ref, parent, merge));
    const ruleLines = readFileSync(join(repo, 'AGENTS.md'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- **KRN-'));
    const leadOnly = [
      'KRN-07',
      'KRN-09',
      'KRN-10',
      'KRN-11',
      'KRN-12',
      'KRN-13',
      'KRN-14',
    ];
    assert.ok(ruleLines.length > 0, 'scope prohibitions stay');
    for (const line of ruleLines)
      for (const id of leadOnly)
        assert.ok(!line.includes(`**${id}**`), `${id} is visible to a worker`);
    assert.ok(ruleLines.some((l) => l.includes('**KRN-05**')));
    assert.ok(ruleLines.some((l) => l.includes('**KRN-06**')));
    assert.doesNotMatch(
      readFileSync(join(repo, 'AGENTS.md'), 'utf8'),
      /npm run fast|tracker|handoff|Check/u,
    );
    assert.deepEqual(
      execFileSync('ls', [join(repo, '.agents/skills')], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n'),
      ['typescript'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the overlay carries every file a worker hook imports, computed from the import graph', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const overlay = overlayFiles(repo, head);
  const missing: string[] = [];
  const walk = (file: string, seen: Set<string>) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of relativeImports(
      readFileSync(join(repo, file), 'utf8'),
    )) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (!existsSync(join(repo, target))) continue;
      if (!overlay.has(target)) missing.push(`${file} -> ${target}`);
      walk(target, seen);
    }
  };
  const seen = new Set<string>();
  for (const f of overlay)
    if (/^(?:scripts\/claude|src\/hook)\//u.test(f) && f.endsWith('.ts'))
      walk(f, seen);
  assert.deepEqual(missing, []);
  assert.ok(overlay.has('src/repo/contract.ts'), 'the Stop gate imports it');
});

test('a hook importing a file outside the overlay roots pulls it and its own imports in', () => {
  const files: Record<string, string> = {
    'scripts/claude/h.ts':
      "import { a } from '../../src/a.ts';\nawait import('./x.ts');",
    'scripts/claude/x.ts': 'export {};',
    'src/a.ts': "export { b } from './deep/b.ts';",
    'src/deep/b.ts': "import 'node:fs';",
    'src/unrelated.ts': '',
  };
  const got = importClosure(
    ['scripts/claude'],
    () => ['scripts/claude/h.ts', 'scripts/claude/x.ts'],
    (f) => files[f],
    'c',
  );
  assert.deepEqual(got, ['src/a.ts', 'src/deep/b.ts']);
});
