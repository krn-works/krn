import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { standardsCheck } from '../../src/brain/standards-cli.ts';

// KRN-12: the real `krn standards propose` and `krn standards harvest` entries on generated
// foreign repositories (a Python and a TypeScript one), read back through git and the CLI.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const proposals = '.agents/standards-proposals';

function git(root: string, ...args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repository(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  return root;
}

const python = () =>
  repository('krn-proposals-py-', {
    'pyproject.toml': '[project]\nname = "probe"\n',
    'tests/test_probe.py': 'def test_probe():\n    assert True\n',
  });
const typescript = () =>
  repository('krn-proposals-ts-', {
    'package.json': '{"name": "probe", "scripts": {"test": "node --test"}}\n',
    '.gitignore': 'node_modules/\n',
  });

function krn(args: string[], cwd = tmpdir()) {
  return spawnSync(process.execPath, [cli, 'standards', ...args], {
    encoding: 'utf8',
    cwd,
  });
}

const lesson = 'Run the linter before every commit.';

test('propose writes one trackable proposal file and a rerun keeps it', () => {
  const root = python();
  try {
    const done = krn([
      'propose',
      '--text',
      lesson,
      '--kind',
      'check',
      '--evidence',
      '#12',
      '--evidence',
      'abc1234',
      '--root',
      root,
    ]);
    assert.equal(done.status, 0, done.stderr);
    const files = readdirSync(join(root, proposals));
    assert.equal(files.length, 1);
    const file = `${proposals}/${files[0]}`;
    assert.equal(done.stdout, `proposed ${file}; commit it with the slice\n`);
    const written = JSON.parse(readFileSync(join(root, file), 'utf8'));
    assert.equal(written.text, lesson);
    assert.equal(written.kind, 'check');
    assert.deepEqual(written.evidence, ['#12', 'abc1234']);
    assert.match(written.recorded_at, /^\d{4}-\d{2}-\d{2}$/u);
    // Tracked: git sees it as a new file to commit, not an ignored one.
    assert.equal(git(root, 'check-ignore', '-q', file).status, 1);
    assert.match(git(root, 'status', '--porcelain').stdout, /\?\? \.agents\//u);

    const again = krn(
      [
        'propose',
        '--text',
        ' run the linter  before every commit',
        '--kind',
        'prose',
        '--evidence',
        '#13',
      ],
      root,
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(
      again.stdout,
      `already proposed ${file}; commit it with the slice\n`,
    );
    assert.equal(readdirSync(join(root, proposals)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('propose refuses a bad kind or missing evidence with 64 and bad evidence with 65', () => {
  const root = python();
  try {
    const bad = (args: string[], exit: number, pattern: RegExp) => {
      const done = krn(['propose', '--root', root, ...args]);
      assert.equal(done.status, exit, args.join(' '));
      assert.match(done.stderr, pattern);
      assert.equal(done.stdout, '');
    };
    bad(
      ['--text', lesson, '--kind', 'rule', '--evidence', '#1'],
      64,
      /--kind must be one of check, template, skill, prose, got "rule"/u,
    );
    bad(
      ['--text', lesson, '--kind', 'check'],
      64,
      /usage: krn standards check/u,
    );
    bad(['--kind', 'check', '--evidence', '#1'], 64, /usage: krn standards/u);
    bad(
      ['--text', lesson, '--kind', 'check', '--evidence', '/etc/passwd'],
      65,
      /evidence\[0\]: expected a repository path/u,
    );
    assert.equal(
      git(root, 'status', '--porcelain').stdout.includes('.agents'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('harvest over two generated repositories prints one candidate with count 2', () => {
  const alpha = python();
  const beta = typescript();
  const host = mkdtempSync(join(tmpdir(), 'krn-proposals-host-'));
  try {
    for (const [root, text, evidence] of [
      [alpha, lesson, '#7'],
      [beta, 'run the linter before every commit', 'def5678'],
    ] as const) {
      const done = krn(
        ['propose', '--text', text, '--kind', 'check', '--evidence', evidence],
        root,
      );
      assert.equal(done.status, 0, done.stderr);
    }
    const expected = [
      `candidate count 2 in 2 repositories (promotable): ${lesson}`,
      `  kinds: check; origins: ${basename(alpha)}, ${basename(beta)}; evidence: ${basename(alpha)}:#7, ${basename(beta)}:def5678`,
      'harvest: 1 candidate from 2 proposals in 2 repositories, 1 promotable',
      '',
    ].join('\n');

    const given = krn(['harvest', alpha, beta]);
    assert.equal(given.status, 0, given.stderr);
    assert.equal(given.stdout, expected);
    assert.equal(given.stdout.match(/^candidate /gmu)?.length, 1);

    // With no repository given, harvest reads the host-local list (a relative path resolves from the root).
    mkdirSync(join(host, '.krn'));
    writeFileSync(
      join(host, '.krn', 'adopted.json'),
      JSON.stringify([alpha, join('..', basename(beta))]),
    );
    const listed = krn(['harvest', '--root', host]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, expected);
  } finally {
    for (const dir of [alpha, beta, host])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('harvest names a malformed proposal (65), a missing list or a non-repository (66)', () => {
  const root = typescript();
  const host = mkdtempSync(join(tmpdir(), 'krn-proposals-host-'));
  try {
    const none = krn(['harvest', root]);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(
      none.stdout,
      'harvest: 0 candidates from 0 proposals in 1 repository, 0 promotable\n',
    );

    mkdirSync(join(root, proposals), { recursive: true });
    writeFileSync(join(root, proposals, 'broken.json'), '{"text": "x"}\n');
    const malformed = krn(['harvest', root]);
    assert.equal(malformed.status, 65);
    assert.match(
      malformed.stderr,
      /standards-proposals\/broken\.json: fields must be exactly/u,
    );

    const unlisted = krn(['harvest', '--root', host]);
    assert.equal(unlisted.status, 66);
    assert.match(
      unlisted.stderr,
      /no repository given and no \.krn\/adopted\.json/u,
    );

    const plain = krn(['harvest', host]);
    assert.equal(plain.status, 66);
    assert.match(plain.stderr, /is not a git repository/u);
  } finally {
    for (const dir of [root, host])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('standards check fails a harvested pack record that breaks the promotion rule', () => {
  const root = python();
  const product = mkdtempSync(join(tmpdir(), 'krn-proposals-pack-'));
  try {
    const record = (origins: string[], occurrences: number) => ({
      id: 's-linter-before-commit',
      area: 'checks',
      layer: 'universal',
      audience: 'worker',
      tier: 'floor',
      text: lesson,
      why: 'Two repositories shipped lint errors their CI then refused.',
      evidence: ['#7'],
      enforcement: { kind: 'command', run: 'true' },
      applies: { stacks: [], needs: [] },
      recorded_at: '2026-11-13',
      valid_from: '2026-11-13',
      valid_to: null,
      harvested: { origins, occurrences },
    });
    mkdirSync(join(product, 'standards'));
    const write = (value: unknown) =>
      writeFileSync(
        join(product, 'standards', 'records.json'),
        JSON.stringify([value]),
      );

    write(record(['alpha'], 1));
    const once = standardsCheck(root, '2026-11-13', { pack: product });
    assert.equal(once.exitCode, 1);
    assert.match(
      once.lines[0] ?? '',
      /^s-linter-before-commit: promotion rule: harvested from origins alpha in 1 proposals/u,
    );
    assert.match(
      once.lines.at(-1) ?? '',
      /^FAIL standards: 1 enforced, 1 failed/u,
    );

    write(record(['alpha', 'beta'], 2));
    const twice = standardsCheck(root, '2026-11-13', { pack: product });
    assert.deepEqual(twice.exitCode, 0, twice.lines.join('\n'));
    assert.match(
      twice.lines[0] ?? '',
      /^PASS standards: 1 enforced, 0 failed/u,
    );
  } finally {
    for (const dir of [root, product])
      rmSync(dir, { recursive: true, force: true });
  }
});

test('harvest --repos prints bullets recurring in two of three synthetic repositories and writes nothing', () => {
  const base = mkdtempSync(join(tmpdir(), 'krn-harvest-repos-'));
  const make = (name: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(join(base, name, file), content);
    }
    return join(base, name);
  };
  try {
    const one = make('one', {
      'AGENTS.md':
        '# Rules\n- Run the linter before every commit.\n- Only one repo has this rule.\n```\n- Run the shell example twice.\n```\n',
    });
    const two = make('two', {
      'CLAUDE.md':
        '* **Run** the  LINTER before every commit!\n1. Always `escape` output in templates.\n- Run the shell example twice.\n',
    });
    const three = make('three', {
      'AGENTS.md':
        '- Always escape output in templates.\n- Always escape output in templates.\n- Unrelated bullet nobody shares.\n',
      'CLAUDE.md': '- Always escape output in templates.\n',
    });
    const result = krn(['harvest', '--repos', one, two, three]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines, [
      'candidate in 2 repositories: Always `escape` output in templates.',
      '  sources: two/CLAUDE.md, three/AGENTS.md, three/CLAUDE.md',
      'candidate in 2 repositories: Run the linter before every commit.',
      '  sources: one/AGENTS.md, two/CLAUDE.md',
      'harvest: 2 candidates from instruction files of 3 repositories; review each into a record, none was written',
    ]);
    assert.equal(result.stdout.includes('Only one repo'), false);
    assert.equal(result.stdout.includes('shell example'), false);

    // A list file names the same repositories, one per line, relative to the file.
    writeFileSync(join(base, 'list.txt'), '# repos\none\n\ntwo\n');
    const listed = krn(['harvest', '--repos-file', join(base, 'list.txt')]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /candidate in 2 repositories: Run the linter/u);
    assert.match(
      listed.stdout,
      /1 candidate from instruction files of 2 repositories/u,
    );

    assert.equal(krn(['harvest', '--repos', join(base, 'nope')]).status, 66);
    assert.equal(readdirSync(one).includes('.agents'), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
