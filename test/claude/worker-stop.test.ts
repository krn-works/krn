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
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeStop } from '../../src/hook/stop.ts';

// KRN-12: the refusal text is read from the real hook; adopt runs the real CLI.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function sh(cwd: string, ...args: string[]) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-cmd-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  return dir;
}

const payload = (cwd: string) => ({ cwd, last_assistant_message: 'done' });
const lane = (dir: string) => ({
  CLAUDE_PROJECT_DIR: dir,
  KRN_SESSION_CLASS: 'lane',
  KRN_LANE: 'x',
});

test('the no-commit refusal quotes the contract test command', () => {
  const dir = repo({
    'krn.json': JSON.stringify({ test: 'make check-all', tracker: 'none' }),
  });
  try {
    const reason = judgeStop(payload(dir), lane(dir), () => []) ?? '';
    assert.match(reason, /run `make check-all` first/u);
    assert.doesNotMatch(reason, /run `the tests`/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the no-commit refusal names node --test when no contract names a command', () => {
  const dir = repo({ 'README.md': 'x\n' });
  try {
    const reason = judgeStop(payload(dir), lane(dir), () => []) ?? '';
    assert.match(reason, /run `node --test` first/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function adopted(files: Record<string, string>): string {
  const dir = repo(files);
  const run = spawnSync(
    process.execPath,
    [cli, 'adopt', dir, '--no-canary', '--test', files['_test'] ?? ''],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return readFileSync(join(dir, '.gitignore'), 'utf8');
}

test('adopt ignores Cargo target and Python bytecode litter', () => {
  const rust = adopted({
    'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n',
    _test: 'cargo test',
  });
  assert.match(rust, /^target\/$/mu);
  const py = adopted({
    'pyproject.toml': '[project]\nname = "x"\n',
    _test: 'python -m pytest',
  });
  assert.match(py, /^__pycache__\/$/mu);
  assert.doesNotMatch(py, /^target\/$/mu);
});
