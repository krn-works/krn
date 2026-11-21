import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendExposure,
  readExposures,
  servedExposure,
} from '../../src/brain/exposures.ts';
import {
  changedSinceBase,
  clausesOn,
  failuresIn,
  inspect,
  judgeStop,
  linkPackageModules,
  redTestsAtBase,
  relatedTests,
  runTests,
  selectTests,
  statesBlocker,
  stopHook,
  testEdits,
  testFirstOn,
  testTampering,
  withinPackage,
} from '../../src/hook/stop.ts';
import { resolveContract } from '../../src/repo/contract.ts';
import { serializeClaim } from '../../src/task/claims.ts';

const hook = fileURLToPath(new URL('../../src/hook/stop.ts', import.meta.url));

test('relatedTests picks changed tests and tests importing a changed file', () => {
  const tests = new Map([
    ['test/a.test.ts', "import { x } from '../src/a.ts';"],
    ['test/b.test.ts', "import { y } from '../src/b.ts';"],
    ['test/c/c.test.ts', "const m = await import('../../src/a.js');"],
  ]);
  assert.deepEqual(relatedTests(['src/a.ts'], tests), [
    'test/a.test.ts',
    'test/c/c.test.ts',
  ]);
  assert.deepEqual(relatedTests(['test/b.test.ts'], tests), ['test/b.test.ts']);
  assert.deepEqual(relatedTests(['docs/x.md'], tests), []);
});

test('statesBlocker needs a BLOCKER line with a reason', () => {
  assert.equal(statesBlocker('done\nBLOCKER: no network'), true);
  assert.equal(statesBlocker('BLOCKER:'), false);
  assert.equal(statesBlocker('the blocker is gone'), false);
  assert.equal(statesBlocker(undefined), false);
});

function sh(cwd: string, ...args: string[]) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

/** These tests probe the test selection, not the red-at-base arm: they opt out of it. */
const optOut = {
  ...process.env,
  KRN_TEST_FIRST: '0',
  KRN_ACCEPTANCE_CLAUSES: '0',
};

// The clone owns its package.json: node reads the nearest one, and a host tmp parent may hold an invalid one.
function clone(parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, 'worker-stop-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  return dir;
}

const payload = (cwd: string, message = 'finished') => ({
  cwd,
  last_assistant_message: message,
});
const lane = (dir: string) => ({
  CLAUDE_PROJECT_DIR: dir,
  KRN_SESSION_CLASS: 'lane',
  KRN_SCOPE: 'src/',
});

test('no commit refuses, red refuses, green commit allows, blocker and lead escape', () => {
  const dir = clone();
  try {
    const green = () => [];
    const red = (root: string) => (root === dir ? ['test/a.test.ts::x'] : []);
    assert.match(judgeStop(payload(dir), lane(dir), green) ?? '', /no commit/u);
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    assert.match(judgeStop(payload(dir), lane(dir), red) ?? '', /red/u);
    assert.equal(judgeStop(payload(dir), lane(dir), green), undefined);
    assert.equal(
      judgeStop(payload(dir, 'BLOCKER: tests need a token'), lane(dir), red),
      undefined,
    );
    assert.equal(
      judgeStop(payload(dir), { CLAUDE_PROJECT_DIR: dir }, red),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook reports a reason with exit 0 when a worker has no commit', () => {
  const dir = clone();
  try {
    const out = spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify(payload(dir)),
      env: { ...process.env, ...lane(dir) },
    });
    assert.equal(out.status, 0);
    assert.match(out.stderr, /Stop refused: there is no commit/u);
    const check = spawnSync(process.execPath, [hook, '--check'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(check.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lane brief names the related-test command and the blocker escape', async () => {
  const { workerRules } = await import('../../src/cli/lane-brief.ts');
  const rules = workerRules(fileURLToPath(new URL('../..', import.meta.url)));
  assert.match(rules, /bin\/krn hook stop --check/u);
  assert.match(rules, /BLOCKER:/u);
});

function realTests(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.(?:ts|mjs|js|cjs)$/u.test(path))
        found.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk('test');
  return found;
}

test('relatedTests selects tests naming a changed data file by path in the real test tree', () => {
  const tests = realTests();
  const settings = relatedTests(['.claude/settings.json'], tests);
  assert.ok(settings.includes('test/claude/thinking-settings.test.ts'));
  assert.ok(settings.includes('test/rules/context-budget.test.ts'));
  const receivers = relatedTests(['spec/receivers.json'], tests);
  assert.ok(receivers.includes('test/rules/receiver-evidence.test.mjs'));
  assert.deepEqual(receivers, [...receivers].sort());
});

test('relatedTests selects the whole-project tool probe when a tool config changes', () => {
  const tests = realTests();
  assert.ok(
    relatedTests(['.claude/settings.json'], tests).includes(
      'test/tool-scope.test.ts',
    ),
  );
  assert.ok(
    !relatedTests(['docs/x.md'], tests).includes('test/tool-scope.test.ts'),
  );
  assert.ok(
    !relatedTests(['tasks/t-1.json'], tests).includes(
      'test/tool-scope.test.ts',
    ),
  );
});

test('KRN own contract keeps an unrelated source change to importers plus its guards', () => {
  const tests = realTests();
  const guard = (resolveContract('.').contract.guard ?? '').split(' ');
  assert.ok(guard.includes('test/rules/'));
  const picked = relatedTests(['src/hook/stop.ts'], tests, guard);
  const guards = [...tests.keys()].filter((p) => p.startsWith('test/rules/'));
  assert.ok(guards.length > 0);
  for (const each of guards) assert.ok(picked.includes(each), each);
  assert.ok(picked.includes('test/evals/fr40-freeze.test.ts'));
  assert.ok(picked.includes('test/hook/stop.test.ts'));
  assert.ok(
    picked.every(
      (p) =>
        p.startsWith('test/rules/') ||
        p === 'test/evals/fr40-freeze.test.ts' ||
        tests.get(p)?.includes('hook/stop'),
    ),
  );
  assert.deepEqual(relatedTests([], tests, guard), []);
});

test('a worker clone with no origin/main or main is refused once, naming the missing base', () => {
  const dir = clone();
  try {
    sh(dir, 'branch', '-m', 'main', 'replay');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const green = () => [];
    assert.match(
      judgeStop(payload(dir), lane(dir), green) ?? '',
      /no base resolves.*BLOCKER:/su,
    );
    assert.equal(
      judgeStop(payload(dir, 'BLOCKER: no base'), lane(dir), green),
      undefined,
    );
    assert.equal(
      judgeStop({ ...payload(dir), stop_hook_active: true }, lane(dir), green),
      undefined,
    );
    assert.equal(
      judgeStop(payload(dir), { CLAUDE_PROJECT_DIR: dir }, green),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PASSING =
  "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n";
const FAILING_ONE =
  "import test from 'node:test';\nimport assert from 'node:assert';\ntest('one', () => { assert.fail('red'); });\ntest('two', () => {});\n";
const FAILING_TWO =
  "import test from 'node:test';\nimport assert from 'node:assert';\ntest('one', () => { assert.fail('red'); });\ntest('two', () => { assert.fail('red'); });\n";

/** A repo whose base holds `before` as test/t.test.mjs and whose branch commit changes it to `after`. */
function repoWith(before: string, after: string) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/t.test.mjs'), before);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(dir, 'test/t.test.mjs'), after);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

const worktrees = (dir: string) =>
  spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout.match(/^worktree /gmu)?.length;

test('a test red at the base and red at HEAD is ignored and counted', () => {
  const dir = repoWith(FAILING_ONE, `${FAILING_ONE}// touched\n`);
  try {
    const outcome = inspect(dir);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(outcome.ignored, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a test green at the base and red at HEAD is refused by name', () => {
  const dir = repoWith(PASSING, FAILING_ONE);
  try {
    const outcome = inspect(dir);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /test\/t\.test\.mjs :: one/u);
    assert.doesNotMatch(outcome.reason, /:: two/u);
    assert.match(outcome.reason, /pre-existing failures were ignored/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a different test newly red beside one already red is refused', () => {
  const dir = repoWith(FAILING_ONE, FAILING_TWO);
  try {
    const outcome = inspect(dir);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /:: two/u);
    assert.doesNotMatch(outcome.reason, /:: one/u);
    assert.equal(outcome.ignored, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that loads at the base and fails to load at HEAD is refused', () => {
  const dir = repoWith(PASSING, "import './missing.mjs';\n");
  try {
    const outcome = inspect(dir);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /test\/t\.test\.mjs/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the temporary base worktree exists while the base run happens and is gone after', () => {
  const dir = repoWith(PASSING, FAILING_ONE);
  try {
    const roots: string[] = [];
    const seen: boolean[] = [];
    const run = (root: string) => {
      roots.push(root);
      seen.push(existsSync(root));
      return root === dir ? ['test/t.test.mjs::one'] : [];
    };
    assert.equal(inspect(dir, run).ok, false);
    assert.equal(roots.length, 3);
    assert.notEqual(roots[2], dir);
    assert.deepEqual(seen, [true, true, true]);
    assert.equal(existsSync(roots[2] ?? dir), false);
    assert.equal(worktrees(dir), 1);
    const throwing = (root: string): string[] => {
      if (root !== dir) throw new Error('base run died');
      return ['test/t.test.mjs::one'];
    };
    assert.throws(() => inspect(dir, throwing), /base run died/u);
    assert.equal(worktrees(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a base that already tracks a node_modules symlink still runs at the base', () => {
  // D23 clones commit the node_modules symlink with the harness; linking it again threw EEXIST (dev-k3 unit 568).
  const dir = repoWith(PASSING, FAILING_ONE);
  const modules = mkdtempSync(join(tmpdir(), 'worker-stop-modules-'));
  try {
    symlinkSync(modules, join(dir, 'node_modules'));
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'add', 'node_modules');
    sh(dir, 'commit', '-q', '-m', 'track node_modules');
    sh(dir, 'checkout', '-q', 'work');
    sh(dir, 'rebase', '-q', 'main');
    const roots: string[] = [];
    const run = (root: string) => {
      roots.push(root);
      return root === dir ? ['test/t.test.mjs::one'] : [];
    };
    assert.equal(inspect(dir, run).ok, false);
    assert.equal(roots.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(modules, { recursive: true, force: true });
  }
});

// Verbatim failure output of real runners (pytest 9 via uvx, go 1.27.3 `go test ./calc`), captured 2026-11-13.
const PYTEST_RED =
  'FAILED tests/test_calc.py::test_add - assert -1 == 3\n========================= 1 failed, 1 passed in 0.04s ==========================\n';
const GO_RED =
  '--- FAIL: TestAdd (0.00s)\n    calc_test.go:7: bad\nFAIL\nFAIL\texample.com/gom/calc\t0.003s\nFAIL\n';

test('failuresIn names failing tests from pytest and go output, else the exit status', () => {
  assert.deepEqual(failuresIn(PYTEST_RED, 1), ['tests/test_calc.py::test_add']);
  assert.deepEqual(failuresIn(GO_RED, 1), ['TestAdd', 'example.com/gom/calc']);
  assert.deepEqual(failuresIn('boom\n', 2), ['<run>::exit 2']);
  assert.deepEqual(failuresIn('ok\n', 0), []);
  assert.deepEqual(failuresIn('ERROR: handled retry\nok\n', 0), []);
});

test('failuresIn keeps a failing unittest run whose logging pipeline exited zero', () => {
  const output =
    'FAIL: test_regression (test_example.Example.test_regression)\n----\nAssertionError: 1 != 2\n\nRan 1 test in 0.001s\n\nFAILED (failures=1)\n';
  assert.deepEqual(failuresIn(output, 0), [
    'test_example.Example.test_regression',
  ]);
});

test('failuresIn keeps a failing Vitest run whose logging pipeline exited zero', () => {
  const capture = readFileSync(
    join(import.meta.dirname, 'fixtures', 'stop-refusal-pilot-worktree.txt'),
    'utf8',
  );
  assert.deepEqual(failuresIn(capture.slice(capture.indexOf('\n') + 1), 0), [
    'tests/cli/url-language.test.ts',
    'tests/cli/url-plan.test.ts',
  ]);
  for (const summary of [
    'Tests:       1 failed, 3 passed, 4 total',
    '  2 failing',
    'ℹ fail 1',
  ])
    assert.notDeepEqual(failuresIn(`${summary}\n`, 0), []);
  for (const summary of [
    'Tests  0 failed | 4 passed',
    '  0 failing',
    'ℹ fail 0',
  ])
    assert.deepEqual(failuresIn(`${summary}\n`, 0), []);
});

test('a test command piped into a logger keeps its failing exit under the Stop hook shell', async () => {
  // Loaded by name so the base source, which lacks the shell wrapper, fails by assertion.
  const stop: Record<string, unknown> = await import('../../src/hook/stop.ts');
  const testShell = stop.testShell;
  assert.equal(
    typeof testShell,
    'function',
    'the Stop hook names its test shell',
  );
  if (typeof testShell !== 'function') return;
  const exit = (command: string) => {
    const [file, args] = testShell(command) as [string, string[]];
    return spawnSync(file, args).status;
  };
  assert.notEqual(exit('false | cat'), 0);
  assert.equal(exit('true | cat'), 0);
});

test('selectTests: name match for other stacks, go packages, guards, full fallback, deleted files', () => {
  const py = new Map([
    ['tests/test_calc.py', 'from calc import add'],
    ['tests/test_other.py', ''],
    ['tests/invariants/test_tree.py', ''],
  ]);
  assert.deepEqual(selectTests(['src/calc.py'], py), {
    files: ['tests/test_calc.py'],
    full: false,
  });
  // A change no test relates to runs the guards when the contract has some, else the full test command.
  assert.deepEqual(selectTests(['README.md'], py), { files: [], full: true });
  assert.deepEqual(selectTests(['README.md'], py, ['tests/invariants/']), {
    files: ['tests/invariants/test_tree.py'],
    full: false,
  });
  assert.deepEqual(selectTests([], py), { files: [], full: false });
  // A deleted module still selects the tests importing it.
  const js = new Map([
    ['test/a.test.ts', "import { a } from '../src/gone.ts';"],
  ]);
  assert.deepEqual(selectTests(['src/gone.ts'], js).files, ['test/a.test.ts']);
  const go = new Map([['calc/calc_test.go', '']]);
  assert.deepEqual(
    selectTests(
      ['calc/calc.go', 'main.go', 'gone/x.go'],
      go,
      [],
      true,
      (d) => d !== 'gone',
    ),
    { files: ['.', './calc'], full: false },
  );
});

test('a deleted file is in the change set, so its importers are selected', () => {
  const dir = clone();
  try {
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test');
    sh(dir, 'branch', '-f', 'main');
    sh(dir, 'rm', '-q', 'src/a.ts');
    sh(dir, 'commit', '-q', '-m', 'delete');
    const seen: string[][] = [];
    const run = (root: string, tests: string[]) => {
      if (root === dir) seen.push(tests);
      return root === dir ? ['test/a.test.ts::<load>'] : [];
    };
    assert.equal(inspect(dir, run).ok, false);
    // The first run and its one rerun of the failing file.
    assert.deepEqual(seen, [['test/a.test.ts'], ['test/a.test.ts']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A git repository on `main` holding `files`, then a `work` branch. */
function stackRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-stack-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  return dir;
}

function commitFile(dir: string, path: string, text: string) {
  writeFileSync(join(dir, path), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', `edit ${path}`);
}

const ADD_GREEN = 'def add(a, b):\n    return a + b\n';
const ADD_RED = 'def add(a, b):\n    return a - b\n';
const PY_TEST =
  'from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n\ndef test_ok():\n    assert True\n';

test('a pytest repository: the detected contract runs the name-matched test; red refuses, green allows', () => {
  const dir = stackRepo({
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["."]\n',
    'calc.py': ADD_GREEN,
    'tests/test_calc.py': PY_TEST,
  });
  try {
    const commands: string[] = [];
    // The detected `python -m pytest` receives the name-matched test; its output is the captured pytest run.
    const shell = (root: string, command: string) => {
      if (root === dir) commands.push(command);
      return failuresIn(root === dir ? PYTEST_RED : '', root === dir ? 1 : 0);
    };
    const never = () => assert.fail('the node reporter must not run');
    assert.match(
      judgeStop(payload(dir), lane(dir), never, '', shell) ?? '',
      /no commit/u,
    );
    commitFile(dir, 'calc.py', ADD_RED);
    assert.match(
      judgeStop(payload(dir), lane(dir), never, '', shell) ?? '',
      /tests\/test_calc\.py :: test_add/u,
    );
    // The red run reruns its failing file once (still red), then the base run repeats the command.
    assert.deepEqual(commands.slice(0, 2), [
      "python -m pytest 'tests/test_calc.py'",
      "python -m pytest 'tests/test_calc.py'",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pytest is pinned in mise.toml; its absolute path works from fixture directories outside the repository.
const PYTEST = ((found) =>
  found.status === 0 ? found.stdout.trim() : 'pytest')(
  spawnSync('mise', ['which', 'pytest'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  }),
);

test('a pytest repository against real pytest: red refuses, green commit allows', () => {
  const command = `'${PYTEST}'`;
  const dir = stackRepo({
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["."]\n',
    'krn.json': JSON.stringify({
      test: command,
      related: `${command} {files}`,
    }),
    'calc.py': ADD_GREEN,
    'tests/test_calc.py': PY_TEST,
  });
  try {
    commitFile(dir, 'calc.py', ADD_RED);
    const red = inspect(dir, undefined, undefined, optOut);
    assert.equal(red.ok, false);
    assert.match(red.reason, /tests\/test_calc\.py :: test_add/u);
    commitFile(dir, 'calc.py', `${ADD_GREEN}# fixed\n`);
    assert.deepEqual(inspect(dir, undefined, undefined, optOut), {
      ok: true,
      reason: '',
      ignored: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GO_ADD = (op: string) =>
  `package calc\n\nfunc Add(a, b int) int { return a ${op} b }\n`;
const GO_TEST =
  'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n';

test('a go repository: the changed package runs through the detected go test; red refuses, green allows', () => {
  const dir = stackRepo({
    'go.mod': 'module example.com/gom\n\ngo 1.22\n',
    'calc/calc.go': GO_ADD('+'),
    'calc/calc_test.go': GO_TEST,
    'other/other_test.go': 'package other\n',
  });
  try {
    commitFile(dir, 'calc/calc.go', GO_ADD('-'));
    const commands: string[] = [];
    let output = GO_RED;
    // The receiver output is the captured `go test ./calc` run above.
    const shell = (root: string, command: string) => {
      if (root !== dir) return [];
      commands.push(command);
      return failuresIn(output, output === '' ? 0 : 1);
    };
    const red = inspect(dir, () => [], shell, optOut);
    assert.equal(red.ok, false);
    assert.match(red.reason, /TestAdd/u);
    assert.deepEqual(commands, ["go test './calc'"]);
    output = '';
    commitFile(dir, 'calc/calc.go', `${GO_ADD('+')}// fixed\n`);
    assert.deepEqual(
      inspect(dir, () => [], shell, optOut),
      {
        ok: true,
        reason: '',
        ignored: 0,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a change no test relates to runs the full test command, not nothing', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const commands: string[] = [];
    const shell = (root: string, command: string) => {
      if (root === dir) commands.push(command);
      return root === dir ? ['<run>::exit 1'] : [];
    };
    assert.equal(inspect(dir, () => [], shell).ok, false);
    assert.deepEqual(commands, ['sh check.sh']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing test runner refuses even though the base fails the same way', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'no-such-runner',
      related: 'no-such-runner {files}',
    }),
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const outcome = inspect(dir);
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.reason,
      /could not start \(exit 127.*no-such-runner/su,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a test runner that is not executable (exit 126) refuses like a missing one', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: './not-executable.sh',
      related: './not-executable.sh {files}',
    }),
    'not-executable.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const outcome = inspect(dir);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /could not start \(exit 126/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid krn.json refuses once, naming the contract', () => {
  const dir = stackRepo({ 'krn.json': '{"tests": "x"}', 'a.txt': 'a\n' });
  try {
    commitFile(dir, 'a.txt', 'b\n');
    assert.match(
      judgeStop(payload(dir), lane(dir)) ?? '',
      /repo contract is invalid.*unknown field "tests"/su,
    );
    assert.equal(
      judgeStop({ ...payload(dir), stop_hook_active: true }, lane(dir)),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash in the Stop check is reported and never holds the session', () => {
  const crash = () => {
    throw new Error('selector broke');
  };
  const first = stopHook('{}', {}, '', crash);
  assert.equal(first.code, 0);
  assert.match(first.stderr, /Stop check crashed: Error: selector broke/u);
  assert.equal(stopHook('not json', {}, '', crash).code, 0);
});

test('a lane session with slug fix-x is blocked at Stop without a commit, and one with no identity is refused', () => {
  const dir = clone();
  try {
    const green = () => [];
    const named = {
      CLAUDE_PROJECT_DIR: dir,
      KRN_SESSION_CLASS: 'lane',
      KRN_TASK: 't-abc1234',
    };
    assert.match(
      judgeStop(payload(dir), named, green, 'fix-x') ?? '',
      /no commit/u,
    );
    const goal = { ...named, KRN_TASK: undefined, KRN_LANE: 'fix-x' };
    assert.match(
      judgeStop(payload(dir), goal, green, 'fix-x') ?? '',
      /no commit/u,
    );
    const anonymous = { ...goal, KRN_LANE: undefined };
    assert.match(
      judgeStop(payload(dir), anonymous, green, 'fix-x') ?? '',
      /names no task/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure naming no test refuses even when the base fails the same way', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const bothExit1 = () => ['<run>::exit 1'];
    const outcome = inspect(dir, () => [], bothExit1);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ignored, 0);
    assert.match(outcome.reason, /failed before naming any test \(exit 1\)/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a named failure that also fails at the base stays pre-existing', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const outcome = inspect(
      dir,
      () => [],
      () => ['t.py::test_old'],
      optOut,
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ignored, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withinPackage hands a --prefix command paths relative to its package', () => {
  const related = 'npm --prefix packages/seo test -- {files}';
  assert.deepEqual(
    withinPackage(related, ['packages/seo/test/a.test.js', 'docs/x.md']),
    ['test/a.test.js'],
  );
  assert.deepEqual(withinPackage('node --test {files}', ['test/a.test.js']), [
    'test/a.test.js',
  ]);
});

test('a package in a subdirectory runs its related test through the real npm --prefix', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'npm --prefix packages/seo test',
      related: 'npm --prefix packages/seo test -- {files}',
    }),
    'packages/seo/package.json': JSON.stringify({
      name: 'seo',
      private: true,
      scripts: { test: 'node --test' },
    }),
    'packages/seo/page.js': 'export const title = () => "a";\n',
    'packages/seo/test/page.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../page.js';\ntest('title', () => assert.equal(title(), 'a'));\n",
  });
  try {
    commitFile(
      dir,
      'packages/seo/page.js',
      'export const title = () => "a";\n// edit\n',
    );
    assert.equal(inspect(dir, undefined, undefined, optOut).ok, true);
    commitFile(
      dir,
      'packages/seo/page.js',
      'export const title = () => "b";\n',
    );
    const red = inspect(dir, undefined, undefined, optOut);
    assert.equal(red.ok, false);
    assert.match(red.reason, /'test\/page.test.js'/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linkPackageModules gives a base worktree the nested package node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-stop-link-'));
  const base = mkdtempSync(join(tmpdir(), 'worker-stop-link-base-'));
  try {
    mkdirSync(join(root, 'packages/seo/node_modules/dep'), {
      recursive: true,
    });
    writeFileSync(join(root, 'packages/seo/node_modules/dep/i.js'), '1');
    mkdirSync(join(root, 'packages/plain'), { recursive: true });
    linkPackageModules(root, base);
    assert.equal(
      readFileSync(join(base, 'packages/seo/node_modules/dep/i.js'), 'utf8'),
      '1',
    );
    assert.equal(existsSync(join(base, 'packages/plain/node_modules')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('a base failure from a missing module never makes a worktree failure pre-existing', () => {
  const output = "FAIL  tests/a.test.ts\nError: Cannot find module 'vitest'\n";
  const keys = failuresIn(output, 1);
  assert.ok(keys.includes('<run>::missing dependency'));
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const outcome = inspect(
      dir,
      () => [],
      (root) => (root === dir ? ['tests/a.test.ts'] : keys),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /tests\/a\.test\.ts/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Python run without its runner is refused as a missing module, never as a test that passed at the base', () => {
  // Verbatim capture: `python -m pytest` in a krn-pilot-py clone before the install ran.
  const keys = failuresIn('/usr/bin/python: No module named pytest\n', 1);
  assert.deepEqual(keys, ['<run>::exit 1', '<run>::missing dependency']);
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      install: 'python3 -m venv .venv',
      test: 'python -m pytest',
      related: 'python -m pytest {files}',
    }),
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const outcome = inspect(
      dir,
      () => [],
      () => keys,
    );
    assert.equal(outcome.ok, false);
    assert.doesNotMatch(outcome.reason, /passed at the base/u);
    assert.match(outcome.reason, /failed before naming any test/u);
    assert.match(outcome.reason, /module or tool is missing/u);
    assert.match(outcome.reason, /python3 -m venv \.venv/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a subpackage test beside root node tests runs through the contract command, not the node reporter', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({ test: 'npm --prefix packages/seo test' }),
    'test/root.test.mjs': 'export {};\n',
    'packages/seo/tests/a.test.ts': 'export {};\n',
  });
  try {
    commitFile(dir, 'packages/seo/tests/a.test.ts', '// changed\n');
    const commands: string[] = [];
    const outcome = inspect(
      dir,
      () => assert.fail('the node reporter must not run a vitest file'),
      (_root, command) => {
        commands.push(command);
        return [];
      },
      optOut,
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(commands, ['npm --prefix packages/seo test']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Skip markers are assembled so this file never contains the marker the guard refuses.
const jsSkip = `it${'.'}skip('x', () => {});\n`;
const pySkip = `@pytest.mark.${'x'}fail\ndef test_x(): pass\n`;

function withTest(dir: string) {
  writeFileSync(join(dir, 'test/a.test.ts'), "import test from 'node:test';\n");
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'tests');
  sh(dir, 'checkout', '-q', '-B', 'main');
  sh(dir, 'checkout', '-q', '-b', 'task');
}

test('a deleted test file refuses unless the task record names it', () => {
  const dir = clone();
  try {
    withTest(dir);
    sh(dir, 'rm', '-q', 'test/a.test.ts');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'drop');
    const green = () => [];
    assert.match(
      judgeStop(payload(dir), lane(dir), green) ?? '',
      /deleted test file\(s\): test\/a\.test\.ts/u,
    );
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks/t-x.json'),
      '{"acceptance":[{"verify":"git rm test/a.test.ts"}]}',
    );
    assert.equal(
      judgeStop(payload(dir), { ...lane(dir), KRN_TASK: 't-x' }, green),
      undefined,
    );
    assert.equal(
      judgeStop(payload(dir, 'BLOCKER: test is obsolete'), lane(dir), green),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted test is accepted with its deleted source or a Weakens-tests reason, refused with its source kept', () => {
  const green = () => [];
  const branch = (drop: string[], message: string, imports: boolean) => {
    const dir = clone();
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      imports ? "import { a } from '../src/a.ts';\n" : '',
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'tests');
    sh(dir, 'checkout', '-q', '-B', 'main');
    sh(dir, 'checkout', '-q', '-b', 'task');
    for (const path of drop) {
      if (path.includes('>')) {
        const [from, to] = path.split('>') as [string, string];
        mkdirSync(join(dir, 'test/moved'), { recursive: true });
        sh(dir, 'mv', from, to);
      } else sh(dir, 'rm', '-q', path);
    }
    sh(dir, 'commit', '-q', '-m', message);
    return dir;
  };
  const cases: [string[], string, boolean, boolean][] = [
    [['src/a.ts', 'test/a.test.ts'], 'drop', true, true],
    [['src/a.ts', 'test/a.test.ts'], 'drop', false, true],
    [['test/a.test.ts'], 'drop', true, false],
    [['test/a.test.ts>test/moved/a.test.ts'], 'move', true, true],
    [['test/a.test.ts'], 'drop\n\nWeakens-tests: obsolete', true, true],
  ];
  for (const [drop, message, imports, accepted] of cases) {
    const dir = branch(drop, message, imports);
    try {
      const reason = judgeStop(payload(dir), lane(dir), green);
      if (accepted) assert.equal(reason, undefined);
      else
        assert.match(
          reason ?? '',
          /deleted test file\(s\): test\/a\.test\.ts/u,
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a deleted test is accepted when it imports a source the branch deletes, whatever the stem', () => {
  const green = () => [];
  // [deleted paths, test path, test imports, accepted]; the first row is 706c874's exact pair.
  const cases: [string[], string, string[], boolean][] = [
    [
      ['src/adopt/unused.ts', 'test/adopt/prune-unused.test.ts'],
      'test/adopt/prune-unused.test.ts',
      ['../../src/adopt/unused.ts'],
      true,
    ],
    [
      ['src/adopt/unused.ts', 'test/adopt/prune-unused.test.ts'],
      'test/adopt/prune-unused.test.ts',
      ['../../src/adopt/unused.ts', '../../src/adopt/kept.ts'],
      true,
    ],
    [
      ['test/adopt/prune-unused.test.ts'],
      'test/adopt/prune-unused.test.ts',
      ['../../src/adopt/kept.ts'],
      false,
    ],
  ];
  for (const [drop, test, imports, accepted] of cases) {
    const dir = clone();
    try {
      mkdirSync(join(dir, 'src/adopt'), { recursive: true });
      mkdirSync(join(dir, 'test/adopt'), { recursive: true });
      for (const file of ['unused', 'kept'])
        writeFileSync(
          join(dir, `src/adopt/${file}.ts`),
          `export const ${file} = 1;\n`,
        );
      writeFileSync(
        join(dir, test),
        `${imports.map((from) => `import '${from}';`).join('\n')}\n`,
      );
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-q', '-m', 'tests');
      sh(dir, 'checkout', '-q', '-B', 'main');
      sh(dir, 'checkout', '-q', '-b', 'task');
      for (const path of drop) sh(dir, 'rm', '-q', path);
      sh(dir, 'commit', '-q', '-m', 'drop');
      const reason = judgeStop(payload(dir), lane(dir), green);
      if (accepted) assert.equal(reason, undefined);
      else
        assert.match(
          reason ?? '',
          /deleted test file\(s\): test\/adopt\/prune-unused\.test\.ts/u,
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an added skip or xfail refuses, in a changed and in a new test file', () => {
  const dir = clone();
  try {
    withTest(dir);
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      `import test from 'node:test';\n${jsSkip}`,
    );
    writeFileSync(join(dir, 'test_new.py'), pySkip);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'skip');
    const reason = judgeStop(payload(dir), lane(dir), () => []) ?? '';
    assert.match(
      reason,
      /added skip\/xfail in: test\/a\.test\.ts, test_new\.py/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edited pre-existing test is not refused', () => {
  const dir = clone();
  try {
    withTest(dir);
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import test from 'node:test';\ntest('y', () => {});\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'edit');
    assert.equal(
      judgeStop(payload(dir), lane(dir), () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function testFirstBranch(dir: string) {
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  writeFileSync(
    join(dir, 'test/a.test.ts'),
    "import { a } from '../src/a.ts';\nvoid a;\n",
  );
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
}

test('test-first: Stop refuses when no changed test is red at the base', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    const green = () => [];
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    const reason = judgeStop(payload(dir), env, green) ?? '';
    assert.match(reason, /Test-first rule/u);
    assert.match(reason, /no changed test fails at the base/u);
    assert.equal(
      judgeStop(payload(dir, 'BLOCKER: no defect to show'), env, green),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-first: a docs-only diff is not refused and needs no red-at-base proof', () => {
  const dir = clone();
  try {
    mkdirSync(join(dir, 'docs/notes'), { recursive: true });
    writeFileSync(join(dir, 'docs/notes/t-5sxsphp.md'), '# Note\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'docs: add a note');
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.equal(
      judgeStop(payload(dir), env, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-first: a source change next to a docs file is still refused without a test', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'README.md'), '# Changed\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.match(
      judgeStop(payload(dir), env, () => []) ?? '',
      /Test-first rule/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-first: Stop accepts a test red at the base and green on head', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    const baseRed = (root: string) =>
      root === dir ? [] : ['test/a.test.ts::a is 2'];
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.equal(judgeStop(payload(dir), env, baseRed), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-first: a test red at the base that is not green on head is refused', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    const redAlways = () => ['test/a.test.ts::a is 2'];
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.match(judgeStop(payload(dir), env, redAlways) ?? '', /red/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const file of ['tests/GetInTest.php', 'test/parse-link-header.js']) {
  test(`test-first: ${file} counts as a changed test, so a base-red one is accepted`, () => {
    const dir = clone();
    try {
      mkdirSync(join(dir, file.split('/')[0] as string), { recursive: true });
      writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
      writeFileSync(join(dir, file), 'plain test body\n');
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-q', '-m', 'change');
      const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
      const green = () => [];
      const refused = judgeStop(payload(dir), env, green) ?? '';
      assert.doesNotMatch(refused, /no test file changed/u);
      assert.match(refused, /no changed test fails at the base/u);
      const baseRed = (root: string) => (root === dir ? [] : [`${file}::t`]);
      assert.equal(judgeStop(payload(dir), env, baseRed), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('clause 10: characterization, a tests-only diff passing at the base and head satisfies test-first', () => {
  const dir = clone();
  try {
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'characterize');
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.equal(
      judgeStop(payload(dir), env, () => []),
      undefined,
    );
    // Red on head is still refused.
    assert.match(
      judgeStop(payload(dir), env, () => ['test/a.test.ts::a']) ?? '',
      /red|fail/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 8: a tests-only diff with empty sandbox placeholders present is characterization', () => {
  const dir = clone();
  try {
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    for (const name of ['.env', '.env.local', '.npmrc', '.mcp.json'])
      writeFileSync(join(dir, name), '');
    sh(dir, 'add', 'test');
    sh(dir, 'commit', '-q', '-m', 'characterize');
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.equal(
      judgeStop(payload(dir), env, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 9: one shared list names the placeholders and a non-empty file of the same name still counts', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, '.npmrc'), '');
    writeFileSync(join(dir, '.env'), 'KEY=1\n');
    assert.deepEqual(changedSinceBase(dir), ['.env']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 12, clause 14, clause 16: the --red mode prints a test red at the base and nothing for one green at the base, under a tmp parent with an invalid package.json', () => {
  const parent = mkdtempSync(join(tmpdir(), 'worker-stop-parent-'));
  writeFileSync(join(parent, 'package.json'), '');
  const dir = clone(parent);
  try {
    const body =
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.ts';\ntest('a', () => assert.equal(a, 2));\n";
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'test/a.test.ts'), body);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'fix');
    const red = spawnSync(process.execPath, [hook, '--red'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(red.status, 0, red.stderr);
    assert.equal(red.stdout.trim(), 'test/a.test.ts');
    sh(dir, 'checkout', '-q', '-B', 'main');
    sh(dir, 'checkout', '-q', '-b', 'char');
    writeFileSync(join(dir, 'test/b.test.ts'), body);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'characterize');
    const green = spawnSync(process.execPath, [hook, '--red'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(green.status, 0, green.stderr);
    assert.equal(green.stdout.trim(), '');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clause 6: a commit line "Clause N: characterizes" accepts a green marked test next to a source change', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "// clause 1\nimport { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.match(
      judgeStop(payload(dir), env, () => []) ?? '',
      /no changed test fails at the base/u,
    );
    sh(
      dir,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'note\n\nClause 1: characterizes: the behaviour already works',
    );
    assert.equal(
      judgeStop(payload(dir), env, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 11: a source change with no red-at-base test stays refused', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    assert.match(
      judgeStop(payload(dir), env, () => []) ?? '',
      /no changed test fails at the base/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop refuses a green branch with no base-red test by default and names the missing red-at-base proof', () => {
  const dir = clone();
  try {
    writeFileSync(
      join(dir, 'krn.json'),
      '{"base":"main","test":"node --test test/"}\n',
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'contract');
    sh(dir, 'checkout', '-q', '-B', 'main');
    sh(dir, 'checkout', '-q', '-b', 'work2');
    testFirstBranch(dir);
    const env: NodeJS.ProcessEnv = { ...lane(dir) };
    delete env.KRN_TEST_FIRST;
    env.KRN_ACCEPTANCE_CLAUSES = '0';
    const reason = judgeStop(payload(dir), env, () => []) ?? '';
    assert.match(reason, /red-at-base proof/u);
    assert.match(reason, /no changed test fails at the base/u);
    const baseRed = (root: string) =>
      root === dir ? [] : ['test/a.test.ts::a is 2'];
    assert.equal(judgeStop(payload(dir), env, baseRed), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('testFirstOn is on for a real test command, off for vacuous, absent or opted-out', () => {
  const real = { base: 'main', test: 'npm test', tracker: 'krn' } as const;
  assert.equal(testFirstOn({}, real), true);
  assert.equal(testFirstOn({}, { ...real, vacuous: true }), false);
  assert.equal(testFirstOn({}, undefined), false);
  assert.equal(testFirstOn({ KRN_TEST_FIRST: '0' }, real), false);
  assert.equal(testFirstOn({ KRN_TEST_FIRST: '1' }, undefined), true);
});

test('KRN_TEST_FIRST=0 lets a green branch with no base-red test end', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    const off = { ...lane(dir), KRN_TEST_FIRST: '0' };
    assert.equal(
      judgeStop(payload(dir), off, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the red-at-base rule line is in the worker rules unless the arm is off', async () => {
  const { workerRules, TEST_FIRST_RULE } = await import(
    '../../src/cli/lane-brief.ts'
  );
  const repo = mkdtempSync(join(tmpdir(), 'worker-rules-'));
  try {
    writeFileSync(join(repo, 'krn.json'), '{"test":"make check"}');
    assert.ok(workerRules(repo, true).includes(TEST_FIRST_RULE));
    assert.ok(!workerRules(repo, false).includes(TEST_FIRST_RULE));
    assert.ok(workerRules(repo).includes(TEST_FIRST_RULE));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  assert.match(TEST_FIRST_RULE, /red at base/u);
});

test('the Stop hook refuses a floor and an unwaived reflex standard and only reports finish and waived ones', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    const record = (change: Record<string, unknown>) => ({
      id: 's-probe',
      type: 'standard',
      area: 'tests',
      layer: 'universal',
      audience: 'worker',
      tier: 'floor',
      text: 'A probe rule.',
      why: 'The hook must read the tier.',
      provenance: { origin: 'test', evidence: ['README.md'], proposals: [] },
      enforcement: { kind: 'command', run: 'false' },
      applies: { stacks: [], needs: [], paths: [], terms: [] },
      status: 'accepted',
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      supersedes: [],
      ...change,
    });
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const stop = (change: Record<string, unknown>) => {
      mkdirSync(join(dir, '.agents'), { recursive: true });
      writeFileSync(
        join(dir, '.agents/standards.json'),
        JSON.stringify([record(change)]),
      );
      return spawnSync(process.execPath, [hook], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify(payload(dir)),
        env: { ...process.env, ...lane(dir) },
      });
    };
    const floor = stop({ tier: 'floor' });
    assert.equal(floor.status, 0);
    assert.match(floor.stderr, /s-probe \(floor\)/u);
    assert.equal(stop({ tier: 'reflex' }).status, 0);
    assert.equal(
      stop({ tier: 'reflex', waiver: 'accepted for the migration' }).status,
      0,
    );
    assert.equal(stop({ tier: 'finish' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Stop hook names the record id and file:line of a planted violation, passes after the fix, and skips a waived record', () => {
  const dir = clone();
  try {
    const record = (change: Record<string, unknown>) => ({
      id: 's-planted',
      type: 'standard',
      area: 'tests',
      layer: 'universal',
      audience: 'worker',
      tier: 'floor',
      text: 'No PLANTED marker.',
      why: 'The marker is forbidden.',
      provenance: { origin: 'test', evidence: ['README.md'], proposals: [] },
      enforcement: {
        kind: 'command',
        run: "! git grep -qIE 'PLANTED' -- 'src/*.ts'",
      },
      applies: { stacks: [], needs: [], paths: [], terms: [] },
      status: 'accepted',
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      supersedes: [],
      ...change,
    });
    mkdirSync(join(dir, '.agents'), { recursive: true });
    const stop = (change: Record<string, unknown> = {}) => {
      writeFileSync(
        join(dir, '.agents/standards.json'),
        JSON.stringify([record(change)]),
      );
      return spawnSync(process.execPath, [hook], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify(payload(dir)),
        env: { ...process.env, ...lane(dir) },
      });
    };
    writeFileSync(
      join(dir, 'src/a.ts'),
      'export const a = 2;\nexport const b = 1; // PLANTED\n',
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const refused = stop();
    assert.equal(refused.status, 0);
    assert.match(refused.stderr, /s-planted/u);
    assert.match(refused.stderr, /src\/a\.ts:2/u);
    assert.equal(
      stop({ tier: 'reflex', waiver: 'accepted for the migration' }).status,
      0,
    );
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'fix');
    assert.equal(stop().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused Stop names the violated record and why, and logs the violation to the exposure log', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(
      join(dir, '.agents/standards.json'),
      JSON.stringify([
        {
          id: 's-probe',
          type: 'standard',
          area: 'tests',
          layer: 'universal',
          audience: 'worker',
          tier: 'floor',
          text: 'A probe rule.',
          why: 'Unrun probes ship broken trees.',
          provenance: {
            origin: 'test',
            evidence: ['README.md'],
            proposals: [],
          },
          enforcement: { kind: 'command', run: 'false' },
          applies: { stacks: [], needs: [], paths: [], terms: [] },
          status: 'accepted',
          supersedes: [],
          recorded_at: '2026-01-01',
          valid_from: '2026-01-01',
          valid_to: null,
        },
      ]),
    );
    const stopped = spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ ...payload(dir), session_id: 'sess-1' }),
      env: { ...process.env, ...lane(dir) },
    });
    assert.equal(stopped.status, 0);
    assert.match(stopped.stderr, /s-probe \(floor\)/u);
    assert.match(stopped.stderr, /why: Unrun probes ship broken trees\./u);
    const [exposure] = readExposures(dir);
    assert.deepEqual(exposure?.refused, ['s-probe']);
    assert.deepEqual(exposure?.served, []);
    assert.equal(exposure?.run, 'sess-1');
    assert.equal(exposure?.violated['s-probe'], true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty untracked sandbox placeholder package.json does not fail a reflex check at Stop; a real untracked one still does', () => {
  const dir = clone();
  try {
    sh(dir, 'rm', '-q', 'package.json');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(
      join(dir, '.agents/standards.json'),
      JSON.stringify([
        {
          id: 's-package-parses',
          type: 'standard',
          area: 'tests',
          layer: 'universal',
          audience: 'worker',
          tier: 'reflex',
          text: 'package.json parses.',
          why: 'A broken manifest breaks every run.',
          provenance: {
            origin: 'test',
            evidence: ['README.md'],
            proposals: [],
          },
          enforcement: {
            kind: 'command',
            run: `[ ! -f package.json ] || node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'`,
          },
          applies: { stacks: [], needs: [], paths: [], terms: [] },
          status: 'accepted',
          supersedes: [],
          recorded_at: '2026-01-01',
          valid_from: '2026-01-01',
          valid_to: null,
        },
      ]),
    );
    const stop = () =>
      spawnSync(process.execPath, [hook], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify(payload(dir)),
        env: { ...process.env, ...lane(dir) },
      });
    for (const name of ['package.json', '.npmrc', '.env.local'])
      writeFileSync(join(dir, name), '');
    const placeholder = stop();
    assert.equal(placeholder.status, 0, placeholder.stderr);
    assert.equal(existsSync(join(dir, 'package.json')), false);
    assert.equal(existsSync(join(dir, '.env.local')), false);
    writeFileSync(join(dir, 'package.json'), '{');
    const broken = stop();
    assert.equal(broken.status, 0);
    assert.match(broken.stderr, /s-package-parses \(reflex\)/u);
    assert.equal(existsSync(join(dir, 'package.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Stop that passes records the passing check of each record the session was served', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 3;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(
      join(dir, '.agents/standards.json'),
      JSON.stringify([
        {
          id: 's-calm',
          type: 'standard',
          area: 'tests',
          layer: 'universal',
          audience: 'worker',
          tier: 'floor',
          text: 'A calm rule.',
          why: 'Calm.',
          provenance: {
            origin: 'test',
            evidence: ['README.md'],
            proposals: [],
          },
          enforcement: { kind: 'command', run: 'true' },
          applies: { stacks: [], needs: [], paths: [], terms: [] },
          status: 'accepted',
          supersedes: [],
          recorded_at: '2026-01-01',
          valid_from: '2026-01-01',
          valid_to: null,
        },
      ]),
    );
    appendExposure(dir, servedExposure('sess-2', 'edit', ['s-calm']));
    spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ ...payload(dir), session_id: 'sess-2' }),
      env: { ...process.env, ...lane(dir) },
    });
    const stopRow = readExposures(dir).find((row) => row.channel === 'stop');
    assert.equal(stopRow?.violated['s-calm'], false);
    assert.equal(stopRow?.outcome['s-calm'], 'followed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adopt canary lane proves the test gate only and is not held by standards', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const failing = (root: string) =>
      root === dir ? ['s-probe (floor): exit 1'] : [];
    const green = () => [];
    const canary = { ...lane(dir), KRN_LANE: 'canary' };
    assert.equal(
      judgeStop(payload(dir), canary, green, '', undefined, failing),
      undefined,
    );
    assert.match(
      judgeStop(payload(dir), lane(dir), green, '', undefined, failing) ?? '',
      /s-probe \(floor\)/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vacuous test command is never green: the Stop gate refuses a committed change', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'krn.json'), '{"test":"exit 0","vacuous":true}\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'adopt');
    sh(dir, 'branch', '-f', 'main');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const green = () => [];
    assert.match(
      judgeStop(payload(dir), lane(dir), green, '', () => []) ?? '',
      /vacuous/u,
    );
    assert.equal(
      judgeStop(payload(dir, 'BLOCKER: no tests yet'), lane(dir), green),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing related test that passes on one rerun is flaky, one that fails again stays red', () => {
  const dir = clone();
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const calls: string[][] = [];
    const flaky = (_root: string, tests: string[]) => {
      calls.push(tests);
      return calls.length === 1 ? ['test/a.test.ts::slow'] : [];
    };
    const passed = inspect(dir, flaky, () => []);
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.flaky, ['test/a.test.ts::slow']);
    assert.deepEqual(calls[1], ['test/a.test.ts']);
    assert.equal(
      judgeStop(payload(dir), lane(dir), () => []),
      undefined,
    );
    const again = (root: string) =>
      root === dir ? ['test/a.test.ts::slow'] : [];
    const red = inspect(dir, again, () => []);
    assert.equal(red.ok, false);
    assert.match(red.reason, /a\.test\.ts :: slow/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a krn-lane subagent payload is held to the Stop check in the lead environment, at its own cwd', () => {
  const dir = clone();
  try {
    const leadEnv = { CLAUDE_PROJECT_DIR: '/somewhere/else' };
    const sub = { ...payload(dir), agent_id: 'a1', agent_type: 'krn-lane' };
    assert.match(judgeStop(sub, leadEnv, () => []) ?? '', /no commit/u);
    assert.equal(
      judgeStop(payload(dir), leadEnv, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a krn-lane subagent whose worktree ship removed is judged at the main checkout that owned it', () => {
  // Evidence: lane t-vs35jd7 merged 6b35f9f (#1137); its worktree was pruned and Stop crashed
  // reading `run.stdout` of a test run spawned in the removed directory.
  const main = clone();
  const gone = join(main, '.krn', 'worktrees', 'ship-close-evidence');
  try {
    writeFileSync(join(main, 'src/a.ts'), 'export const a = 2;\n');
    sh(main, 'commit', '-qam', 'merged lane');
    sh(main, 'checkout', '-q', 'main');
    sh(main, 'merge', '-q', '--ff-only', 'work');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: main,
      encoding: 'utf8',
    }).stdout.trim();
    const sub = (message: string) => ({
      ...payload(gone, message),
      agent_id: 'a1',
      agent_type: 'krn-lane',
    });
    const leadEnv = { CLAUDE_PROJECT_DIR: '/somewhere/else' };
    assert.equal(
      judgeStop(sub(`shipped\nverdict: merged ${head}`), leadEnv),
      undefined,
    );
    assert.doesNotThrow(() => judgeStop(sub('finished'), leadEnv));
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a krn-lane subagent whose payload cwd is another worktree is checked at the worktree its transcript edited or claimed', () => {
  const main = clone();
  const own = join(main, '.krn', 'worktrees', 'lane-own');
  const lead = join(main, '.krn', 'worktrees', 'lead-wt');
  try {
    sh(main, 'worktree', 'add', '-q', '-b', 'lane-own', own, 'main');
    sh(main, 'worktree', 'add', '-q', '-b', 'lead-wt', lead, 'main');
    writeFileSync(join(own, 'src/a.ts'), 'export const a = 2;\n');
    sh(own, 'add', '.');
    sh(own, 'commit', '-q', '-m', 'x');
    const leadEnv = { CLAUDE_PROJECT_DIR: '/somewhere/else' };
    const transcript = (line: string) => {
      const file = join(main, 'agent.jsonl');
      writeFileSync(file, `${line}\n`);
      return file;
    };
    const sub = (agent_transcript_path: string) => ({
      ...payload(lead),
      agent_id: 'a1',
      agent_type: 'krn-lane',
      agent_transcript_path,
    });
    // Last edited path: the lane worktree holds the commit, the lead cwd does not.
    const edited = transcript(
      JSON.stringify({ input: { file_path: join(own, 'src/a.ts') } }),
    );
    assert.equal(
      judgeStop(sub(edited), leadEnv, () => []),
      undefined,
    );
    // Without a transcript the payload cwd (the lead worktree) is judged: no commit there.
    assert.match(
      judgeStop(
        { ...payload(lead), agent_id: 'a1', agent_type: 'krn-lane' },
        leadEnv,
        () => [],
      ) ?? '',
      /no commit/u,
    );
    // A lane claim names the worktree when nothing was edited yet.
    mkdirSync(join(main, '.krn', 'task-claims'), { recursive: true });
    writeFileSync(
      join(main, '.krn', 'task-claims', 't-abcdefg.json'),
      JSON.stringify({ id: 't-abcdefg', worktree: own }),
    );
    const claimed = transcript(JSON.stringify({ text: 'Task id: t-abcdefg' }));
    assert.equal(
      judgeStop(sub(claimed), leadEnv, () => []),
      undefined,
    );
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('the Stop hook import graph names only node builtins, relative files and zod, so a clone without node_modules needs just the link the harness lays', () => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1/gmu,
    )) {
      const specifier = match[2] as string;
      if (specifier.startsWith('.')) walk(join(file, '..', specifier));
      else if (!specifier.startsWith('node:')) bare.add(specifier);
    }
  };
  walk(hook);
  assert.ok(seen.size > 5, 'the walk reached the hook sources');
  assert.deepEqual([...bare].sort(), ['zod']);
});

const redRecord = (id: string, run: string) => ({
  id,
  type: 'standard',
  area: 'tests',
  layer: 'universal',
  audience: 'worker',
  tier: 'reflex',
  text: 'A probe rule.',
  why: 'The hook must tell inherited red from new red.',
  provenance: { origin: 'test', evidence: ['README.md'], proposals: [] },
  enforcement: { kind: 'command', run },
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  status: 'accepted',
  supersedes: [],
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
});

test('Stop ends green on a standard that was already red at the base and refuses one the branch newly broke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-'));
  try {
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'a@b.c');
    sh(dir, 'config', 'user.name', 'a');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, '.agents'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const write = (...records: ReturnType<typeof redRecord>[]) =>
      writeFileSync(
        join(dir, '.agents/standards.json'),
        JSON.stringify(records),
      );
    write(redRecord('s-old', 'false'), redRecord('s-new', 'test ! -f broken'));
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'base');
    sh(dir, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'change');
    const run = () => judgeStop(payload(dir), lane(dir), () => []);
    assert.equal(run(), undefined);
    writeFileSync(join(dir, 'broken'), 'x\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'break');
    const refused = run() ?? '';
    assert.match(refused, /- s-new \(reflex\)/u);
    assert.doesNotMatch(refused, /- s-old/u);
    assert.match(
      refused,
      /already failed at the base and do not block: s-old/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function clauseBranch(dir: string, tests: Record<string, string>) {
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  for (const [file, body] of Object.entries(tests))
    writeFileSync(join(dir, file), body);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
}

const clauseEnv = (dir: string) => ({
  ...lane(dir),
  KRN_ACCEPTANCE_CLAUSES: '1',
  KRN_TASK_BODY: '1. Parse the header line\n2. Reject an empty header',
});

test('clauses: Stop refuses an uncovered clause and names it', () => {
  const dir = clone();
  try {
    clauseBranch(dir, { 'test/a.test.ts': '// clause 1\n' });
    const baseRed = (root: string) =>
      root === dir ? [] : ['test/a.test.ts::a'];
    const reason = judgeStop(payload(dir), clauseEnv(dir), baseRed) ?? '';
    assert.match(reason, /Acceptance-clause rule/u);
    assert.match(reason, /clause 2: Reject an empty header/u);
    assert.doesNotMatch(reason, /clause 1:/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 2: a marked test that passes on head covers its clause even when it already passes at the base', () => {
  const dir = clone();
  try {
    clauseBranch(dir, { 'test/a.test.ts': '// clause 1 clause 2\n' });
    assert.equal(
      judgeStop(payload(dir), clauseEnv(dir), () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 1: a happy-path-only clause set is refused once naming the missing boundary class, then passes', () => {
  const dir = clone();
  try {
    clauseBranch(dir, { 'test/a.test.ts': '// clause 1 clause 2\n' });
    const env = {
      ...clauseEnv(dir),
      KRN_TASK_BODY: '1. Parse the header line\n2. Print the parsed header',
    };
    const reason = judgeStop(payload(dir), env, () => []) ?? '';
    assert.match(reason, /no clause covers a boundary case/u);
    assert.match(reason, /empty input/u);
    writeFileSync(
      join(dir, 'test/a.test.ts'),
      '// clause 1 clause 2 empty input\n',
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'boundary');
    assert.equal(
      judgeStop(payload(dir), env, () => []),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clause 1: the clauses a lane brief states reach Stop through KRN_TASK_BODY whatever the task record says', () => {
  const dir = clone();
  try {
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    writeFileSync(
      join(dir, 'tasks/t-x.json'),
      JSON.stringify({ body: 'Make standard s-readme pass' }),
    );
    clauseBranch(dir, { 'test/a.test.ts': '// nothing marked\n' });
    const env = {
      ...lane(dir),
      KRN_TASK: 't-x',
      KRN_TASK_BODY:
        '1. Parse the header line\n2. Reject an empty header\n3. Keep the order stable\n4. Skip blank lines\n5. Report the line number',
    };
    const reason = judgeStop(payload(dir), env, () => []) ?? '';
    assert.match(reason, /5 of 5 clause\(s\) uncovered/u);
    assert.match(reason, /clause 1: Parse the header line/u);
    assert.match(reason, /Acceptance-clause rule/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clauses: red-to-green tests per clause, or a written not-reproducible, let Stop end', () => {
  const dir = clone();
  try {
    clauseBranch(dir, {
      'test/a.test.ts': '// clause 1\n',
      'test/b.test.ts': '// clause 2\n',
    });
    const baseRed = (root: string) =>
      root === dir ? [] : ['test/a.test.ts::a', 'test/b.test.ts::b'];
    assert.equal(judgeStop(payload(dir), clauseEnv(dir), baseRed), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const other = clone();
  try {
    writeFileSync(join(other, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(other, 'test/a.test.ts'), '// clause 1\n');
    sh(other, 'add', '.');
    sh(
      other,
      'commit',
      '-q',
      '-m',
      'change\n\nClause 2: not reproducible: the base already rejects it',
    );
    const baseRed = (root: string) =>
      root === other ? [] : ['test/a.test.ts::a'];
    assert.equal(
      judgeStop(payload(other), clauseEnv(other), baseRed),
      undefined,
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

const goalEnv = (dir: string) => ({
  ...lane(dir),
  KRN_ACCEPTANCE_CLAUSES: '1',
  KRN_TASK_BODY: 'Add a signup form',
});

test('clauses: a one-line goal makes Stop refuse until three clauses are proven', () => {
  const dir = clone();
  try {
    clauseBranch(dir, {
      'test/a.test.ts': '// clause 1 empty input\n',
      'test/b.test.ts': '// clause 2 duplicate submit\n',
    });
    const baseRed = (root: string) =>
      root === dir ? [] : ['test/a.test.ts::a', 'test/b.test.ts::b'];
    const reason = judgeStop(payload(dir), goalEnv(dir), baseRed) ?? '';
    assert.match(reason, /under 2 clauses/u);
    assert.match(reason, /2 found/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clauses: a one-line goal ends with three proven clauses', () => {
  const dir = clone();
  try {
    clauseBranch(dir, {
      'test/a.test.ts': '// clause 1 empty input\n',
      'test/b.test.ts': '// clause 2 duplicate submit\n',
      'test/c.test.ts': '// clause 3 non-ASCII name\n',
    });
    const all = ['test/a.test.ts::a', 'test/b.test.ts::b', 'test/c.test.ts::c'];
    assert.equal(
      judgeStop(payload(dir), goalEnv(dir), (root) =>
        root === dir ? [] : all,
      ),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clausesOn is on for a real test command, off for vacuous, absent or opted-out', () => {
  const real = { base: 'main', test: 'npm test', tracker: 'krn' } as const;
  assert.equal(clausesOn({}, real), true);
  assert.equal(clausesOn({}, { ...real, vacuous: true }), false);
  assert.equal(clausesOn({}, undefined), false);
  assert.equal(clausesOn({ KRN_ACCEPTANCE_CLAUSES: '0' }, real), false);
  assert.equal(clausesOn({ KRN_ACCEPTANCE_CLAUSES: '1' }, undefined), true);
});

test('clauses: the arm off leaves Stop unchanged', () => {
  const dir = clone();
  try {
    clauseBranch(dir, { 'test/a.test.ts': '// nothing\n' });
    const { KRN_ACCEPTANCE_CLAUSES: _on, ...off } = clauseEnv(dir);
    assert.equal(
      judgeStop(
        payload(dir),
        { ...off, KRN_ACCEPTANCE_CLAUSES: '0' },
        () => [],
      ),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a contract with arms off turns the red-first and clause arms off, an explicit env still wins', () => {
  const real = { base: 'main', test: 'npm test', tracker: 'krn' } as const;
  const off = { ...real, arms: { 'red-first': false, clauses: false } };
  assert.equal(testFirstOn({}, off), false);
  assert.equal(clausesOn({}, off), false);
  assert.equal(testFirstOn({ KRN_TEST_FIRST: '1' }, off), true);
  assert.equal(clausesOn({ KRN_ACCEPTANCE_CLAUSES: '1' }, off), true);
  assert.equal(testFirstOn({}, { ...real, arms: { clauses: false } }), true);
});

function subagentTranscript(dir: string, tools: unknown[]): string {
  const path = join(dir, 'agent.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'research, read-only' } },
    ...tools.map((tool) => ({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', ...(tool as object) }],
      },
    })),
  ];
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
  return path;
}

test('a test root that does not exist is named by its directory, not by the node program', () => {
  // Evidence: three research lanes (t-tpkc9xz) saw `spawnSync .../node ENOENT` with node installed.
  const dir = clone();
  const gone = join(dir, 'vanished-root');
  try {
    const stopped = stopHook(
      JSON.stringify(payload(gone)),
      { ...lane(gone), KRN_TASK: 't-abc1234' },
      'work',
    );
    assert.equal(stopped.code, 0);
    assert.ok(stopped.stderr.includes(gone), stopped.stderr);
    assert.doesNotMatch(stopped.stderr, /spawnSync|ENOENT/u);
    // The runner itself, the layer that spawned in the missing directory, names it too.
    const ran = runTests(gone, ['test/a.test.ts']);
    assert.ok(Array.isArray(ran));
    assert.equal(ran.length, 1);
    assert.ok(ran[0]?.includes(gone), ran[0]);
    assert.doesNotMatch(ran[0] ?? '', /spawnSync|ENOENT/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing test command refusal carries a bounded excerpt and the full log path', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    const noise = 'noise line\n'.repeat(200_000);
    const output = `${noise}FAILED tests/calc.test.ts::adds - expected 3 but got -1\n`;
    const shell = (root: string) =>
      root === dir
        ? { failures: failuresIn(output, 1), output }
        : { failures: [], output: '' };
    const red = inspect(dir, () => [], shell, optOut);
    assert.equal(red.ok, false);
    assert.match(red.reason, /tests\/calc\.test\.ts :: adds/u);
    const log = /full log: (\S+\.log)\)/u.exec(red.reason)?.[1] ?? '';
    assert.ok(
      log.startsWith(join(dir, '.krn', 'runs', 'stop-check')),
      `log path ${log}`,
    );
    assert.equal(readFileSync(log, 'utf8'), output);
    assert.match(red.reason, /expected 3 but got -1/u);
    assert.ok(red.reason.length < 8000, `reason is ${red.reason.length} chars`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real failing command refusal quotes its output and names the log', () => {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
    }),
    'check.sh': 'exit 0\n',
    'notes.txt': 'a\n',
  });
  try {
    commitFile(dir, 'notes.txt', 'b\n');
    writeFileSync(
      join(dir, 'check.sh'),
      'echo "FAILED t.test.ts::adds - boom"\nexit 1\n',
    );
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'break check');
    const red = inspect(dir, () => [], undefined, optOut);
    assert.equal(red.ok, false);
    assert.match(red.reason, /FAILED t\.test\.ts::adds - boom/u);
    assert.match(red.reason, /\.krn\/runs\/stop-check\/\S+\.log/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A repository whose contract runs tests by shell command; its changed test lives outside test/, so the contract command runs it. */
function foreignTestBranch() {
  const dir = stackRepo({
    'krn.json': JSON.stringify({
      test: 'sh check.sh',
      related: 'sh check.sh {files}',
      install: 'npm ci',
    }),
    'check.sh': 'exit 0\n',
    'src/a.txt': 'a\n',
  });
  writeFileSync(join(dir, 'src/a.txt'), 'b\n');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests/GetInTest.php'), 'plain test body\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

const baseRun = (dir: string, output: string) => (root: string) =>
  root === dir
    ? { failures: [], output: '' }
    : { failures: failuresIn(output, 1), output };

test('test-first: a base worktree lacking its dependencies is named a base-environment failure, not a red test', () => {
  const dir = foreignTestBranch();
  try {
    const env = {
      ...lane(dir),
      KRN_TEST_FIRST: '1',
      KRN_ACCEPTANCE_CLAUSES: '0',
    };
    const output = 'sh: line 1: vitest: not found\n';
    const reason =
      judgeStop(payload(dir), env, () => [], '', baseRun(dir, output)) ?? '';
    assert.match(reason, /base environment is broken/u);
    assert.match(reason, /npm ci/u);
    assert.doesNotMatch(reason, /no changed test/u);
    const saved = readFileSync(
      join(dir, '.krn/runs/stop-check/base-environment.log'),
      'utf8',
    );
    assert.match(saved, /vitest: not found/u);
    assert.match(
      readFileSync(join(dir, '.krn/runs/stop-check/base-run.log'), 'utf8'),
      /tests\/GetInTest\.php at the base/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-first: a base run missing a source file of the repository is still a red test', () => {
  const dir = foreignTestBranch();
  try {
    const env = {
      ...lane(dir),
      KRN_TEST_FIRST: '1',
      KRN_ACCEPTANCE_CLAUSES: '0',
    };
    const output =
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/src/new.ts'\n";
    assert.equal(
      judgeStop(payload(dir), env, () => [], '', baseRun(dir, output)),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verbatim Stop check refusal from a copy of the pilot commit under host load is a red test, not a broken base environment', () => {
  const dir = foreignTestBranch();
  try {
    const captured = readFileSync(
      new URL('./fixtures/stop-refusal-pilot-worktree.txt', import.meta.url),
      'utf8',
    );
    const env = {
      ...lane(dir),
      KRN_TEST_FIRST: '1',
      KRN_ACCEPTANCE_CLAUSES: '0',
    };
    const reason =
      judgeStop(payload(dir), env, () => [], '', baseRun(dir, captured)) ?? '';
    assert.doesNotMatch(reason, /base environment is broken/u);
    assert.deepEqual(failuresIn(captured, 1), [
      'tests/cli/url-language.test.ts',
      'tests/cli/url-plan.test.ts',
    ]);
    assert.equal(
      judgeStop(
        payload(dir),
        env,
        () => [],
        '',
        baseRun(dir, 'sh: vitest: not found'),
      ) !== undefined,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The pilot receiver's contract, verbatim, with no `related` command: every changed test reruns the whole suite. */
const PILOT_SUITE =
  'npm --prefix packages/seo run build && npm --prefix packages/seo test';
const PILOT_TEST = 'packages/seo/tests/cli/recovery-note.test.ts';
const pilotCapture = () =>
  readFileSync(
    new URL('./fixtures/stop-refusal-pilot-worktree.txt', import.meta.url),
    'utf8',
  );

/** A pilot-shaped branch: the contract has no related command, the base holds the suite's other tests, the branch adds one. */
function suiteBranch(added: string[] = [PILOT_TEST]) {
  const dir = stackRepo({
    'krn.json': JSON.stringify({ test: PILOT_SUITE, install: 'npm ci' }),
    'packages/seo/src/cli/main.ts': 'export const run = 1;\n',
    'packages/seo/tests/cli/url-language.test.ts': 'it("a", () => {});\n',
    'packages/seo/tests/cli/url-plan.test.ts': 'it("b", () => {});\n',
  });
  writeFileSync(
    join(dir, 'packages/seo/src/cli/main.ts'),
    'export const run = 2;\n',
  );
  for (const file of added)
    writeFileSync(join(dir, file), 'it("recovers", () => {});\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

const VITEST_PASS = ' Test Files  274 passed (274)\n';
const vitestFail = (file: string) =>
  ` FAIL  ${file} > recovers\nAssertionError: expected 1 to be 2\n Test Files  1 failed | 273 passed (274)\n`;

/** A shell stub answering the base worktree and the head checkout from their own queues; an empty queue passes. */
function queuedShell(dir: string, base: string[], head: string[] = []) {
  const calls: { at: 'base' | 'head'; command: string }[] = [];
  const shell = (root: string, command: string) => {
    const at = root === dir ? 'head' : 'base';
    calls.push({ at, command });
    const output = (at === 'head' ? head : base).shift() ?? VITEST_PASS;
    return {
      failures: failuresIn(output, output === VITEST_PASS ? 0 : 1),
      output,
    };
  };
  return { shell, calls };
}

const testFirst = (dir: string) => ({
  ...lane(dir),
  KRN_TEST_FIRST: '1',
  KRN_ACCEPTANCE_CLAUSES: '0',
});

test('red-at-base with no related command: one flaky suite failure at the base names no changed file as red', () => {
  const dir = suiteBranch();
  try {
    const { shell, calls } = queuedShell(dir, [pilotCapture()]);
    assert.deepEqual(
      redTestsAtBase(dir, () => [], shell),
      [],
    );
    // The suite ran once at the base; the failures named no changed file, so nothing was rerun.
    assert.deepEqual(calls, [{ at: 'base', command: PILOT_SUITE }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red-at-base with no related command runs the suite once for every changed test, not once per file', () => {
  const second = 'packages/seo/tests/cli/recovery-plan.test.ts';
  const dir = suiteBranch([PILOT_TEST, second]);
  try {
    const { shell, calls } = queuedShell(dir, [pilotCapture()]);
    assert.deepEqual(
      redTestsAtBase(dir, () => [], shell),
      [],
    );
    assert.equal(calls.filter((call) => call.at === 'base').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red-at-base with no related command: a failure naming the changed test that passes on one rerun is flaky, not red', () => {
  const dir = suiteBranch();
  try {
    const { shell, calls } = queuedShell(dir, [
      vitestFail('tests/cli/recovery-note.test.ts'),
    ]);
    assert.deepEqual(
      redTestsAtBase(dir, () => [], shell),
      [],
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      [PILOT_SUITE, `${PILOT_SUITE} -- 'tests/cli/recovery-note.test.ts'`],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red-at-base with no related command: a failure naming the changed test, package-relative, that fails again is red', () => {
  const dir = suiteBranch();
  try {
    const failing = vitestFail('tests/cli/recovery-note.test.ts');
    const { shell } = queuedShell(dir, [failing, failing]);
    assert.deepEqual(
      redTestsAtBase(dir, () => [], shell),
      [PILOT_TEST],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verbatim pilot refusal on head is settled by one rerun: a test red at the base and green on head stops', () => {
  const dir = suiteBranch();
  try {
    const failing = vitestFail('tests/cli/recovery-note.test.ts');
    // Head: the suite-wide run hits the pilot's load-timed failures, its rerun passes, the proof run hits them again.
    const { shell } = queuedShell(
      dir,
      [failing, failing],
      [pilotCapture(), VITEST_PASS, pilotCapture()],
    );
    assert.equal(
      judgeStop(payload(dir), testFirst(dir), () => [], '', shell),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A real node:test branch whose new test imports a package that only an ancestor directory of the checkout holds:
 * head resolves it, the temporary base worktree (outside that ancestor) has no node_modules to find it in.
 */
function outerModulesBranch(
  testSource: string,
  extra: Record<string, string> = {},
) {
  const outer = mkdtempSync(join(tmpdir(), 'worker-stop-outer-'));
  const dep = join(outer, 'node_modules', 'krn-stop-probe-dep');
  mkdirSync(dep, { recursive: true });
  writeFileSync(
    join(dep, 'package.json'),
    '{"name":"krn-stop-probe-dep","type":"module","exports":"./index.js"}\n',
  );
  writeFileSync(join(dep, 'index.js'), 'export const one = 1;\n');
  const dir = join(outer, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  sh(outer, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  writeFileSync(
    join(dir, 'krn.json'),
    JSON.stringify({ test: 'node --test', related: 'node --test {files}' }),
  );
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/a.test.ts'), testSource);
  for (const [path, text] of Object.entries(extra))
    writeFileSync(join(dir, path), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return { outer, dir };
}

test('test-first through the node runner: a real base worktree without node_modules is a broken base environment, not a red test', () => {
  const { outer, dir } = outerModulesBranch(
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { one } from 'krn-stop-probe-dep';\ntest('one', () => assert.equal(one, 1));\n",
  );
  try {
    const reason = judgeStop(payload(dir), testFirst(dir)) ?? '';
    assert.match(reason, /base environment is broken/u);
    assert.match(reason, /test\/a\.test\.ts/u);
    assert.match(
      readFileSync(
        join(dir, '.krn/runs/stop-check/base-environment.log'),
        'utf8',
      ),
      /Cannot find package 'krn-stop-probe-dep'/u,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('test-first through the node runner: a base missing a new source file of the repository is still a red test', () => {
  const { outer, dir } = outerModulesBranch(
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { b } from '../src/b.ts';\ntest('b', () => assert.equal(b, 2));\n",
    { 'src/b.ts': 'export const b = 2;\n' },
  );
  try {
    assert.equal(judgeStop(payload(dir), testFirst(dir)), undefined);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('a base worktree that cannot be created is an infrastructure fault, not no test red', () => {
  const dir = clone();
  try {
    testFirstBranch(dir);
    writeFileSync(join(dir, '.git', 'worktrees'), 'x'); // git cannot add a worktree
    const env = { ...lane(dir), KRN_TEST_FIRST: '1' };
    const reason = judgeStop(payload(dir), env, () => []) ?? '';
    assert.match(reason, /could not run/u);
    assert.doesNotMatch(reason, /no changed test/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ownAndLead() {
  const main = clone();
  const own = join(main, '.krn', 'worktrees', 'lane-own');
  const lead = join(main, '.krn', 'worktrees', 'lead-wt');
  sh(main, 'worktree', 'add', '-q', '-b', 'lane-own', own, 'main');
  sh(main, 'worktree', 'add', '-q', '-b', 'lead-wt', lead, 'main');
  const sub = (agent_transcript_path: string) => ({
    ...payload(lead),
    agent_id: 'a1',
    agent_type: 'krn-lane',
    agent_transcript_path,
  });
  return { main, own, lead, sub };
}

test('the Stop hook saves its refusal in the checkout it judged, not the project dir', () => {
  const { main, own, lead, sub } = ownAndLead();
  try {
    const path = subagentTranscript(main, [
      { name: 'Edit', input: { file_path: join(own, 'src/a.ts') } },
    ]);
    const env = {
      CLAUDE_PROJECT_DIR: lead,
      KRN_SESSION_CLASS: 'lane',
      KRN_TASK: 't-abc1234',
    };
    const stopped = stopHook(JSON.stringify(sub(path)), env, 'work');
    assert.equal(stopped.code, 0);
    const kept = (dir: string) =>
      existsSync(join(dir, '.krn/runs/stop-check/last-refusal.txt'));
    assert.deepEqual([kept(own), kept(lead)], [true, false]);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('an expired task claim does not name the session lane', () => {
  const { main, own, sub } = ownAndLead();
  try {
    sh(own, 'commit', '-q', '--allow-empty', '-m', 'x');
    const transcript = subagentTranscript(main, [
      { name: 'Bash', input: { command: 'git commit -m t-abcdefg' } },
    ]);
    // The claimed branch is gone: expired, so the lead worktree is judged.
    mkdirSync(join(main, '.krn', 'task-claims'), { recursive: true });
    writeFileSync(
      join(main, '.krn', 'task-claims', 't-abcdefg.json'),
      serializeClaim({
        id: 't-abcdefg',
        actor: 'a',
        worktree: own,
        branch: 'gone',
        claimed: '2026-11-20T00:00:00.000Z',
        reason: null,
      }),
    );
    assert.match(judgeStop(sub(transcript), {}, () => []) ?? '', /no commit/u);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

const headOf = (cwd: string) =>
  spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).stdout.trim();

test('testEdits reports a test renamed to a name no runner collects as deleted', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-stop-rename-')));
  try {
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 'a@b.c');
    sh(repo, 'config', 'user.name', 'a');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(repo, 'test', 'a.test.ts'),
      "import { a } from '../src/a.ts';\nvoid a;\n",
    );
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'base');
    const from = headOf(repo);
    sh(repo, 'checkout', '-q', '-b', 'work');
    sh(repo, 'mv', 'test/a.test.ts', 'test/a.disabled.ts');
    sh(repo, 'commit', '-qm', 'disable test via rename');
    const edits = testEdits(repo, from);
    assert.deepEqual(edits.deleted, ['test/a.test.ts']);
    assert.notEqual(testTampering(edits, ''), undefined);
    sh(repo, 'mv', 'test/a.disabled.ts', 'test/b.test.ts');
    sh(repo, 'commit', '-qm', 'rename to another test');
    assert.deepEqual(testEdits(repo, from).deleted, []);
    sh(repo, 'mv', 'test/b.test.ts', 'test/c.disabled.ts');
    sh(
      repo,
      'commit',
      '-qm',
      'retire test\n\nWeakens-tests: the case moved to a manual script',
    );
    assert.deepEqual(testEdits(repo, from).deleted, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('failuresIn reports no failure for a run that exits 0 whatever its log lines say', () => {
  const stdout =
    'ERROR retrying transient connection refused\nFAIL_SAFE mode enabled\n5 passed in 0.12s\n';
  assert.deepEqual(failuresIn(stdout, 0), []);
  assert.deepEqual(failuresIn(stdout, 1), ['retrying']);
});
