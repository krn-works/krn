import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  failuresIn,
  inspect,
  judgeStop,
  linkPackageModules,
  relatedTests,
  selectTests,
  statesBlocker,
  stopHook,
  withinPackage,
} from '../../scripts/claude/worker-stop.ts';
import { resolveContract } from '../../src/repo/contract.ts';

const hook = fileURLToPath(
  new URL('../../scripts/claude/worker-stop.ts', import.meta.url),
);

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

function clone() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
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

test('the hook refuses with exit 2 and a reason when a worker has no commit', () => {
  const dir = clone();
  try {
    const out = spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify(payload(dir)),
      env: { ...process.env, ...lane(dir) },
    });
    assert.equal(out.status, 2);
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
  const { workerRules } = await import('../../src/cli/lane.ts');
  const rules = workerRules(fileURLToPath(new URL('../..', import.meta.url)));
  assert.match(rules, /scripts\/claude\/worker-stop\.ts --check/u);
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
  const picked = relatedTests(['scripts/claude/worker-stop.ts'], tests, guard);
  const guards = [...tests.keys()].filter((p) => p.startsWith('test/rules/'));
  assert.ok(guards.length > 0);
  for (const each of guards) assert.ok(picked.includes(each), each);
  assert.ok(picked.includes('test/evals/fr40-freeze.test.ts'));
  assert.ok(picked.includes('test/claude/worker-stop.test.ts'));
  assert.ok(
    picked.every(
      (p) =>
        p.startsWith('test/rules/') ||
        p === 'test/evals/fr40-freeze.test.ts' ||
        tests.get(p)?.includes('worker-stop'),
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
    assert.equal(roots.length, 2);
    assert.notEqual(roots[1], dir);
    assert.deepEqual(seen, [true, true]);
    assert.equal(existsSync(roots[1] ?? dir), false);
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
    assert.equal(roots.length, 2);
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
    assert.deepEqual(seen, [['test/a.test.ts']]);
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
    assert.deepEqual(commands, ["python -m pytest 'tests/test_calc.py'"]);
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
    const red = inspect(dir);
    assert.equal(red.ok, false);
    assert.match(red.reason, /tests\/test_calc\.py :: test_add/u);
    commitFile(dir, 'calc.py', `${ADD_GREEN}# fixed\n`);
    assert.deepEqual(inspect(dir), { ok: true, reason: '', ignored: 0 });
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
    const red = inspect(dir, () => [], shell);
    assert.equal(red.ok, false);
    assert.match(red.reason, /TestAdd/u);
    assert.deepEqual(commands, ["go test './calc'"]);
    output = '';
    commitFile(dir, 'calc/calc.go', `${GO_ADD('+')}// fixed\n`);
    assert.deepEqual(
      inspect(dir, () => [], shell),
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

test('a crash in the Stop check refuses with exit 2, and a continued stop is let go', () => {
  const crash = () => {
    throw new Error('selector broke');
  };
  const first = stopHook('{}', {}, '', crash);
  assert.equal(first.code, 2);
  assert.match(
    first.stderr,
    /Stop refused: Stop check crashed: Error: selector broke/u,
  );
  assert.equal(stopHook('not json', {}, '', crash).code, 2);
  const again = stopHook('{"stop_hook_active":true}', {}, '', crash);
  assert.equal(again.code, 0);
  assert.match(again.stderr, /crashed/u);
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
    assert.equal(inspect(dir).ok, true);
    commitFile(
      dir,
      'packages/seo/page.js',
      'export const title = () => "b";\n',
    );
    const red = inspect(dir);
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
