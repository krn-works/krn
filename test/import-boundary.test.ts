import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

function importsOutsideCore(
  file: string,
  source: string,
  coreRoot: string,
): boolean {
  const specs = [
    ...source.matchAll(
      /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    ),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1] ?? '');
  return specs.some((specifier) => {
    if (!specifier.startsWith('.') && !isAbsolute(specifier)) return false;
    const pathFromCore = relative(coreRoot, resolve(dirname(file), specifier));
    return (
      pathFromCore === '..' ||
      pathFromCore.startsWith(`..${sep}`) ||
      isAbsolute(pathFromCore)
    );
  });
}

test('core imports only its own files, including nested files and every module form', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'krn-boundary-'));
  try {
    const coreRoot = join(directory, 'src', 'core');
    await mkdir(join(coreRoot, 'nested'), { recursive: true });
    await Promise.all(
      ['hosts', 'ledger', 'trace'].map((name) =>
        mkdir(join(directory, 'src', name)),
      ),
    );
    await writeFile(
      join(coreRoot, 'nested', 'side-effect.ts'),
      "import '../../hosts/index.ts';",
    );
    await writeFile(
      join(coreRoot, 'nested', 're-export.ts'),
      "export { x } from '../../ledger/index.ts';",
    );
    await writeFile(
      join(coreRoot, 'nested', 'dynamic.ts'),
      "await import('../../trace/index.ts');",
    );
    const files = await sourceFiles(coreRoot);
    const offenders = (
      await Promise.all(
        files.map(async (file) => ({
          file,
          source: await readFile(file, 'utf8'),
        })),
      )
    ).filter(({ file, source }) => importsOutsideCore(file, source, coreRoot));
    assert.equal(
      offenders.length,
      3,
      'side-effect, re-export, and dynamic adapter imports must be found recursively',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('core does not import host, ledger, or trace adapters', async () => {
  const root = new URL('../src/core/', import.meta.url);
  const coreRoot = new URL('.', root).pathname;
  const files = await sourceFiles(coreRoot);
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
  );
  assert.equal(
    sources.some(({ file, source }) =>
      importsOutsideCore(file, source, coreRoot),
    ),
    false,
    'core must remain independent of adapters',
  );
});
