import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const api = await import('../../src/brief/index.ts').catch(() => undefined);
const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));
const checklist = fileURLToPath(
  new URL('../../docs/program/hardening-checklist.md', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('../fixtures/brief/without-hardening.md', import.meta.url),
);
const ids = [
  ...(existsSync(checklist) ? readFileSync(checklist, 'utf8') : '').matchAll(
    /^- `([^`]+)`: /gmu,
  ),
].map((match) => match[1]);
const answers = ids.map((id) => `- ${id}: covered`).join('\n');
const complete = `# Brief\n\n## Hardening\n${answers}\n`;

function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.checkBrief, 'function');
  assert.ok(ids.length > 0, 'the checklist must define classes');
  const root = mkdtempSync(join(tmpdir(), 'krn-brief-hardening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, complete);
  const run = (args = ['check', brief, '--checklist', checklist], cwd = root) =>
    spawnSync(process.execPath, [cli, 'brief', ...args], {
      cwd,
      encoding: 'utf8',
    });
  return { root, brief, run };
}

test('brief CLI rejects the verbatim PR brief and accepts every checklist class', (t) => {
  const f = setup(t);
  const failed = f.run(['check', fixture, '--checklist', checklist]);
  assert.equal(failed.status, 65);
  assert.equal(failed.stdout, `FAIL ${fixture}\n`);
  assert.match(failed.stderr, /missing.*Hardening/u);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().stdout, `PASS ${f.brief}\n`);
  assert.equal(f.run().stderr, '');
});

test('brief grammar rejects missing, repeated, unknown and empty answers', (t) => {
  const f = setup(t);
  for (const [text, reason] of [
    [complete.replace('- symlink: covered\n', ''), /missing.*symlink/u],
    [`${complete}- symlink: again\n`, /duplicate.*symlink/u],
    [`${complete}* unknown: answer\n`, /unknown.*unknown/u],
    [complete.replace('symlink: covered', 'symlink:   '), /empty.*symlink/u],
    [complete.replace('symlink: covered', 'symlink: N/A'), /empty.*symlink/u],
    [
      complete.replace('symlink: covered', 'symlink: N/A:   '),
      /empty.*symlink/u,
    ],
    [`${complete}## Hardening\n${answers}`, /duplicate.*Hardening/u],
    [`\`\`\`markdown\n${complete}\`\`\`\n`, /missing.*Hardening/u],
    [`~~~\n${complete}~~~\n`, /missing.*Hardening/u],
    [
      complete.replace('## Hardening', '    ## Hardening'),
      /missing.*Hardening/u,
    ],
    [complete.replace('## Hardening', '###  Hardening'), /missing.*Hardening/u],
    [`## Hardening\n## Proof\n${answers}`, /missing.*symlink/u],
    [`## Hardening\n# Proof\n${answers}`, /missing.*symlink/u],
    [`## Hardening\n~~~\n${answers}\n~~~`, /missing.*symlink/u],
    [
      complete.replace('## Hardening', '## Hardening###'),
      /missing.*Hardening/u,
    ],
  ] as const) {
    writeFileSync(f.brief, text);
    const result = f.run();
    assert.equal(result.status, 65, text);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, `FAIL ${f.brief}\n`);
  }
  writeFileSync(
    f.brief,
    `## Hardening\n${Array.from({ length: 100 }, (_, i) => `- unknown-${i}: value`).join('\n')}`,
  );
  const capped = f.run();
  assert.equal(capped.status, 65);
  assert.equal(capped.stderr.trimEnd().split('\n').length, 64);
  const longId = 'x'.repeat(10_000);
  for (const text of [
    `## Hardening\n- ${longId}: value\n`,
    `## Hardening\n- ${longId}: first\n- ${longId}: second\n`,
  ]) {
    writeFileSync(f.brief, text);
    const bounded = f.run();
    assert.equal(bounded.status, 65);
    assert.ok(
      bounded.stderr
        .trimEnd()
        .split('\n')
        .every((line) => Buffer.byteLength(line) < 200),
    );
    assert.ok(bounded.stderr.includes(`${'x'.repeat(64)}…`));
  }
});

test('brief grammar accepts BOM, CRLF, ATX closing hashes, fences and backticked ids', (t) => {
  const f = setup(t);
  for (const text of [
    `\uFEFF${complete.replaceAll('\n', '\r\n')}`,
    complete.replace('## Hardening', '   ## Hardening ###   '),
    complete.replace('## Hardening', '## Hardening   '),
    complete.replaceAll(/- ([^:]+):/gu, '* `$1`:'),
    complete.replace('symlink: covered', 'symlink: N/A: reads only'),
    `\`\`\`\`markdown\n## Hardening\n\`\`\`\n## Hardening\n\`\`\`\`\n${complete}`,
    `~~~text\n## Hardening\n\`\`\`\n~~~\n${complete}`,
    `${complete}## Proof\n- unknown: ignored\n`,
    complete.replace('## Hardening', '## Hardening\n### Detail'),
  ]) {
    writeFileSync(f.brief, text);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `PASS ${f.brief}\n`);
  }
  const withoutSymlink = complete.replace('- symlink: covered\n', '');
  for (const underline of ['---', '===']) {
    writeFileSync(
      f.brief,
      `${withoutSymlink}Next\n${underline}\n- symlink: covered\n`,
    );
    const result = f.run();
    assert.equal(result.status, 65);
    assert.match(result.stderr, /missing id symlink/u);
  }
  writeFileSync(f.brief, `${withoutSymlink}\n---\n- symlink: covered\n`);
  const thematicBreak = f.run();
  assert.equal(thematicBreak.status, 0, thematicBreak.stderr);
});

test('brief CLI refuses file types and bounds with data exit 65', (t) => {
  const f = setup(t);
  const link = join(f.root, 'link');
  symlinkSync(f.brief, link);
  for (const path of [link, f.root, join(f.root, 'missing')]) {
    const result = f.run(['check', path, '--checklist', checklist]);
    assert.equal(result.status, 65);
    assert.ok(result.stderr.length > 0);
  }
  for (const path of [link, f.root, join(f.root, 'missing')]) {
    assert.equal(f.run(['check', f.brief, '--checklist', path]).status, 65);
  }
  writeFileSync(f.brief, 'x'.repeat(256 * 1024 + 1));
  assert.equal(f.run().status, 65);
  writeFileSync(f.brief, complete.padEnd(256 * 1024, ' '));
  assert.equal(f.run().status, 0);
  writeFileSync(f.brief, complete);
  const list = join(f.root, 'list.md');
  for (const text of [
    '',
    '# No classes',
    'x'.repeat(32 * 1024 + 1),
    Array.from({ length: 65 }, (_, i) => `- \`class-${i}\`: text`).join('\n'),
  ]) {
    writeFileSync(list, text);
    assert.equal(f.run(['check', f.brief, '--checklist', list]).status, 65);
  }
  writeFileSync(list, readFileSync(checklist, 'utf8').padEnd(32 * 1024, ' '));
  assert.equal(f.run(['check', f.brief, '--checklist', list]).status, 0);
});

test('brief CLI enforces usage and resolves its default at the current git top level', (t) => {
  const f = setup(t);
  for (const args of [
    [],
    ['check'],
    ['other', f.brief],
    ['check', f.brief, '--checklist'],
    ['check', f.brief, '--unknown'],
    ['check', f.brief, 'extra'],
    ['check', f.brief, '--checklist', checklist, '--checklist', checklist],
  ]) {
    assert.equal(f.run(args).status, 64);
  }
  const init = spawnSync('git', ['init', '-q', f.root]);
  assert.equal(init.status, 0);
  mkdirSync(join(f.root, 'docs/program'), { recursive: true });
  writeFileSync(
    join(f.root, 'docs/program/hardening-checklist.md'),
    readFileSync(checklist),
  );
  const nested = join(f.root, 'nested');
  mkdirSync(nested);
  assert.equal(f.run(['check', f.brief], nested).status, 0);
});
