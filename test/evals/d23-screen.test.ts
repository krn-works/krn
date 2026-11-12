import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPrompt,
  interfaceModules,
  parseReply,
  replyText,
} from '../../evals/d23/screen.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('the judge prompt carries the task, interface, repository module and hidden test text', () => {
  const prompt = buildPrompt({
    task: 'Task t-aaaaaaa: greet politely',
    iface: '- `src/greet.ts` exports `greet`',
    tests: [{ path: 'test/greet.test.ts', source: 'assert.equal(x, "Hallo")' }],
    modules: [{ path: 'src/greet.ts', source: 'export const old = 1;' }],
  });
  for (const part of [
    'greet politely',
    '`src/greet.ts` exports `greet`',
    'export const old = 1;',
    'assert.equal(x, "Hallo")',
    'D = ',
  ])
    assert.ok(prompt.includes(part.replace('D = ', '- D:')), part);
});

test('a hidden test is capped in the prompt', () => {
  const prompt = buildPrompt({
    task: 't',
    iface: '',
    tests: [{ path: 'a.test.ts', source: 'x'.repeat(50_000) }],
    modules: [],
  });
  assert.ok(prompt.length < 20_000);
});

test('the parser accepts a fenced reply and rejects one without a class', () => {
  const ok = parseReply(
    '```json\n{"class":"P","reason":"r","evidence":"e"}\n```',
  );
  assert.deepEqual(ok, { class: 'P', reason: 'r', evidence: 'e' });
  assert.throws(() => parseReply('{"reason":"r"}'), /class/);
  assert.throws(() => parseReply('{"class":"X"}'), /class/);
  assert.throws(() => parseReply('no json here'), /JSON/);
  assert.throws(() => replyText('{"is_error":true,"result":"x"}'), /result/);
});

test('interface modules come from the paragraph and skip tests', () => {
  assert.deepEqual(
    interfaceModules(
      '- `a/b.ts` exports `x`\n- `a/b.ts` exports `y`\n- `t/c.test.ts` exports `z`',
    ),
    ['a/b.ts'],
  );
});

test('screen.ts drives a fake claude with the real prompt and writes the screen file, resumably', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-screen-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'README'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const parent = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(
      join(repo, 'tasks/t-abcdefg.json'),
      JSON.stringify({ id: 't-abcdefg', title: 'Say hi', body: ['line one'] }),
    );
    writeFileSync(join(repo, 'test/hi.test.ts'), '// HIDDEN-MARKER');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat: hi (t-abcdefg) (#7)');
    const merge = git(repo, 'rev-parse', 'HEAD').trim();
    const grades = join(root, 'grades');
    mkdirSync(grades);
    writeFileSync(
      join(grades, '7.classify.json'),
      JSON.stringify({
        pr: '7',
        parent,
        merge,
        failToPass: ['test/hi.test.ts'],
      }),
    );
    const iface = join(root, 'iface');
    mkdirSync(iface);
    writeFileSync(join(iface, '7.txt'), '- `src/hi.ts` exports `hi`');
    writeFileSync(join(root, 'units.txt'), '7\n');
    const seen = join(root, 'prompt.txt');
    const fake = join(root, 'claude');
    writeFileSync(
      fake,
      `#!/bin/sh\ncat > ${seen}\necho '{"result":"{\\"class\\":\\"N\\",\\"reason\\":\\"r\\",\\"evidence\\":\\"e\\"}"}'\n`,
    );
    chmodSync(fake, 0o755);
    const out = join(root, 'out');
    const run = () =>
      spawnSync(
        process.execPath,
        [
          'evals/d23/screen.ts',
          '--iface',
          iface,
          '--out',
          out,
          '--grades',
          grades,
          '--units-file',
          join(root, 'units.txt'),
          '--repo',
          repo,
          '--claude',
          fake,
        ],
        { encoding: 'utf8', cwd: join(import.meta.dirname, '../..') },
      );
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const screen = JSON.parse(readFileSync(join(out, '7.screen.json'), 'utf8'));
    assert.equal(screen.class, 'N');
    const prompt = readFileSync(seen, 'utf8');
    for (const part of ['Say hi', 'line one', 'HIDDEN-MARKER', '`src/hi.ts`'])
      assert.ok(prompt.includes(part), part);
    rmSync(seen);
    assert.equal(run().status, 0);
    assert.ok(!existsSync(seen), 'an existing screen file is not judged again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
