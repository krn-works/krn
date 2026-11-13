import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appliesTo, parseStandards } from '../../src/brain/standards.ts';
import {
  ENFORCEMENT_TIMEOUT_MS,
  enforcer,
  repositoryFacts,
  standardsCheck,
} from '../../src/brain/standards-cli.ts';

// KRN-12: the real `krn standards check` entry on generated foreign repositories; every
// enforcement runs for real (sh, git, node and the krn CLI) in the generated repository.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const packFile = fileURLToPath(
  new URL('../../standards/records.json', import.meta.url),
);

function git(root: string, ...args: string[]) {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
}

/** A git repository holding `files`, all of them tracked (added to the index). */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-standards-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  return root;
}

function check(root: string) {
  return spawnSync(
    process.execPath,
    [cli, 'standards', 'check', '--root', root],
    { encoding: 'utf8', cwd: tmpdir() },
  );
}

const workflow = (run: string) =>
  `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${run}\n`;

const python = {
  'pyproject.toml':
    '[project]\nname = "probe"\nversion = "0.1.0"\n\n[tool.ruff]\nline-length = 100\n',
  'uv.lock': 'version = 1\n',
  '.gitignore': '__pycache__/\n.venv/\n',
  'README.md': '# probe\n\nRun the tests with `uv run pytest`.\n',
  '.github/workflows/ci.yml': workflow('uv run pytest'),
  'probe/__init__.py': '',
  'tests/test_probe.py': 'def test_probe():\n    assert True\n',
};

const typescript = {
  'package.json': JSON.stringify({
    name: 'probe',
    scripts: { test: 'vitest run' },
    devDependencies: { typescript: '5.0.0', vitest: '1.0.0' },
  }),
  'package-lock.json': '{"lockfileVersion": 3}\n',
  'biome.json': '{}\n',
  'tsconfig.json': '{"compilerOptions": {"strict": true}}\n',
  '.gitignore': 'node_modules/\ndist/\n',
  'README.md': '# probe\n\n    npm test\n',
  '.github/workflows/ci.yml': workflow('npm test'),
  'src/index.ts': 'export const one = 1;\n',
  'src/index.test.ts': "import { one } from './index';\n",
};

const go = {
  'go.mod': 'module example.com/probe\n\ngo 1.22\n',
  'probe.go': 'package probe\n\nfunc One() int { return 1 }\n',
  'probe_test.go':
    'package probe\n\nimport "testing"\n\nfunc TestOne(t *testing.T) {\n\tif One() != 1 {\n\t\tt.Fatal("one")\n\t}\n}\n',
  '.golangci.yml': 'linters:\n  enable: [govet]\n',
  'README.md': '# probe\n\n`go test ./...`\n',
  '.github/workflows/ci.yml': workflow('go test ./...'),
};

const fixtures = [
  ['Python', python, 'python'],
  ['TypeScript', typescript, 'node/npm'],
  ['Go', go, 'go'],
] as const;

for (const [name, files, stack] of fixtures) {
  test(`standards check runs the universal standards and prints one PASS line on a generated ${name} repository`, () => {
    const root = repository(files);
    try {
      const done = check(root);
      assert.equal(done.status, 0, done.stderr);
      assert.equal(done.stderr, '');
      const lines = done.stdout.trimEnd().split('\n');
      assert.equal(lines.length, 1);
      const match =
        /^PASS standards: (\d+) enforced, 0 failed, (\d+) advisory; (\d+) standards apply to .* \((\d+) of (\d+) pack, 0 project; stack ([^;]+); krn not adopted\)$/u.exec(
          lines[0] ?? '',
        );
      assert.ok(match, lines[0]);
      const [, enforced, advisory, applied, inherited, total] =
        match.map(Number);
      assert.equal(match[6], stack);
      assert.ok((enforced ?? 0) >= 8, `${enforced} enforced`);
      assert.ok((advisory ?? 0) >= 1);
      assert.equal(applied, inherited);
      // krn-delivery standards need KRN adopted, so not every pack record applies.
      assert.ok((inherited ?? 0) < (total ?? 0));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('standards check names the failing standard and its exit when an enforced universal standard does not hold', () => {
  const { 'uv.lock': _lock, ...unlocked } = python;
  const root = repository({ ...unlocked, '.env': 'TOKEN=x\n' });
  try {
    const done = check(root);
    assert.equal(done.status, 1);
    assert.match(
      done.stderr,
      /^s-lockfile-committed: exit 1 from git ls-files/mu,
    );
    assert.match(done.stderr, /^s-no-secrets-tracked: exit 1 from /mu);
    assert.match(done.stdout, /^FAIL standards: \d+ enforced, 2 failed, /u);
    assert.equal(done.stdout.trimEnd().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One project record; the plainest hand-written shape of `.agents/standards.json`. */
const projectRecord = (change: Record<string, unknown>) => ({
  id: 's-project',
  area: 'tests',
  layer: 'universal',
  audience: 'worker',
  text: 'A project rule.',
  why: 'The project needs it.',
  evidence: ['README.md'],
  enforcement: { kind: 'command', run: 'true' },
  applies: { stacks: [], needs: [] },
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
  ...change,
});

test('standards check fails on a failing project enforcement command and names its exit and output', () => {
  const root = repository({
    ...python,
    '.agents/standards.json': JSON.stringify([
      projectRecord({
        enforcement: {
          kind: 'command',
          run: 'echo "no changelog" >&2; exit 3',
        },
      }),
    ]),
  });
  try {
    const done = check(root);
    assert.equal(done.status, 1);
    assert.match(
      done.stderr,
      /^s-project: exit 3 from echo "no changelog" >&2; exit 3: no changelog$/mu,
    );
    assert.match(
      done.stdout,
      /^FAIL standards: \d+ enforced, 1 failed, \d+ advisory; .*, 1 project;/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards check fails on an expired project standard and names its dates', () => {
  const root = repository({
    ...python,
    '.agents/standards.json': JSON.stringify([
      projectRecord({
        id: 's-retired',
        recorded_at: '2020-01-01',
        valid_from: '2020-01-01',
        valid_to: '2020-12-31',
      }),
    ]),
  });
  try {
    const done = check(root);
    assert.equal(done.status, 1);
    assert.match(
      done.stderr,
      /^s-retired: outside its dates on \d{4}-\d{2}-\d{2} \(valid 2020-01-01\.\.2020-12-31\)$/mu,
    );
    assert.match(done.stdout, /^FAIL standards: \d+ enforced, 1 failed, /u);
    assert.equal(done.stdout.trimEnd().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an enforcement that outlives its timeout fails with exit none and names the timeout', () => {
  const root = repository({
    ...python,
    '.agents/standards.json': JSON.stringify([
      projectRecord({ enforcement: { kind: 'command', run: 'sleep 5' } }),
    ]),
  });
  try {
    assert.ok(ENFORCEMENT_TIMEOUT_MS >= 10_000);
    const verdict = standardsCheck(root, '2026-11-13', { timeoutMs: 200 });
    assert.equal(verdict.exitCode, 1);
    assert.ok(
      verdict.lines.includes(
        's-project: exit none from sleep 5: timed out after 200 ms',
      ),
      verdict.lines.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('krn-delivery standards apply once krn adopt ran, and every one holds right after adoption', () => {
  const root = repository(python);
  try {
    const adopted = spawnSync(
      process.execPath,
      [cli, 'adopt', root, '--tracker', '--no-canary'],
      {
        encoding: 'utf8',
        cwd: tmpdir(),
      },
    );
    assert.equal(adopted.status, 0, adopted.stderr);
    git(root, 'add', '-A');
    const done = check(root);
    assert.equal(done.status, 0, `${done.stderr}${done.stdout}`);
    assert.match(
      done.stdout,
      /^PASS standards: \d+ enforced, 0 failed, \d+ advisory; .* stack python; krn adopted\)\n$/u,
    );
    const pack = parseStandards(JSON.parse(readFileSync(packFile, 'utf8')));
    const [, inherited, total] =
      /\((\d+) of (\d+) pack/u.exec(done.stdout) ?? [];
    const universal = pack.filter(
      (s) =>
        s.layer === 'universal' &&
        appliesTo(s, { stack: 'python', adopted: false, needs: new Set() }),
    ).length;
    assert.ok(Number(inherited) > universal, `${inherited} of ${total}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every enforced pack record applies to and holds on at least one generated repository', () => {
  const pack = parseStandards(JSON.parse(readFileSync(packFile, 'utf8')));
  const held = new Set<string>();
  const roots = fixtures.map(([, files]) => repository(files));
  const adoptedRoot = repository(typescript);
  try {
    const adopted = spawnSync(
      process.execPath,
      [cli, 'adopt', adoptedRoot, '--tracker', '--no-canary'],
      { encoding: 'utf8', cwd: tmpdir() },
    );
    assert.equal(adopted.status, 0, adopted.stderr);
    git(adoptedRoot, 'add', '-A');
    for (const root of [...roots, adoptedRoot]) {
      const facts = repositoryFacts(root);
      const enforce = enforcer(root, ENFORCEMENT_TIMEOUT_MS);
      for (const record of pack) {
        if (record.enforcement.kind === 'advisory') continue;
        if (!appliesTo(record, facts)) continue;
        const outcome = enforce(record.enforcement);
        assert.equal(
          outcome.exit,
          0,
          `${record.id} on ${facts.stack}: ${outcome.detail}`,
        );
        held.add(record.id);
      }
    }
    const enforced = pack
      .filter((record) => record.enforcement.kind !== 'advisory')
      .map((record) => record.id);
    assert.deepEqual(
      enforced.filter((id) => !held.has(id)),
      [],
    );
  } finally {
    for (const root of [...roots, adoptedRoot])
      rmSync(root, { recursive: true, force: true });
  }
});

test('repositoryFacts reads the stack, adoption and tracker from a real git repository', () => {
  const root = repository({ 'pyproject.toml': '[project]\nname = "p"\n' });
  try {
    const bare = repositoryFacts(root);
    assert.equal(bare.stack, 'python');
    assert.equal(bare.adopted, false);
    assert.deepEqual([...bare.needs], []);
    mkdirSync(join(root, 'tasks'));
    const tracked = repositoryFacts(root);
    assert.equal(tracked.adopted, true);
    assert.deepEqual([...tracked.needs], ['tracker']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards check exits 65 on a malformed project file', () => {
  const root = repository({ ...python, '.agents/standards.json': '{' });
  try {
    const done = check(root);
    assert.equal(done.status, 65);
    assert.match(
      done.stdout,
      /^FAIL standards: \.agents\/standards\.json: not JSON/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards check reports the real read error of an unreadable project file with exit 66', () => {
  const root = repository(python);
  mkdirSync(join(root, '.agents/standards.json'), { recursive: true });
  try {
    const done = check(root);
    assert.equal(done.status, 66);
    assert.match(
      done.stdout,
      /^FAIL standards: \.agents\/standards\.json: cannot read \(EISDIR/u,
    );
    assert.doesNotMatch(done.stdout, /not JSON/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards check exits 66 on a root that is not a directory or not its repository top level', () => {
  const root = repository(python);
  try {
    const file = join(root, 'README.md');
    for (const [target, message] of [
      [join(root, 'missing'), /missing is not a directory/u],
      [file, /README\.md is not a directory/u],
      [
        join(root, 'tests'),
        /tests is not the top level of its git repository/u,
      ],
    ] as const) {
      const done = check(target);
      assert.equal(done.status, 66, `${target}: ${done.stderr}`);
      assert.match(done.stderr, message);
      assert.equal(done.stdout, '');
    }
    const plain = mkdtempSync(join(tmpdir(), 'krn-standards-plain-'));
    try {
      const done = check(plain);
      assert.equal(done.status, 66);
      assert.match(done.stderr, /is not a git repository/u);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standards with an unknown verb or flag is a usage error', () => {
  for (const args of [
    ['standards'],
    ['standards', 'fix'],
    ['standards', 'check', '--force'],
  ]) {
    const done = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.equal(done.status, 64, args.join(' '));
    assert.match(done.stderr, /usage: krn standards check/u);
    assert.equal(done.stdout, '');
  }
});
