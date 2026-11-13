// fast-covers: src/repo/ src/adopt/
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
import { stopCommand } from '../../src/adopt/stop-hook.ts';

// KRN-12: the portability probe fixtures (foreign repositories of other stacks and
// layouts) run through the real `krn adopt --no-canary`, `krn repo contract` and
// `krn lane start` entries. Detection and generation read files only, so no
// toolchain (python, go, php) has to exist on the runner and nothing is skipped.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const ref = 'a'.repeat(40);

type Files = Record<string, string>;

function run(cwd: string, command: string, ...args: string[]) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function git(cwd: string, ...args: string[]): void {
  const done = run(
    cwd,
    'git',
    '-c',
    'user.email=probe@example.invalid',
    '-c',
    'user.name=probe',
    ...args,
  );
  assert.equal(done.status, 0, done.stderr);
}

function krn(cwd: string, ...args: string[]) {
  return run(cwd, process.execPath, cli, ...args);
}

/** A committed scratch repository on `branch` holding `files`, without a remote. */
function repository(files: Files, branch = 'main'): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-portability-'));
  git(root, 'init', '-q', '-b', branch);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function withRepository(
  files: Files,
  body: (root: string) => void,
  branch?: string,
): void {
  const root = repository(files, branch);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function adopt(root: string, ...extra: string[]) {
  const done = krn(root, 'adopt', root, '--no-canary', '--ref', ref, ...extra);
  assert.equal(done.status, 0, done.stderr);
  return done;
}

function workflow(root: string): string {
  return readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
}

function stopHook(root: string): string {
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  const hook = settings.hooks.Stop[0]?.hooks[0];
  assert.ok(hook, 'the Stop hook is installed');
  return hook.command;
}

const pytestProject = {
  'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  'src/pkg/calc.py': 'def add(a, b):\n    return a + b\n',
  'tests/test_calc.py':
    'from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
};

test('fixture 1: python pyproject with pytest is detected and carried into CI', () => {
  withRepository(pytestProject, (root) => {
    adopt(root);
    const contract = krn(root, 'repo', 'contract');
    assert.equal(contract.status, 0, contract.stderr);
    assert.match(contract.stdout, /python -m pytest/u);
    assert.match(workflow(root), /^ {6}test: "python -m pytest"$/mu);
    assert.equal(stopHook(root), stopCommand);
  });
});

test('fixture 2: requirements.txt with unittest has no contract and says so', () => {
  withRepository(
    {
      'requirements.txt': 'requests\n',
      'calc.py': 'def add(a, b):\n    return a + b\n',
      'tests/test_calc.py': 'import unittest\n',
    },
    (root) => {
      const done = adopt(root);
      assert.match(
        done.stdout,
        /skipped krn\.json \(no test command detected/u,
      );
      assert.match(done.stdout, /skipped \.github\/workflows\/ci\.yml/u);
      const contract = krn(root, 'repo', 'contract');
      assert.equal(contract.status, 65);
      assert.match(contract.stderr, /no test command/u);
    },
  );
});

test('fixture 3: go module is detected, carried into CI and runs the guarded Stop hook', () => {
  withRepository(
    {
      'go.mod': 'module example.invalid/probe\n\ngo 1.22\n',
      'calc.go': 'package probe\n\nfunc Add(a, b int) int { return a + b }\n',
      'calc_test.go':
        'package probe\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n',
    },
    (root) => {
      adopt(root);
      const contract = krn(root, 'repo', 'contract');
      assert.equal(contract.status, 0, contract.stderr);
      assert.match(contract.stdout, /go test \.\/\.\.\./u);
      assert.match(workflow(root), /^ {6}test: "go test \.\/\.\.\."$/mu);
      assert.equal(stopHook(root), stopCommand);
    },
  );
});

test('fixture 6: an api/ + ui/ monorepo is skipped by name, not guessed', () => {
  withRepository(
    {
      'api/pyproject.toml': '[tool.pytest.ini_options]\n',
      'api/test_api.py': 'def test_ok():\n    assert True\n',
      'ui/package.json':
        '{"name":"ui","private":true,"scripts":{"test":"node --test"}}\n',
    },
    (root) => {
      const done = adopt(root);
      assert.match(
        done.stdout,
        /several packages hold a test command: api, ui/u,
      );
      assert.equal(krn(root, 'repo', 'contract').status, 65);
    },
  );
});

for (const branch of ['master', 'develop']) {
  test(`fixture 7 (${branch}, no remote): the contract names the base and lane start names the missing remote`, () => {
    withRepository(
      { ...pytestProject },
      (root) => {
        adopt(root);
        const contract = krn(root, 'repo', 'contract');
        assert.equal(contract.status, 0, contract.stderr);
        const started = krn(
          root,
          'lane',
          'start',
          'probe',
          '--task',
          't-abc1234',
          '--class',
          'delivery',
        );
        assert.equal(started.status, 64);
        assert.match(
          started.stderr,
          new RegExp(
            `has no git remote origin: lanes branch from origin/${branch}`,
            'u',
          ),
        );
      },
      branch,
    );
  });
}

test('fixture 9: a repository with no stack adopts without a contract', () => {
  withRepository({ 'README.md': '# notes\n' }, (root) => {
    const done = adopt(root);
    assert.match(done.stdout, /skipped krn\.json \(no test command detected/u);
    const contract = krn(root, 'repo', 'contract');
    assert.equal(contract.status, 65);
    assert.match(contract.stderr, /no test command/u);
  });
});

test('fixture 10: php composer with phpunit is not detected and says so', () => {
  withRepository(
    {
      'composer.json': '{"require-dev":{"phpunit/phpunit":"^11"}}\n',
      'phpunit.xml': '<phpunit/>\n',
      'tests/CalcTest.php': '<?php\n',
    },
    (root) => {
      const done = adopt(root);
      assert.match(
        done.stdout,
        /skipped krn\.json \(no test command detected/u,
      );
      assert.equal(krn(root, 'repo', 'contract').status, 65);
    },
  );
});

test('fixture 11: an adoption that is not on origin yet stops lane start with the remedy', () => {
  withRepository(pytestProject, (root) => {
    const bare = mkdtempSync(join(tmpdir(), 'krn-portability-origin-'));
    try {
      git(bare, 'init', '-q', '--bare', '-b', 'main');
      git(root, 'remote', 'add', 'origin', bare);
      git(root, 'push', '-q', 'origin', 'main');
      git(root, 'fetch', '-q', 'origin');
      adopt(root);
      const started = krn(
        root,
        'lane',
        'start',
        'probe',
        '--task',
        't-abc1234',
        '--class',
        'delivery',
      );
      assert.equal(started.status, 64);
      assert.match(
        started.stderr,
        /krn\.json is not on origin\/main: commit the files krn adopt wrote/u,
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
