import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: the universal skills are scanned for KRN-repository literals, then
// installed by the real `krn adopt` into a pytest fixture, where every `krn`
// command they name is run against the real CLI.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const source = fileURLToPath(
  new URL('../../src/adopt/skills/', import.meta.url),
);

const krnOnly = [
  'npm run fast',
  'bin/krn',
  'test/rules',
  'krn-works',
  '15368',
  `/${'mnt'}/storage`,
  'docs/program',
  'spec/rules.json',
  'krn-lead',
  'krn-handoff',
  'krn state',
];

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? skillFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

function krnCommands(text: string): string[][] {
  return [...text.matchAll(/`krn ([a-z]+(?: [a-z]+)?)[ `]/gu)].map((match) =>
    (match[1] as string).split(' '),
  );
}

test('the universal skill layer names no KRN-repository command, path or gate', () => {
  const files = skillFiles(source);
  assert.ok(files.length >= 2, 'universal skills exist');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const literal of krnOnly)
      assert.equal(text.includes(literal), false, `${file} names ${literal}`);
  }
});

test('adopt on a pytest fixture installs skills whose every command resolves there', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-skills-'));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);

  const installed = join(root, '.agents', 'skills');
  const names = readdirSync(installed).sort();
  assert.deepEqual(names, readdirSync(source).sort());
  assert.equal(
    lstatSync(join(root, '.claude', 'skills')).isSymbolicLink(),
    true,
  );
  mkdirSync(join(root, '.krn'), { recursive: true });

  const seen = new Set<string>();
  for (const name of names) {
    const text = readFileSync(join(installed, name, 'SKILL.md'), 'utf8');
    assert.equal(text, readFileSync(join(source, name, 'SKILL.md'), 'utf8'));
    for (const words of krnCommands(text)) seen.add(words.join(' '));
  }
  assert.ok(seen.has('repo contract'), 'skills read the repo contract');
  for (const command of seen) {
    const [top, verb] = command.split(' ') as [string, string | undefined];
    const help = spawnSync(process.execPath, [cli, top, '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, `krn ${top}: ${help.stderr}`);
    if (verb !== undefined)
      assert.match(help.stdout, new RegExp(`\\b${verb}\\b`, 'u'), command);
  }
  const contract = spawnSync(process.execPath, [cli, 'repo', 'contract'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(contract.status, 0, contract.stderr);
  assert.equal(JSON.parse(contract.stdout).contract.test, 'python -m pytest');
});
