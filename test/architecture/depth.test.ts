import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyze, report } from '../../scripts/architecture/depth.ts';

test('depth check measures exports, fan-in, fan-out, and flags shallow modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-depth-'));
  try {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'deep'), { recursive: true });
    writeFileSync(
      join(src, 'deep', 'index.ts'),
      `// deep\nexport function run(x: number): number {\n${'  x += 1;\n'.repeat(60)}  return x;\n}\n`,
    );
    writeFileSync(
      join(src, 'wide.ts'),
      `${['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `export const ${n} = 1;`).join('\n')}\n`,
    );
    writeFileSync(
      join(src, 'barrel.ts'),
      `export { run } from './deep/index.ts';\nexport * from './wide.ts';\n`,
    );
    writeFileSync(
      join(src, 'shapes.ts'),
      `export type A = string;\nexport interface B { a: A }\n`,
    );
    writeFileSync(
      join(src, 'user.ts'),
      `import { run } from './barrel.ts';\nimport { a } from './wide.ts';\nimport { run as r2 } from './deep';\nexport const go = () => run(a) + r2(1);\n`,
    );
    const rows = new Map(
      analyze(src).map((m) => [m.path.replace(/^src\//u, ''), m]),
    );
    const deep = rows.get('deep/index.ts');
    assert.equal(deep?.exports, 1);
    assert.equal(deep?.fanIn, 2);
    assert.deepEqual(deep?.flags, []);
    assert.deepEqual(rows.get('wide.ts')?.flags, ['shallow']);
    assert.equal(rows.get('wide.ts')?.fanIn, 2);
    assert.deepEqual(rows.get('barrel.ts')?.flags, ['pass-through']);
    assert.equal(rows.get('barrel.ts')?.fanOut, 2);
    assert.deepEqual(rows.get('shapes.ts')?.flags, ['types-only']);
    assert.equal(rows.get('user.ts')?.fanOut, 3);
    const text = report([...rows.values()]);
    assert.match(
      text,
      /verdict: 5 modules, 1 pass-through, 1 shallow, 0 hub, 1 types-only; top candidate src\/wide\.ts$/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
