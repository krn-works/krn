import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { git, redFirst } from '../../src/flow/repository.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import type { execute } from '../../src/verdict/sandbox.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const addedTestPath = 'test/repository-metadata-added.test.mjs';
const unchangedTestPath = 'test/repository-metadata-unchanged.test.mjs';
const redGreenTestPath = 'test/repository-metadata-red-green.test.mjs';

function metadataTestSource(sentinelPath?: string): string {
  return `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('candidate Git metadata is usable and private', () => {
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  assert.match(git('rev-parse', '--verify', 'HEAD'), /^[a-f0-9]{40}$/u);
  git('status', '--porcelain');
  git('config', '--local', 'krn.repositoryMetadataProbe', 'candidate');
  assert.equal(git('config', '--local', '--get', 'krn.repositoryMetadataProbe'), 'candidate');
  ${sentinelPath ? `assert.throws(() => readFileSync(${JSON.stringify(sentinelPath)}, 'utf8'), { code: 'ENOENT' });` : ''}
});
`;
}

function redGreenTestSource(sentinelPath?: string): string {
  return `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { value } from '../src/value.mjs';
test('the red-green assertion runs with candidate Git metadata', () => {
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  assert.match(git('rev-parse', '--verify', 'HEAD'), /^[a-f0-9]{40}$/u);
  git('status', '--porcelain');
  git('config', '--local', 'krn.repositoryMetadataProbe', 'candidate');
  assert.equal(git('config', '--local', '--get', 'krn.repositoryMetadataProbe'), 'candidate');
  ${sentinelPath ? `assert.throws(() => readFileSync(${JSON.stringify(sentinelPath)}, 'utf8'), { code: 'ENOENT' });` : ''}
  assert.equal(value, 2);
});
`;
}

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-repository-metadata-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Review test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  git(root, ['config', 'krn.reviewSourceMetadata', 'source-only']);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message = 'fixture') => {
    git(root, ['add', '--all']);
    git(root, ['commit', '--allow-empty', '-qm', message]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  put('.gitignore', '.krn/\n');
  put('package.json', '{"type":"module"}\n');
  return { root, put, commit };
}

function makeForeignWorktree(root: string, sha: string): string {
  const foreign = join(root, '.krn', 'foreign-worktree');
  mkdirSync(dirname(foreign), { recursive: true });
  git(root, ['worktree', 'add', '--detach', foreign, sha]);
  return foreign;
}

function worktreeState(root: string): string {
  return git(root, ['worktree', 'list', '--porcelain']);
}

function executeGit(copy: string, args: string[]) {
  return spawnSync('git', ['-C', copy, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

const metadataObserver: typeof execute = async (
  root,
  copy,
  job,
  id,
  argv,
  _timeout,
  sha,
) => {
  const failures: string[] = [];
  const sourceConfig = join(root, '.git', 'config');
  const sourceConfigBefore = readFileSync(sourceConfig);
  const sourceConfigLeak = executeGit(copy, [
    'config',
    '--local',
    '--get',
    'krn.reviewSourceMetadata',
  ]);
  if (sourceConfigLeak.status === 0)
    failures.push('candidate inherited source-local Git config');
  const configKey = `krn.repositoryMetadataObserver${randomUUID().replaceAll('-', '')}`;
  const configWrite = executeGit(copy, ['config', '--local', configKey, sha]);
  if (configWrite.status !== 0)
    failures.push(
      `candidate local config write failed: ${configWrite.stderr.trim()}`,
    );
  if (!readFileSync(sourceConfig).equals(sourceConfigBefore)) {
    failures.push('candidate local config mutation changed source Git config');
    writeFileSync(sourceConfig, sourceConfigBefore);
  }

  const overlay = readFileSync(join(copy, addedTestPath), 'utf8');
  if (overlay !== metadataTestSource())
    failures.push('candidate test overlay does not match the head test blob');

  const sourceGit = join(root, '.git');
  const hiddenGit = `${root}.git-hidden-${randomUUID()}`;
  let movedGit = false;
  let childOutput = '';
  let childStatus = 1;
  try {
    renameSync(sourceGit, hiddenGit);
    movedGit = true;
    const head = executeGit(copy, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0 || head.stdout.trim() !== sha)
      failures.push(
        `candidate exact HEAD unavailable with source metadata hidden: ${head.stderr.trim()}`,
      );
    const status = executeGit(copy, ['status', '--porcelain']);
    if (status.status !== 0)
      failures.push(
        `candidate status unavailable with source metadata hidden: ${status.stderr.trim()}`,
      );
    const localConfig = executeGit(copy, [
      'config',
      '--local',
      '--get',
      configKey,
    ]);
    if (localConfig.status !== 0 || localConfig.stdout.trim() !== sha)
      failures.push(
        `candidate local config unavailable with source metadata hidden: ${localConfig.stderr.trim()}`,
      );

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.KRN_ISOLATION_GATE_PRELOAD;
    delete env.KRN_ISOLATION_CAPABILITIES;
    delete env.CI;
    const child = spawnSync(argv[0] ?? process.execPath, argv.slice(1), {
      cwd: copy,
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    childOutput = (child.stdout ?? '') + (child.stderr ?? '');
    childStatus =
      child.error && 'code' in child.error && child.error.code === 'ETIMEDOUT'
        ? 124
        : (child.status ?? 1);
    if (childStatus !== 0)
      failures.push(
        `candidate test could not use private Git metadata: ${childOutput.slice(-1000)}`,
      );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (movedGit) renameSync(hiddenGit, sourceGit);
  }

  const currentConfig = readFileSync(sourceConfig);
  if (!currentConfig.equals(sourceConfigBefore)) {
    failures.push('candidate execution changed source Git config');
    writeFileSync(sourceConfig, sourceConfigBefore);
  }

  if (failures.length)
    throw new Error(`${failures.join('; ')}\n${childOutput.slice(-1000)}`);
  const output = childOutput;
  const diagnostics = join(stateDirectory(job), 'diagnostics');
  mkdirSync(diagnostics, { recursive: true });
  writeFileSync(
    join(diagnostics, `${sha}-${id}-capture.txt`),
    Buffer.from(output).subarray(-2048),
  );
  return {
    id,
    exitCode: childStatus,
    durationMs: 0,
    sha256: createHash('sha256').update(output).digest('hex'),
  };
};

const failedExecution: typeof execute = async () => {
  throw new Error('synthetic transport failure');
};

test('candidate Git metadata stays usable and private when source metadata is absent', async (context) => {
  const f = fixture(context);
  f.put('src/value.mjs', 'export const value = 2;\n');
  const base = f.commit();
  const foreign = makeForeignWorktree(f.root, base);
  f.put(addedTestPath, metadataTestSource());
  const head = f.commit('add a test that uses candidate Git metadata');
  const worktreesBefore = worktreeState(f.root);
  const sourceConfig = readFileSync(join(f.root, '.git', 'config'));
  const tmp = join(f.root, '.krn', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const temporaryEntries = readdirSync(tmp).sort();

  const report = await redFirst(
    f.root,
    base,
    head,
    undefined,
    metadataObserver,
  );

  assert.deepEqual(
    report.results.map(({ side, sha, classification }) => ({
      side,
      sha,
      classification,
    })),
    [
      { side: 'base', sha: base, classification: 'pass' },
      { side: 'head', sha: head, classification: 'pass' },
    ],
    JSON.stringify(report),
  );
  assert.deepEqual(readdirSync(tmp).sort(), temporaryEntries);
  assert.equal(
    readFileSync(join(f.root, '.git', 'config')).equals(sourceConfig),
    true,
  );
  assert.equal(worktreeState(f.root), worktreesBefore);
  assert.equal(worktreeState(f.root).includes(foreign), true);
});

test('candidate Git history includes an exact commit without a source ref', async (context) => {
  const f = fixture(context);
  f.put('src/value.mjs', 'export const value = 2;\n');
  const base = f.commit();
  f.put(addedTestPath, metadataTestSource());
  const head = f.commit('add a test on an unreferenced commit');
  git(f.root, ['reset', '--hard', base]);

  const report = await redFirst(
    f.root,
    base,
    head,
    undefined,
    metadataObserver,
  );

  assert.deepEqual(
    report.results.map(({ side, sha, classification }) => ({
      side,
      sha,
      classification,
    })),
    [
      { side: 'base', sha: base, classification: 'pass' },
      { side: 'head', sha: head, classification: 'pass' },
    ],
    JSON.stringify(report),
  );
});

test('candidate Git metadata cleanup follows successful and failed executions', async (context) => {
  const f = fixture(context);
  f.put(addedTestPath, metadataTestSource());
  const base = f.commit('add a test for cleanup');
  const foreign = makeForeignWorktree(f.root, base);
  f.put(addedTestPath, `${metadataTestSource()}// changed test content\n`);
  const head = f.commit('change the test for failed execution cleanup');
  const worktreesBefore = worktreeState(f.root);
  const tmp = join(f.root, '.krn', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const temporaryEntries = readdirSync(tmp).sort();

  const failingReview = await redFirst(
    f.root,
    base,
    head,
    undefined,
    failedExecution,
  );
  assert.deepEqual(
    failingReview.results.map(({ classification }) => classification),
    ['procedural', 'procedural'],
  );
  assert.deepEqual(readdirSync(tmp).sort(), temporaryEntries);
  assert.equal(worktreeState(f.root), worktreesBefore);
  assert.equal(worktreeState(f.root).includes(foreign), true);
});

test('isolated review candidates retain exact Git history and test overlays', async (context) => {
  if (!requiresIsolation(context, context.name, ['bwrap', 'systemdUserScope']))
    return;

  const f = fixture(context);
  const sentinelRelativePath = 'host-only-sentinel.txt';
  const sentinelPath = join(f.root, sentinelRelativePath);
  f.put('src/value.mjs', 'export const value = 1;\n');
  f.put(unchangedTestPath, metadataTestSource(sentinelPath));
  f.put(
    'test/repository-metadata-red-green.test.mjs',
    redGreenTestSource(sentinelPath),
  );
  const base = f.commit('baseline repository metadata checks');

  f.put(
    unchangedTestPath,
    `${metadataTestSource(sentinelPath)}// no behavior change\n`,
  );
  f.put('src/value.mjs', 'export const value = 2;\n');
  f.put(addedTestPath, metadataTestSource(sentinelPath));
  const head = f.commit(
    `fix the red-green assertion\n\nChange-contract: ${redGreenTestPath}:red->green`,
  );
  f.put(sentinelRelativePath, 'not mounted into the review sandbox\n');
  const worktreesBefore = worktreeState(f.root);
  const sourceFiles = [
    '.git/config',
    'package.json',
    'src/value.mjs',
    unchangedTestPath,
    redGreenTestPath,
    addedTestPath,
    sentinelRelativePath,
  ];
  const sourceBefore = new Map(
    sourceFiles.map((path) => [path, readFileSync(join(f.root, path))]),
  );
  const tmp = join(f.root, '.krn', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const temporaryEntries = readdirSync(tmp).sort();

  const report = await redFirst(f.root, base, head);

  const resultsFor = (path: string) =>
    report.results
      .filter((result) => result.path === path)
      .map(({ side, sha, classification }) => ({ side, sha, classification }));
  assert.deepEqual(resultsFor(unchangedTestPath), [
    { side: 'base', sha: base, classification: 'pass' },
    { side: 'head', sha: head, classification: 'pass' },
  ]);
  assert.deepEqual(resultsFor(addedTestPath), [
    { side: 'base', sha: base, classification: 'pass' },
    { side: 'head', sha: head, classification: 'pass' },
  ]);
  assert.deepEqual(
    report.contracts?.map(({ path, red, green, proven }) => ({
      path,
      red: red && {
        path: red.path,
        side: red.side,
        sha: red.sha,
        classification: red.classification,
      },
      green: {
        path: green.path,
        side: green.side,
        sha: green.sha,
        classification: green.classification,
      },
      proven,
    })),
    [
      {
        path: redGreenTestPath,
        red: {
          path: redGreenTestPath,
          side: 'base',
          sha: base,
          classification: 'assertion',
        },
        green: {
          path: redGreenTestPath,
          side: 'head',
          sha: head,
          classification: 'pass',
        },
        proven: true,
      },
    ],
    JSON.stringify(report),
  );
  for (const [path, bytes] of sourceBefore)
    assert.equal(readFileSync(join(f.root, path)).equals(bytes), true, path);
  assert.equal(worktreeState(f.root), worktreesBefore);
  assert.deepEqual(readdirSync(tmp).sort(), temporaryEntries);
});
