import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A dynamic URL keeps an absent base implementation an assertion failure.
const mod = await import(
  new URL('../../scripts/lib/adr-index.ts', import.meta.url).href
).catch(() => undefined);

interface AdrFile {
  file: string;
  text: string;
}
type Check = (index: string, adrs: readonly AdrFile[]) => string[];

const check = (index: string, adrs: readonly AdrFile[]): string[] => {
  assert.equal(typeof mod?.checkAdrIndex, 'function');
  return (mod.checkAdrIndex as Check)(index, adrs);
};

const adr = (status: string, rows: readonly number[] = []): string =>
  [
    '# ADR',
    '',
    '## Status',
    '',
    status,
    '',
    '## Decisions',
    '',
    '| ID | Decision |',
    '|---|---|',
    ...rows.map((n) => `| D${n} | decision ${n} |`),
    '',
  ].join('\n');

const index = (...rows: readonly string[]): string =>
  [
    '# Architecture decisions',
    '',
    '| ADR | Status | Decision |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');

const range = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1);

const good = (): { index: string; adrs: AdrFile[] } => ({
  index: index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  ),
  adrs: [
    { file: '0001-a.md', text: adr('Accepted for E1 scaffold.') },
    { file: '0011-b.md', text: adr('Superseded by ADR 0014 D8.') },
    {
      file: '0014-c.md',
      text: adr('Accepted. Operator decisions D1–D3.', range(3)),
    },
  ],
});

test('a consistent index has no findings', () => {
  const { index: text, adrs } = good();
  assert.deepEqual(check(text, adrs), []);
});

test('a stale index range is a finding', () => {
  const { adrs } = good();
  const stale = index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D2 for C. |',
  );
  const findings = check(stale, adrs);
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? '', /0014.*D1–D2.*D1–D3/u);
});

test('a Status range that differs from the decision table is a finding', () => {
  const { index: text, adrs } = good();
  adrs[2] = {
    file: '0014-c.md',
    text: adr('Accepted. Operator decisions D1–D2.', range(3)),
  };
  assert.match(check(text, adrs).join('\n'), /0014.*Status.*D1–D2/u);
});

test('non-contiguous decision ids are a finding', () => {
  const { index: text, adrs } = good();
  adrs[2] = {
    file: '0014-c.md',
    text: adr('Accepted. Operator decisions D1–D3.', [1, 3]),
  };
  assert.match(check(text, adrs).join('\n'), /0014.*not contiguous/u);
});

test('a range without a decision table is a finding', () => {
  const { index: text, adrs } = good();
  adrs[2] = { file: '0014-c.md', text: adr('Accepted. Decisions D1–D3.') };
  assert.match(check(text, adrs).join('\n'), /0014.*no decision table/u);
});

test('an index status that differs from the Status section is a finding', () => {
  const { adrs } = good();
  const wrong = index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | accepted | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  );
  assert.match(check(wrong, adrs).join('\n'), /0011.*accepted.*Superseded/u);
});

test('a status prefix must end on a word boundary', () => {
  const { adrs } = good();
  const partial = index(
    '| [0001](0001-a.md) | accept | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  );
  assert.match(check(partial, adrs).join('\n'), /0001.*accept/u);
});

test('an ADR marker in the index status is not dropped', () => {
  const { adrs } = good();
  const marked = index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by ADR 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  );
  assert.match(check(marked, adrs).join('\n'), /0011.*superseded by ADR/u);
});

test('an indented stale index row is still checked', () => {
  const { index: text, adrs } = good();
  const indented = text.replace(
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
    '   | [0014](0014-c.md) | accepted | Operator decisions D1–D2 for C. |',
  );
  assert.match(check(indented, adrs).join('\n'), /0014.*D1–D2.*D1–D3/u);
  const odd = text.replace(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '  | 0001 | accepted | Product A. |',
  );
  assert.match(check(odd, adrs).join('\n'), /unrecognised index row/u);
});

test('an ADR without a Status section fails closed', () => {
  const { index: text, adrs } = good();
  adrs[0] = { file: '0001-a.md', text: '# ADR\n\nNo status here.\n' };
  assert.match(check(text, adrs).join('\n'), /0001.*no Status/u);
});

test('an ADR file without an index row is a finding', () => {
  const { index: text, adrs } = good();
  adrs.push({ file: '0015-d.md', text: adr('Accepted.') });
  assert.match(check(text, adrs).join('\n'), /0015-d\.md.*no index row/u);
});

test('an index row without an ADR file is a finding', () => {
  const { adrs } = good();
  const extra = index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
    '| [0016](0016-e.md) | accepted | Missing E. |',
  );
  assert.match(check(extra, adrs).join('\n'), /0016-e\.md.*no ADR file/u);
});

test('a label that differs from the linked file number is a finding', () => {
  const { adrs } = good();
  const mislabel = index(
    '| [0002](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  );
  assert.match(check(mislabel, adrs).join('\n'), /0002.*0001-a\.md/u);
});

test('a duplicate index row is a finding', () => {
  const { adrs } = good();
  const twice = index(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| [0011](0011-b.md) | superseded by 0014 D8 | Former B. |',
    '| [0014](0014-c.md) | accepted | Operator decisions D1–D3 for C. |',
  );
  assert.match(check(twice, adrs).join('\n'), /0001-a\.md.*more than one/u);
});

test('an unclassifiable index table row fails closed', () => {
  const { index: text, adrs } = good();
  const odd = text.replace(
    '| [0001](0001-a.md) | accepted | Product A. |',
    '| 0001 | accepted | Product A. |',
  );
  assert.match(check(odd, adrs).join('\n'), /unrecognised index row/u);
});

test('CRLF line endings and a BOM parse like LF text', () => {
  const { index: text, adrs } = good();
  const crlf = (s: string): string => `\uFEFF${s.replaceAll('\n', '\r\n')}`;
  assert.deepEqual(
    check(
      crlf(text),
      adrs.map((a) => ({ file: a.file, text: crlf(a.text) })),
    ),
    [],
  );
  const stale = crlf(text.replace('D1–D3 for C', 'D1–D2 for C'));
  assert.match(check(stale, adrs).join('\n'), /0014.*D1–D2/u);
});

test('docs/adr/README.md matches every ADR in docs/adr', () => {
  const dir = fileURLToPath(new URL('../../docs/adr/', import.meta.url));
  const adrs = readdirSync(dir)
    .filter((file) => /^\d{4}-.*\.md$/u.test(file))
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
  const text = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.deepEqual(check(text, adrs), []);
});
