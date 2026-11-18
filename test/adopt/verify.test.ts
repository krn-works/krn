import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isRepositoryNotFound,
  repoSlug,
  verifyGaps,
  worktreeDependencies,
} from '../../src/adopt/verify.ts';

// KRN-12: verbatim `gh api` captures; the CLI test puts a gh that replays them first on PATH.
const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    'utf8',
  );
const repo = fixture('gh/repo-krn-works-krn.stdout.json');
const protectedBranch = fixture('ci-admission/branch-protected.json');
const unpinned = fixture('ci-admission/branch-unpinned.json');
// The live krn-works/krn answers: Check is required by a ruleset, so classic protection is empty.
const rulesetOnly = fixture('gh/rules-branches-main-krn-works-krn.stdout.json');
const noAutoMerge = repo.replace(
  '"allow_auto_merge":true',
  '"allow_auto_merge":false',
);
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

test('a repository with the required check and auto-merge has no gap', () => {
  assert.deepEqual(verifyGaps(repo, protectedBranch), []);
});

test('a missing required check and disabled auto-merge are each named', () => {
  assert.notEqual(noAutoMerge, repo);
  assert.deepEqual(verifyGaps(repo, unpinned), [
    'branch main has no single required status check from GitHub Actions',
  ]);
  assert.deepEqual(verifyGaps(noAutoMerge, protectedBranch), [
    'auto-merge is not allowed (repository setting allow_auto_merge)',
  ]);
});

test('a check required by a ruleset counts, as on krn-works/krn', () => {
  assert.deepEqual(verifyGaps(repo, unpinned, rulesetOnly), []);
});

function verify(
  repoBody: string,
  branchBody: string,
  rulesBody = '[]',
  prepare: (root: string) => void = () => {},
  origin: string | null = 'https://github.com/krn-works/krn.git',
  edit: (root: string) => void = () => {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-verify-'));
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin !== null)
    spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  prepare(dir);
  // An adopted repository: the adoption files match, so only settings and deploys can be gaps.
  const adopted = spawnSync(
    process.execPath,
    [cli, 'adopt', dir, '--no-canary', '--test', 'true'],
    { encoding: 'utf8' },
  );
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  edit(dir);
  writeFileSync(join(dir, 'repo.json'), repoBody);
  writeFileSync(join(dir, 'branch.json'), branchBody);
  writeFileSync(join(dir, 'rules.json'), rulesBody);
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\ncase "$2" in */rules/branches/*) cat "${dir}/rules.json";; */branches/*) cat "${dir}/branch.json";; *) cat "${dir}/repo.json";; esac\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  return spawnSync(process.execPath, [cli, 'adopt', dir, '--verify'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });
}

test('adopt --verify exits 0 when set and 1 naming the gap otherwise', () => {
  const ok = verify(repo, protectedBranch);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = verify(noAutoMerge, unpinned);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /verify gap: auto-merge is not allowed/u);
  assert.match(bad.stdout, /verify gap: branch main has no single required/u);
  const ruleset = verify(repo, unpinned, rulesetOnly);
  assert.equal(ruleset.status, 0, ruleset.stdout);
});

test('adopt --verify counts contract gate commands two workflows run as duplicate-ci', () => {
  const ok = verify(repo, protectedBranch);
  assert.match(ok.stdout, /^duplicate-ci: 0$/mu);
  const twice = verify(repo, protectedBranch, '[]', (root) => {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const name of ['ci.yml', 'tests.yml'])
      writeFileSync(
        join(root, '.github/workflows', name),
        'on:\n  pull_request:\n  cancel-in-progress: true\njobs:\n  test:\n    steps:\n      - run: true\n',
      );
  });
  assert.equal(twice.status, 1, twice.stderr);
  assert.match(twice.stdout, /^duplicate-ci: 1$/mu);
  assert.match(
    twice.stdout,
    /^verify gap: duplicate-ci test `true` runs in \.github\/workflows\/ci\.yml, \.github\/workflows\/tests\.yml; keep one runner$/mu,
  );
});

test('adopt --verify names an unreadable project record file as drift and still prints every other verdict', () => {
  const stale = verify(
    repo,
    protectedBranch,
    '[]',
    undefined,
    undefined,
    (root) =>
      writeFileSync(
        join(root, '.agents/standards.json'),
        '{"records":[{"id":"s-old","type":"rule"}]}\n',
      ),
  );
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(
    stale.stdout,
    /^verify drift: adoption files cannot be compared: \.agents\/standards\.json: /mu,
  );
  assert.match(stale.stdout, /^duplicate-ci: 0$/mu);
});

const withWorkflow = (name: string, contract?: string) => (root: string) => {
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL(`../fixtures/workflows/${name}`, import.meta.url)),
    join(root, '.github/workflows', name),
  );
  if (contract) writeFileSync(join(root, 'krn.json'), contract);
};

test('adopt --verify names a deploying base-branch workflow until krn.json acknowledges it', () => {
  const bad = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow('deploy-on-push.yml'),
  );
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(
    bad.stdout,
    /verify gap: \.github\/workflows\/deploy-on-push\.yml deploys on a push to main/u,
  );
  assert.match(bad.stdout, /"deploy": "acknowledged"/u);
  const ok = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow(
      'deploy-on-push.yml',
      '{"test":"true","deploy":"acknowledged"}',
    ),
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const plain = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow('test-only.yml'),
  );
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
});

// A repository whose origin is not on GitHub: verify cannot read the required gate, so it refuses with a named gap, never a gh failure and never a silent pass.
for (const origin of [
  'git@gitlab.com:team/app.git',
  'https://git.example.org/team/app.git',
  '../elsewhere/bare.git',
]) {
  test(`adopt --verify with non-GitHub origin ${origin} refuses with a named no-GitHub-host gap`, () => {
    const run = verify(repo, unpinned, '[]', () => {}, origin);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /^verify gap: no GitHub host \(origin /mu);
    assert.doesNotMatch(run.stdout, /verify ok: required check/u);
    assert.doesNotMatch(run.stdout + run.stderr, /placehol/u);
  });
}

// No origin is a fresh local project: it exits 0 and says the required gate was not checked.
test('adopt --verify with no origin exits 0 and says the required gate was not checked', () => {
  const run = verify(repo, unpinned, '[]', () => {}, null);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^verify skipped: no origin: the required gate .* not checked/mu,
  );
  assert.doesNotMatch(run.stdout + run.stderr, /placehol|verify gap/u);
});

test('adopt --verify on a non-GitHub origin still names an unacknowledged deploy workflow', () => {
  const run = verify(
    repo,
    protectedBranch,
    '[]',
    withWorkflow('deploy-on-push.yml'),
    'git@gitlab.com:team/app.git',
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /verify gap: no GitHub host/u);
  assert.match(run.stdout, /verify gap: \.github\/workflows\/deploy-on-push/u);
});

test('adopt --verify refuses a lane base that is not the default branch', () => {
  const run = verify(repo, protectedBranch, '[]', (root) =>
    writeFileSync(join(root, 'krn.json'), '{"base":"develop"}\n'),
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /verify gap: lane base develop is not the default branch main/u,
  );
});

test('adopt --verify names an edited hook file and a deleted standards record and exits 1; an untouched adoption is clean', () => {
  const run = verify(repo, protectedBranch, '[]', () => {});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /verify ok: adoption files match/u);
  const drifted = verify(
    repo,
    protectedBranch,
    '[]',
    () => {},
    'https://github.com/krn-works/krn.git',
    (dir) => {
      writeFileSync(join(dir, '.claude/settings.json'), '{}\n');
      unlinkSync(join(dir, '.agents/standards.json'));
    },
  );
  assert.equal(drifted.status, 1, drifted.stdout);
  assert.match(
    drifted.stdout,
    /verify drift: \.claude\/settings\.json differs/u,
  );
  assert.match(
    drifted.stdout,
    /verify drift: \.agents\/standards\.json is missing/u,
  );
});

test('adopt --verify prints the first-turn token estimate and the settings that cut it', () => {
  const run = verify(
    repo,
    protectedBranch,
    '[]',
    (dir) => writeFileSync(join(dir, 'CLAUDE.md'), 'rule\n'.repeat(3000)),
    'https://github.com/krn-works/krn.git',
    (dir) => {
      mkdirSync(join(dir, '.claude/skills/big'), { recursive: true });
      writeFileSync(
        join(dir, '.claude/skills/big/SKILL.md'),
        `---\nname: big\ndescription: ${'word '.repeat(400)}\n---\nbody\n`,
      );
      writeFileSync(
        join(dir, '.mcp.json'),
        '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}\n',
      );
    },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /verify context: first turn ~\d+ tokens .*\d instruction file\(s\), \d+ skill\(s\), 2 MCP server\(s\)/u,
  );
  assert.match(run.stdout, /verify context setting: .*enabledMcpjsonServers/u);
  assert.match(
    run.stdout,
    /verify context setting: .*disable-model-invocation/u,
  );
  assert.match(
    run.stdout,
    /verify context setting: CLAUDE\.md is ~\d+ tokens/u,
  );
  const total = Number(/first turn ~(\d+) tokens/u.exec(run.stdout)?.[1]);
  assert.ok(
    total > 3000 + 2 * 1500,
    `estimate ${total} counts all three parts`,
  );
});

// A repository the GitHub App cannot see: gh answers 404, replayed from a verbatim capture of the real receiver.
const notInstalledStderr = readFileSync(
  new URL('../fixtures/gh/repo-not-installed.stderr.log', import.meta.url),
  'utf8',
);

test('adopt --verify names the GitHub App not installed with the install URL and exits 67', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-verify-404-'));
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  spawnSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:acme/private-app.git'],
    { cwd: dir },
  );
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\ncat >&2 <<'EOF'\n${notInstalledStderr}EOF\nexit 1\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const run = spawnSync(process.execPath, [cli, 'adopt', dir, '--verify'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });
  assert.equal(run.status, 67, run.stdout + run.stderr);
  assert.match(
    run.stderr,
    /GitHub App not installed on acme\/private-app: install at https:\/\/github\.com\/apps\/krn-works-delivery\/installations\/new/u,
  );
  assert.doesNotMatch(run.stderr, /failed: Not Found/u);
});

test('repoSlug reads owner and repo from https, ssh and scp origins', () => {
  assert.equal(repoSlug('https://github.com/a/b.git'), 'a/b');
  assert.equal(repoSlug('git@github.com:a/b.git'), 'a/b');
  assert.equal(repoSlug('ssh://git@github.com/a/b'), 'a/b');
  assert.equal(repoSlug('../elsewhere/bare.git'), undefined);
});

test('only an HTTP 404 reply is a repository not found', () => {
  assert.equal(isRepositoryNotFound(1, notInstalledStderr), true);
  assert.equal(isRepositoryNotFound(0, ''), false);
  assert.equal(isRepositoryNotFound(1, 'gh: Forbidden (HTTP 403)'), false);
});

test('adopt --verify runs the canary exactly once and krn adopt no longer takes --canary', () => {
  const run = verify(repo, protectedBranch);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout.match(/^canary /gmu)?.length, 1, run.stdout);
  const gone = spawnSync(process.execPath, [cli, 'adopt', '.', '--canary'], {
    encoding: 'utf8',
  });
  assert.equal(gone.status, 64);
  assert.match(gone.stderr, /unknown flag --canary/u);
});

/** A real git checkout with a package.json, its own node_modules, and a nested lane worktree. */
function dependencyTrees(ignore: string) {
  const root = mkdtempSync(join(tmpdir(), 'krn-deps-'));
  const git = (cwd: string, ...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status,
      0,
    );
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, '.gitignore'), ignore);
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'seed',
  );
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  const tree = join(root, '.krn', 'worktrees', 'lane');
  git(root, 'worktree', 'add', '-q', tree);
  return { root, tree };
}

test('worktreeDependencies links an ignored node_modules and skips the install', () => {
  const { root, tree } = dependencyTrees('.krn\nnode_modules\n');
  const ran: string[] = [];
  const run = (command: string) => {
    ran.push(command);
    return { status: 0 };
  };
  try {
    assert.equal(
      worktreeDependencies(root, tree, 'npm ci', run, true),
      undefined,
    );
    assert.ok(lstatSync(join(tree, 'node_modules')).isSymbolicLink());
    // A rerun finds the link: no install through it into the main checkout.
    assert.equal(
      worktreeDependencies(root, tree, 'npm ci', run, true),
      undefined,
    );
    assert.deepEqual(ran, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktreeDependencies removes a link git would not ignore; the nested tree resolves upward', () => {
  // `node_modules/` matches a directory, not a symlink.
  const { root, tree } = dependencyTrees('.krn\nnode_modules/\n');
  const ran: string[] = [];
  try {
    assert.equal(
      worktreeDependencies(
        root,
        tree,
        'npm ci',
        (command) => {
          ran.push(command);
          return { status: 0 };
        },
        true,
      ),
      undefined,
    );
    assert.equal(existsSync(join(tree, 'node_modules')), false);
    assert.equal(
      spawnSync('git', ['-C', tree, 'status', '--porcelain'], {
        encoding: 'utf8',
      }).stdout,
      '',
    );
    assert.deepEqual(ran, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktreeDependencies runs the install when nothing links, and names a failed one', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-deps-'));
  const tree = mkdtempSync(join(tmpdir(), 'krn-deps-tree-'));
  try {
    const ran: string[] = [];
    assert.equal(
      worktreeDependencies(root, tree, 'python3 -m venv .venv', (command) => {
        ran.push(command);
        return { status: 0 };
      }),
      undefined,
    );
    assert.deepEqual(ran, ['python3 -m venv .venv']);
    assert.equal(
      worktreeDependencies(root, tree, 'pip install x', () => ({
        status: 1,
        stderr: 'ERROR: No matching distribution found for x\n',
      })),
      'the install command failed (pip install x, exit 1: ERROR: No matching distribution found for x)',
    );
    assert.equal(
      worktreeDependencies(root, tree, undefined, () => {
        throw new Error('no install named');
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});
