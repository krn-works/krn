import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const cli = resolve('src/cli/main.ts');
const observer = 'test/brief/example.test.ts';
const brief = (answer: string, step = `Run ${observer} red`) =>
  `## Allowed paths\nsrc/a.ts\n## Steps\n1. ${step}\n## Proof\n\`${observer}\`\n## Hardening\n- symlink: covered\n- text-grammar: ${answer}\n`;

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-text-grammar-'));
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
  writeFileSync(
    join(dir, 'checklist'),
    '- `symlink`: paths\n- `text-grammar`: CRLF, a BOM\n',
  );
  const writeObserver = (source: string | undefined) => {
    mkdirSync(join(dir, 'test/brief'), { recursive: true });
    if (source === undefined) rmSync(join(dir, observer), { force: true });
    else writeFileSync(join(dir, observer), source);
  };
  const check = (text: string) => {
    writeFileSync(join(dir, 'brief'), text);
    return spawnSync(
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
  };
  return { writeObserver, check };
}

test('a CRLF or BOM claim needs a literal fixture in the existing observer', (t) => {
  const f = setup(t);
  const cases: [string, string, number, RegExp?][] = [
    [
      'CRLF lines stay verbatim',
      'assert.equal(1, 1); // CRLF\n',
      65,
      /text-grammar claims CRLF.*test\/brief\/example\.test\.ts/u,
    ],
    ['CRLF lines stay verbatim', "const s = 'a\\r\\nb';\n", 0],
    [
      'a leading BOM is stripped',
      "const s = 'a\\r\\nb';\n",
      65,
      /text-grammar claims BOM/u,
    ],
    ['a leading BOM is stripped', "const s = '\\uFEFFa';\n", 0],
    ['a leading byte order mark is stripped', "const s = '\\ufeffa';\n", 0],
    ['a leading BOM is stripped', "const s = '\uFEFFa';\n", 0],
    ['a leading BOM is stripped', "\uFEFFconst s = 'a';\n", 65, /claims BOM/u],
    ['crlf and bom both kept', "const s = '\\uFEFFa';\n", 65, /claims CRLF/u],
    ['N/A: no text is parsed', 'assert.ok(true);\n', 0],
    ['fences and indent covered', 'assert.ok(true);\n', 0],
  ];
  for (const [answer, source, status, reason] of cases) {
    f.writeObserver(source);
    const r = f.check(brief(answer));
    assert.equal(r.status, status, `${answer}: ${r.stderr}`);
    if (reason) assert.match(r.stderr, reason);
  }
});

test('before the observer exists, step 1 must name the claimed fixture', (t) => {
  const f = setup(t);
  f.writeObserver(undefined);
  const refused = f.check(brief('CRLF lines stay verbatim'));
  assert.equal(refused.status, 65, refused.stderr);
  assert.match(refused.stderr, /step 1 must write a CRLF fixture/u);
  const accepted = f.check(
    brief(
      'CRLF lines stay verbatim',
      `Write ${observer} with a CRLF fixture; run it red`,
    ),
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  const bom = f.check(
    brief(
      'BOM and CRLF stripped',
      `Write ${observer} with a CRLF fixture; run it red`,
    ),
  );
  assert.equal(bom.status, 65);
  assert.match(bom.stderr, /step 1 must write a BOM fixture/u);
});
