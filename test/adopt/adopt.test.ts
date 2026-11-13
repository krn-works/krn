import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs the real `krn adopt` entry against a scratch git repository and
// checks the workflow against the inputs the shared workflow declares.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const shared = fileURLToPath(
  new URL('../../.github/workflows/project-ci.yml', import.meta.url),
);
const ref = 'a'.repeat(40);

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-adopt-'));
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

function adopt(root: string, ...extra: string[]) {
  return adoptArgs(root, '--ref', ref, ...extra);
}

function adoptArgs(root: string, ...extra: string[]) {
  return spawnSync(process.execPath, [cli, 'adopt', root, ...extra], {
    encoding: 'utf8',
  });
}

test('adopt writes the task directory, rules block, ignore entry and Check workflow call', () => {
  const root = scratch();
  const run = adopt(root, '--lint', 'npm run lint', '--test', 'npm test');
  assert.equal(run.status, 0, run.stderr);

  const tasks = readdirSync(join(root, 'tasks'));
  assert.equal(tasks.length, 1);
  assert.match(tasks[0] as string, /^t-[0-9a-z]+\.json$/u);

  const rules = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(rules, /krn-adoption:start/u);
  assert.match(rules, /ci \/ Check/u);
  assert.equal(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'AGENTS.md');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.krn\/$/mu);

  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(
    workflow,
    new RegExp(
      `^ {2}ci:\\n {4}uses: krn-works/krn/\\.github/workflows/project-ci\\.yml@${ref}$`,
      'mu',
    ),
  );
  // Every input the call passes is declared by the shared workflow.
  const declared = readFileSync(shared, 'utf8');
  for (const name of ['lint', 'test'])
    assert.match(declared, new RegExp(`^ {6}${name}:$`, 'mu'));
  assert.match(workflow, /^ {6}lint: "npm run lint"$/mu);
  assert.doesNotMatch(workflow, /typecheck:/u);
});

test('adopt rerun changes nothing and keeps existing instructions', () => {
  const root = scratch();
  spawnSync('sh', ['-c', `printf '# Mine\\n' > "${root}/AGENTS.md"`]);
  assert.equal(adopt(root).status, 0);
  const first = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(first, /^# Mine\n/u);
  const again = adopt(root);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^wrote /mu);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), first);
  assert.equal(readdirSync(join(root, 'tasks')).length, 1);
});

test('adopt refuses a path that is not a git repository and a ref that is not a sha', () => {
  const plain = mkdtempSync(join(tmpdir(), 'krn-adopt-plain-'));
  const notRepo = adopt(plain);
  assert.equal(notRepo.status, 64);
  assert.match(notRepo.stderr, /not a git repository/u);
  const badRef = spawnSync(
    process.execPath,
    [cli, 'adopt', scratch(), '--ref', 'main'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(badRef.status, 64);
  assert.match(badRef.stderr, /40-character/u);
});

function fixture(files: Record<string, string>): string {
  const root = scratch();
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function contractOf(root: string) {
  const run = spawnSync(
    process.execPath,
    [cli, 'repo', 'contract', '--root', root],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as {
    source: string;
    contract: { test: string; related?: string; tracker: string };
  };
}

// The receiver of the installed hook: the Stop entry `krn hook stop` as a lane session.
function stopAsLane(root: string) {
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, 'krn hook stop');
  return spawnSync(process.execPath, [cli, 'hook', 'stop'], {
    cwd: root,
    input: '{}',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      KRN_SESSION_CLASS: 'lane',
      KRN_LANE: 'x',
    },
  });
}

test('adopt on a pytest repository writes a contract that krn repo contract reads back and a Stop hook that runs', () => {
  const root = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  const run = adoptArgs(root);
  assert.equal(run.status, 0, run.stderr);
  const body = JSON.parse(readFileSync(join(root, 'krn.json'), 'utf8'));
  assert.equal(body.test, 'python -m pytest');
  assert.equal(body.tracker, 'none');
  const read = contractOf(root);
  assert.equal(read.source, 'krn.json');
  assert.equal(read.contract.test, 'python -m pytest');
  assert.equal(read.contract.related, 'python -m pytest {files}');
  // Without --ref: no CI workflow and no tasks/ seed.
  assert.equal(existsSync(join(root, '.github')), false);
  assert.equal(existsSync(join(root, 'tasks')), false);
  const stop = stopAsLane(root);
  assert.equal(stop.status, 2, stop.stderr);
  assert.match(stop.stderr, /Stop refused/u);
});

test('adopt on an npm repository detects its runner, seeds the tracker on request and keeps an edited krn.json', () => {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  });
  const run = adoptArgs(root, '--tracker');
  assert.equal(run.status, 0, run.stderr);
  const read = contractOf(root);
  assert.equal(read.contract.test, 'npm test');
  assert.equal(read.contract.related, 'npx vitest run {files}');
  assert.equal(read.contract.tracker, 'krn');
  assert.equal(readdirSync(join(root, 'tasks')).length, 1);
  assert.equal(stopAsLane(root).status, 2);

  writeFileSync(join(root, 'krn.json'), '{"test":"make check"}\n');
  const again = adoptArgs(root, '--tracker');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(contractOf(root).contract.test, 'make check');
  assert.doesNotMatch(again.stdout, /^wrote /mu);
});

test('adopt merges the Stop hook into existing settings and skips krn.json when no test command is known', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ env: { A: '1' }, hooks: { Stop: [{ hooks: [] }] } }),
  );
  const run = adoptArgs(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^skipped krn\.json/mu);
  assert.equal(existsSync(join(root, 'krn.json')), false);
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  );
  assert.equal(settings.env.A, '1');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(adoptArgs(root).stdout.includes('wrote '), false);
});
