// fast-covers: src/repo/contract.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { universalSkills } from '../../src/adopt/adopt.ts';
import { UNIVERSAL_SKILLS } from '../../src/brain/global-standards.ts';

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
  'krn-reader',
  'krn-research',
  'krn-retro',
  'scripts/claude',
  '.krn/runs/lead',
  'KRN-',
  'FR-40',
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
  const run = spawnSync(process.execPath, [cli, 'adopt', root, '--no-canary'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);

  const installed = join(root, '.agents', 'skills');
  const names = readdirSync(installed).sort();
  // core skills only: a language gets stack-tagged records, never a prose skill
  assert.deepEqual(names, [
    'delivery-handoff',
    'delivery-lead',
    'delivery-retro',
    'standards',
  ]);
  assert.equal(
    readFileSync(join(installed, 'delivery-lead', 'lanes.md'), 'utf8'),
    readFileSync(join(source, 'delivery-lead', 'lanes.md'), 'utf8'),
  );
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
    // An adopted repository's own docs checks (krn-works/seo-audit-harness#83) skip only a line
    // whose krn command sits in inline code; a bare command line with options reads as theirs.
    for (const line of text.split('\n'))
      if (/(^|\s)krn [a-z]+.* --[a-z]/u.test(line))
        assert.match(line, /`krn [a-z]/u, `${name}: ${line}`);
  }
  assert.ok(seen.has('repo contract'), 'skills read the repo contract');
  assert.ok(
    seen.has('standards propose'),
    'the retro turns a lesson into a standards proposal',
  );
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
  assert.equal(
    JSON.parse(contract.stdout).contract.test,
    '.venv/bin/python -m pytest',
  );
});

test('every universal skill declares the Agent Skills compatibility field', () => {
  // A pilot repository checks its own .agents/skills for name, description and
  // compatibility; an adopted skill without the field broke its suite.
  for (const file of skillFiles(source).filter((f) => f.endsWith('SKILL.md'))) {
    const head = readFileSync(file, 'utf8').split('\n---\n')[0] ?? '';
    const field = /^compatibility: (.+)$/mu.exec(head)?.[1] ?? '';
    assert.ok(
      field.length > 10 && field.length <= 500,
      `${file} compatibility`,
    );
  }
});

const repo = fileURLToPath(new URL('../..', import.meta.url));

test('the core skills carry the full procedure with no KRN-only or operator text', () => {
  assert.deepEqual(
    [
      'architecture',
      'delivery-handoff',
      'delivery-lead',
      'delivery-retro',
      'standards',
    ].filter((name) => !universalSkills().includes(name)),
    [],
  );
  assert.ok(existsSync(join(source, 'delivery-lead', 'lanes.md')));
  for (const file of skillFiles(source)) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/operator/iu.test(text), false, `${file} names the operator`);
    assert.equal(
      /\b20\d\d-\d\d-\d\d\b/u.test(text),
      false,
      `${file} holds a date`,
    );
  }
  const lead = readFileSync(join(source, 'delivery-lead', 'SKILL.md'), 'utf8');
  assert.match(lead, /delivery-lead\/lanes\.md/u);
  assert.match(lead, /delivery-handoff/u);
  assert.match(lead, /delivery-retro/u);
});

test('every skill a hook or successor prompt names is an installable universal skill', () => {
  const installable = new Set(universalSkills());
  for (const file of [
    'src/context/gauge.ts',
    'scripts/codex/context-hook.ts',
  ]) {
    const text = readFileSync(join(repo, file), 'utf8');
    assert.equal(
      /krn-(?:lead|handoff|retro)/u.test(text.replace(/\/\/.*$/gmu, '')),
      false,
      `${file} names a KRN-only skill`,
    );
    for (const [, name] of text.matchAll(/(?:run|the) (delivery-[a-z]+)/gu))
      assert.ok(installable.has(name as string), `${file} names ${name}`);
  }
  for (const name of UNIVERSAL_SKILLS)
    assert.ok(installable.has(name), `${name} is installable`);
  assert.deepEqual([...UNIVERSAL_SKILLS], ['architecture']);
});

test('the standards skill is one file: the installer source, this repository and a fresh --init repository carry the same bytes', () => {
  const ours = readFileSync(join(source, 'standards', 'SKILL.md'), 'utf8');
  assert.equal(
    readFileSync(
      join(repo, '.agents', 'skills', 'standards', 'SKILL.md'),
      'utf8',
    ),
    ours,
  );
  assert.equal(
    existsSync(join(repo, '.agents', 'skills', 'typescript')),
    false,
    'a language has records, not a prose skill',
  );
  assert.match(ours, /krn standards query/u);
  const root = mkdtempSync(join(tmpdir(), 'krn-standards-skill-'));
  try {
    const init = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--init', '--stack', 'ts', '--no-canary'],
      { encoding: 'utf8' },
    );
    assert.equal(init.status, 0, init.stderr);
    assert.equal(
      readFileSync(
        join(root, '.agents', 'skills', 'standards', 'SKILL.md'),
        'utf8',
      ),
      ours,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt --refresh --dry-run prints no drift on this repository and writes nothing', () => {
  const run = spawnSync(
    process.execPath,
    [cli, 'adopt', repo, '--refresh', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout, 'no drift\n');
});

test('adopt --refresh --dry-run names a drifted skill, exits 1 and leaves the file as it was', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-dry-run-'));
  try {
    const init = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--init', '--stack', 'ts', '--no-canary'],
      { encoding: 'utf8' },
    );
    assert.equal(init.status, 0, init.stderr);
    const file = join(root, '.agents', 'skills', 'standards', 'SKILL.md');
    writeFileSync(file, 'edited by hand\n');
    const dry = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--refresh', '--dry-run'],
      { encoding: 'utf8' },
    );
    assert.equal(dry.status, 1, dry.stderr);
    assert.match(
      dry.stdout,
      /^drift \.agents\/skills\/standards\/SKILL\.md$/mu,
    );
    assert.equal(readFileSync(file, 'utf8'), 'edited by hand\n');
    const bare = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--dry-run'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(bare.status, 64, 'a dry run needs --refresh');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
