import assert from 'node:assert/strict';
import test from 'node:test';
import { interfaceParagraph, testImports } from '../../evals/d23/interface.ts';

test('the interface names the non-test modules and exports a hidden test imports', () => {
  const src = [
    "import assert from 'node:assert/strict';",
    "import { mapLimited, type Row as R } from '../../src/outcome/ledger.ts';",
    "import run from '../../scripts/run.ts';",
    "import { fixture } from '../fixtures/rows.ts';",
    "import { helper } from './other.test.ts';",
  ].join('\n');
  const imports = testImports('test/outcome/ledger.test.ts', src);
  assert.deepEqual(imports, [
    { module: 'src/outcome/ledger.ts', names: ['Row', 'mapLimited'] },
    { module: 'scripts/run.ts', names: ['default'] },
  ]);
  assert.match(
    interfaceParagraph(imports),
    /`src\/outcome\/ledger\.ts` exports `Row`, `mapLimited`/,
  );
  assert.equal(interfaceParagraph([]), '');
});

test('a script the test runs by URL and the members of its dynamic import are named', () => {
  const src = [
    "const path = '../../src/outcome/ledger.ts';",
    "const fixture = new URL('../fixtures/outcome-ledger/a.json', import.meta.url);",
    'const ledger = await import(path).catch(() => ({}));',
    'ledger.mapLimited([1], 2, async (x) => x);',
  ].join('\n');
  assert.deepEqual(testImports('test/outcome/ledger.test.ts', src), [
    { module: 'src/outcome/ledger.ts', names: ['mapLimited'] },
  ]);
});
