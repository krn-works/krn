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
import { stopCommand } from '../../src/adopt/stop-hook.ts';
import { lanePacket } from '../../src/brain/worker-packet.ts';

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
  return spawnSync(
    process.execPath,
    [cli, 'adopt', root, '--no-canary', ...extra],
    {
      encoding: 'utf8',
    },
  );
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

  // The required check is the caller job `ci` around the shared `Check` job.
  assert.match(declared, /^ {2}check:\n {4}name: Check$/mu);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'spec/ci-admission.json'), 'utf8')),
    { schemaVersion: 1, checkRunName: 'ci / Check', appId: 15368 },
  );
});

test('adopt keeps an existing ci.yml and admission policy and calls the shared CI beside them', () => {
  const root = scratch();
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: CI\n');
  writeFileSync(join(root, 'spec/ci-admission.json'), '{"mine":1}\n');
  const run = adopt(root, '--test', 'npm test');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
    'name: CI\n',
  );
  assert.match(
    readFileSync(join(root, '.github/workflows/krn-ci.yml'), 'utf8'),
    /^ {2}ci:\n {4}uses: krn-works\/krn\//mu,
  );
  assert.equal(
    readFileSync(join(root, 'spec/ci-admission.json'), 'utf8'),
    '{"mine":1}\n',
  );
  assert.match(run.stdout + run.stderr, /spec\/ci-admission\.json/u);
  const again = adopt(root, '--test', 'npm test');
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^wrote /mu);
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
    contract: {
      install?: string;
      test: string;
      related?: string;
      tracker: string;
    };
  };
}

// The receiver of the installed hook: the Stop entry `krn hook stop` as a lane session.
function stopAsLane(root: string) {
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, stopCommand);
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
  // An installable project: its own venv, never the externally managed system interpreter.
  assert.equal(
    body.install,
    'python3 -m venv .venv && .venv/bin/python -m pip install -e . pytest',
  );
  assert.equal(body.test, '.venv/bin/python -m pytest');
  assert.equal(body.tracker, 'none');
  const read = contractOf(root);
  assert.equal(read.source, 'krn.json');
  assert.equal(read.contract.install, body.install);
  // The venv every worktree install creates stays out of git.
  assert.deepEqual(
    readFileSync(join(root, '.gitignore'), 'utf8').split('\n').filter(Boolean),
    ['.krn/', '.venv/'],
  );
  assert.equal(read.contract.test, '.venv/bin/python -m pytest');
  assert.equal(read.contract.related, '.venv/bin/python -m pytest {files}');
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

test('adopt seeds the conventions file from the instruction files and the packet reads it', () => {
  const root = scratch();
  spawnSync('sh', [
    '-c',
    `printf '# Mine\\n- Always run the linter before you commit a change to the parser.\\n' > "${root}/AGENTS.md"`,
  ]);
  assert.equal(adopt(root).status, 0);
  const seeded = JSON.parse(
    readFileSync(join(root, '.krn/conventions.json'), 'utf8'),
  ) as { text: string; source: string }[];
  assert.ok(seeded.some((record) => /linter/u.test(record.text)));
  const packet = lanePacket(
    root,
    'commit a change to the parser after the linter passes, with a Ticket trailer',
    new Date().toISOString().slice(0, 10),
    'fixture',
  );
  assert.ok(packet !== null && packet.records.length > 0);
  // A rerun keeps hand edits to the seeded file.
  const edited = '[]\n';
  writeFileSync(join(root, '.krn/conventions.json'), edited);
  assert.equal(adopt(root).status, 0);
  assert.equal(
    readFileSync(join(root, '.krn/conventions.json'), 'utf8'),
    edited,
  );
});

function packageAt(root: string, dir: string, scripts: object) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(root, dir, 'package-lock.json'), '{}');
}

test('adopt detects the commands of the only package below a manifest-less root and names its workflow apart from an existing CI', () => {
  const root = scratch();
  packageAt(root, 'packages/seo', {
    test: 'node --test',
    lint: 'biome check',
    typecheck: 'tsc',
    verify: 'x',
  });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: CI\n');
  const run = adopt(root);
  assert.equal(run.status, 0, run.stderr);
  const contract = JSON.parse(readFileSync(join(root, 'krn.json'), 'utf8'));
  assert.equal(contract.test, 'npm --prefix packages/seo test');
  const workflow = readFileSync(
    join(root, '.github/workflows/krn-ci.yml'),
    'utf8',
  );
  assert.match(workflow, /^name: KRN CI$/mu);
  assert.match(workflow, /install: "npm --prefix packages\/seo ci"/u);
  assert.match(workflow, /lint: "npm --prefix packages\/seo run lint"/u);
  assert.match(
    workflow,
    /typecheck: "npm --prefix packages\/seo run typecheck"/u,
  );
  assert.match(workflow, /test: "npm --prefix packages\/seo test"/u);
});

test('adopt skips krn.json naming every package when two hold a test command', () => {
  const root = scratch();
  packageAt(root, 'packages/a', { test: 'node --test' });
  packageAt(root, 'web', { test: 'vitest run' });
  const run = adopt(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^skipped krn\.json .*packages\/a, web/mu);
  assert.equal(existsSync(join(root, 'krn.json')), false);
});

// The receiver is the shell Claude Code runs the hook command in: exit 2 is the only blocking exit.
test('the installed Stop command blocks with exit 2 and names krn when krn is not on PATH', () => {
  const bin = mkdtempSync(join(tmpdir(), 'krn-stop-path-'));
  const sh = spawnSync('/bin/sh', ['-c', stopCommand], {
    input: '{}',
    encoding: 'utf8',
    env: { PATH: bin },
  });
  assert.equal(sh.error, undefined);
  assert.equal(sh.status, 2);
  assert.match(sh.stderr, /krn is not on PATH/u);

  writeFileSync(join(bin, 'krn'), '#!/bin/sh\necho "ran $*"\nexit 0\n', {
    mode: 0o755,
  });
  const found = spawnSync('/bin/sh', ['-c', stopCommand], {
    input: '{}',
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, 'ran hook stop\n');
});

test('adopt replaces an earlier bare krn hook stop entry and keeps other Stop hooks', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'krn hook stop' }] },
          { hooks: [{ type: 'command', command: 'own-check' }] },
        ],
      },
    }),
  );
  const run = adopt(root, '--no-canary');
  assert.equal(run.status, 0, run.stderr);
  const settings = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  assert.deepEqual(
    settings.hooks.Stop.map((entry) => entry.hooks[0]?.command),
    [stopCommand, 'own-check'],
  );
});

// The receiver is the shared workflow's plan step: it refuses a call with no lint, typecheck or test.
test('adopt --ref passes the detected test command to CI and pushes on the contract base', () => {
  const root = fixture({ 'go.mod': 'module example.com/x\n\ngo 1.22\n' });
  git(root, 'branch', '-m', 'develop');
  const run = adopt(root, '--no-canary');
  assert.equal(run.status, 0, run.stderr);
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /^ {6}test: "go test \.\/\.\.\."$/mu);
  assert.match(workflow, /^ {4}branches: \[develop\]$/mu);
  assert.match(
    readFileSync(shared, 'utf8'),
    /set at least one of lint, typecheck or test/u,
  );
});

test('adopt --ref writes no CI call it cannot fill and says why', () => {
  const root = fixture({ 'README.md': 'x\n' });
  const run = adopt(root, '--no-canary');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(root, '.github/workflows/ci.yml')), false);
  assert.match(
    run.stdout,
    /\.github\/workflows\/ci\.yml \(no lint, typecheck or test command; pass --test CMD\)/u,
  );
});

function tree(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((name) => !name.startsWith('.git/') && name !== '.git')
    .sort();
}

test('adopt leaves the tree unchanged when settings.json is not plain JSON', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'));
  const commented = '{\n  // my hooks\n  "model": "opus"\n}\n';
  writeFileSync(join(root, '.claude/settings.json'), commented);
  const before = tree(root);
  const run = adopt(root, '--tracker', '--test', 'npm test');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /\.claude\/settings\.json/u);
  assert.match(run.stderr, /nothing was written/u);
  assert.deepEqual(tree(root), before);
  assert.equal(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    commented,
  );
});

test('adopt puts the rules block into a regular CLAUDE.md and keeps its text', () => {
  const root = scratch();
  writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n\nKeep this.\n');
  const run = adoptArgs(root, '--test', 'npm test');
  assert.equal(run.status, 0, run.stderr);
  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink(), false);
  assert.match(claude, /^# Mine\n\nKeep this\.\n/u);
  assert.match(claude, /krn-adoption:start/u);
  const rerun = adoptArgs(root, '--test', 'npm test');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), claude);
});

test('adopt ends with the commit, merge, PATH and install steps', () => {
  const root = scratch();
  const run = adoptArgs(root, '--test', 'npm test');
  assert.equal(run.status, 0, run.stderr);
  const last = run.stdout.trimEnd().split('\n').slice(-5);
  assert.match(last[0] as string, /^next steps:/u);
  assert.match(last[1] as string, /commit/u);
  assert.match(last[2] as string, /merge/u);
  assert.match(last[3] as string, /PATH/u);
  assert.match(last[4] as string, /install/u);
});
