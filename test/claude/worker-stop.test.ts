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
  inspect,
  judgeStop,
  relatedTests,
  statesBlocker,
} from '../../scripts/claude/worker-stop.ts';

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
  const { WORKER_RULES } = await import('../../src/cli/lane.ts');
  assert.match(WORKER_RULES, /scripts\/claude\/worker-stop\.ts --check/u);
  assert.match(WORKER_RULES, /BLOCKER:/u);
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

test('relatedTests keeps an unrelated source change to importers plus the test/rules guards', () => {
  const tests = realTests();
  const picked = relatedTests(['scripts/claude/worker-stop.ts'], tests);
  const guards = [...tests.keys()].filter((p) => p.startsWith('test/rules/'));
  assert.ok(guards.length > 0);
  for (const guard of guards) assert.ok(picked.includes(guard), guard);
  assert.ok(picked.includes('test/claude/worker-stop.test.ts'));
  assert.ok(
    picked.every(
      (p) =>
        p.startsWith('test/rules/') || tests.get(p)?.includes('worker-stop'),
    ),
  );
  assert.deepEqual(relatedTests([], tests), []);
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
