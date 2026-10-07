import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/render-agents.ts', import.meta.url),
);
const registry = fileURLToPath(new URL('../spec/rules.json', import.meta.url));
const agents = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const tests = fileURLToPath(new URL('../test/', import.meta.url));
const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));

async function fixture(): Promise<{
  directory: string;
  script: string;
  agents: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-agents-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'spec'));
  await mkdir(join(directory, 'test'));
  const copyScript = join(directory, 'scripts/render-agents.ts');
  const copyAgents = join(directory, 'AGENTS.md');
  await Promise.all([
    cp(script, copyScript),
    cp(registry, join(directory, 'spec/rules.json')),
    cp(agents, copyAgents),
    cp(packageFile, join(directory, 'package.json')),
    cp(tests, join(directory, 'test'), { recursive: true }),
  ]);
  return { directory, script: copyScript, agents: copyAgents };
}

test('importing the renderer does not write AGENTS.md', async () => {
  const copy = await fixture();
  try {
    const before = `${await readFile(copy.agents, 'utf8')}\nmanual drift`;
    await writeFile(copy.agents, before);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(new URL(`file://${copy.script}`).href)})`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(copy.agents, 'utf8'), before);
  } finally {
    await rm(copy.directory, { recursive: true, force: true });
  }
});

test('--check reports AGENTS.md drift without writing it', async () => {
  const copy = await fixture();
  try {
    const drift = `${await readFile(copy.agents, 'utf8')}\nmanual drift`;
    await writeFile(copy.agents, drift);
    const result = spawnSync(process.execPath, [copy.script, '--check'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(await readFile(copy.agents, 'utf8'), drift);
  } finally {
    await rm(copy.directory, { recursive: true, force: true });
  }
});

test('--check rejects rule enforcement without an existing test', async () => {
  const copy = await fixture();
  try {
    const registryPath = join(copy.directory, 'spec/rules.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      rules: { enforcement: { check: string } }[];
    };
    const firstRule = registry.rules.at(0);
    assert.ok(firstRule);
    firstRule.enforcement.check = 'test that does not exist';
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const result = spawnSync(process.execPath, [copy.script, '--check'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /KRN-05 names missing test/u);
  } finally {
    await rm(copy.directory, { recursive: true, force: true });
  }
});
