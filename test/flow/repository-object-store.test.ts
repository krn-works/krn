import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
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
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import type { Job } from '../../src/core/index.ts';
import { redFirst } from '../../src/flow/repository.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import {
  type execute,
  TeardownUnconfirmed,
} from '../../src/verdict/sandbox.ts';

const fixtureTestPath = 'test/fixture.test.mjs';
const baseTest = "import { test } from 'node:test'; test('base', () => {});\n";
const headTest = "import { test } from 'node:test'; test('head', () => {});\n";

function runGit(root: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = runGit(root, args, env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(context: TestContext) {
  const temporary = mkdtempSync(join(tmpdir(), 'krn-repository-object-store-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source');
  mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Object store test']);
  git(root, ['config', 'user.email', 'object-store@example.invalid']);
  git(root, ['config', 'krn.sourceOnly', 'private']);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message: string) => {
    git(root, ['add', '--all']);
    git(root, ['commit', '-qm', message]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  put('.gitignore', '.krn/\n');
  put('package.json', '{"type":"module"}\n');
  put(fixtureTestPath, baseTest);
  const base = commit('base test');
  put(fixtureTestPath, headTest);
  const referencedHead = commit('head test');
  const borrowed = join(temporary, 'borrowed.git');
  git(root, ['clone', '--quiet', '--bare', root, borrowed]);
  renameSync(
    join(root, '.git', 'objects'),
    join(root, '.git', 'objects-owned'),
  );
  mkdirSync(join(root, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(
    join(root, '.git', 'objects', 'info', 'alternates'),
    `${join(borrowed, 'objects')}\n`,
  );
  const tree = git(root, ['rev-parse', `${referencedHead}^{tree}`]);
  const dangling = git(
    root,
    [
      '-c',
      'user.name=Object store test',
      '-c',
      'user.email=object-store@example.invalid',
      'commit-tree',
      tree,
      '-p',
      referencedHead,
      '-m',
      'unreferenced candidate',
    ],
    { GIT_OBJECT_DIRECTORY: join(borrowed, 'objects') },
  );
  assert.equal(git(root, ['cat-file', '-t', dangling]), 'commit');
  assert.equal(git(root, ['branch', '--contains', dangling]), '');
  return {
    root,
    temporary,
    borrowed,
    base,
    referencedHead,
    head: dangling,
    put,
    commit,
  };
}

function candidateGit(copy: string, args: string[]) {
  return runGit(copy, args);
}

function capturePass(job: Job, id: string, sha: string) {
  const diagnostics = join(stateDirectory(job), 'diagnostics');
  mkdirSync(diagnostics, { recursive: true });
  writeFileSync(join(diagnostics, `${sha}-${id}-capture.txt`), '');
  return {
    id,
    exitCode: 0,
    durationMs: 0,
    sha256: createHash('sha256').update('').digest('hex'),
  };
}

test('candidate copies are released before the next red-first evaluation', async (context) => {
  const f = fixture(context);
  const paths = [
    fixtureTestPath,
    'test/second.test.mjs',
    'test/third.test.mjs',
  ];
  const unchanged = 'test/unchanged.test.mjs';
  for (const path of [...paths, unchanged]) f.put(path, baseTest);
  const base = f.commit('base tests');
  for (const path of paths) f.put(path, headTest);
  const head = f.commit(
    `change tests\n\nChange-contract: ${fixtureTestPath}:green->green\nChange-contract: ${unchanged}:green->green`,
  );
  const temporary = join(f.root, '.krn', 'tmp');
  const liveCopies = () =>
    readdirSync(temporary).filter((entry) => entry.startsWith('verdict-'));
  const liveCounts: number[] = [];
  const run: typeof execute = async (
    _root,
    copy,
    job,
    id,
    _argv,
    _timeout,
    sha,
  ) => {
    liveCounts.push(liveCopies().length);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      existsSync(copy),
      true,
      'the awaited executor still owns its copy',
    );
    const evidence = capturePass(job, id, sha);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      existsSync(copy),
      true,
      'classification still needs its diagnostics',
    );
    return evidence;
  };

  const report = await redFirst(f.root, base, head, undefined, run);

  assert.equal(report.results.length, 6);
  assert.ok(report.contracts?.every(({ proven }) => proven));
  assert.deepEqual(liveCounts, Array(7).fill(1));
  assert.deepEqual(liveCopies(), []);
});

test('candidate cleanup releases confirmed executor cancellation', async (context) => {
  const f = fixture(context);
  const controller = new AbortController();
  const error = new Error('fixture cancellation after confirmed teardown');
  let calls = 0;
  const run: typeof execute = async (_root, copy) => {
    calls++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(copy), true);
    controller.abort(error);
    throw error;
  };

  await assert.rejects(
    redFirst(f.root, f.base, f.head, controller.signal, run),
    (caught) => caught === error,
  );
  assert.equal(calls, 1, 'cancellation must stop later evaluations');
  assert.deepEqual(readdirSync(join(f.root, '.krn', 'tmp')), []);
});

test('unconfirmed teardown retains candidate bytes and helpers for a live reader', async (context) => {
  const f = fixture(context);
  const error = new TeardownUnconfirmed('fixture scope readback failed');
  let calls = 0;
  let reader: ChildProcess | undefined;
  let paths: string[] = [];
  let expectedBytes: string[] = [];
  const run: typeof execute = async (
    _root,
    copy,
    job,
    id,
    _argv,
    _timeout,
    sha,
  ) => {
    calls++;
    const helpers = readdirSync(copy)
      .filter((entry) => entry.startsWith('.krn-redfirst-'))
      .map((entry) => join(copy, entry));
    assert.ok(helpers.length > 0, 'the executor received generated helpers');
    const diagnostics = join(stateDirectory(job), 'diagnostics');
    mkdirSync(diagnostics, { recursive: true });
    const output = join(diagnostics, `${sha}-${id}-capture.txt`);
    writeFileSync(output, 'fixture output before teardown failure\0\n');
    paths = [join(copy, fixtureTestPath), ...helpers, output];
    expectedBytes = paths.map((path) => readFileSync(path).toString('base64'));
    reader = spawn(
      process.execPath,
      [
        '--input-type=commonjs',
        '-e',
        `const { readFileSync } = require('node:fs');
process.on('message', paths => {
  try { process.send({ bytes: paths.map(path => readFileSync(path).toString('base64')) }); }
  catch (error) { process.send({ error: error.message }); }
});
process.send('ready');`,
      ],
      { cwd: copy, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    await once(reader, 'message', { signal: AbortSignal.timeout(10_000) });
    throw error;
  };

  try {
    await assert.rejects(
      redFirst(f.root, f.base, f.head, undefined, run),
      (caught) => caught === error,
    );
    assert.equal(calls, 1, 'unconfirmed teardown must stop later evaluations');
    assert.ok(reader);
    assert.equal(
      reader.exitCode,
      null,
      'the reader has not confirmed teardown',
    );
    const readback = once(reader, 'message', {
      signal: AbortSignal.timeout(10_000),
    });
    reader.send(paths);
    const [observed] = await readback;
    assert.equal(
      observed.error,
      undefined,
      'the live reader can read its files',
    );
    assert.deepEqual(observed.bytes, expectedBytes);
  } finally {
    if (reader && reader.exitCode === null && reader.signalCode === null) {
      const stopped = once(reader, 'exit', {
        signal: AbortSignal.timeout(10_000),
      });
      reader.kill('SIGTERM');
      await stopped;
    }
  }
});

test('candidate copies own borrowed objects and preserve exact unreferenced commits', async (context) => {
  const f = fixture(context);
  const configBefore = readFileSync(join(f.root, '.git', 'config'));
  const headObject = git(f.root, ['rev-parse', `${f.head}^{tree}`]);
  const headBlob = git(f.root, ['rev-parse', `${f.head}:${fixtureTestPath}`]);
  const expectedObjects = [
    f.base,
    f.referencedHead,
    f.head,
    headObject,
    headBlob,
  ];
  const temporaryDirectory = join(f.root, '.krn', 'tmp');
  mkdirSync(temporaryDirectory, { recursive: true });
  const temporaryEntriesBefore = new Set(readdirSync(temporaryDirectory));
  const observations: string[] = [];
  const run: typeof execute = async (
    _root,
    copy,
    job,
    id,
    _argv,
    _timeout,
    sha,
  ) => {
    const failures: string[] = [];
    if (existsSync(join(copy, '.git', 'objects', 'info', 'alternates')))
      failures.push('candidate still has an alternate object store');
    const currentHead = candidateGit(copy, ['rev-parse', '--verify', 'HEAD']);
    if (currentHead.status !== 0 || currentHead.stdout.trim() !== sha)
      failures.push('candidate exact HEAD is unavailable');
    if (readFileSync(join(copy, fixtureTestPath), 'utf8') !== headTest)
      failures.push('candidate test overlay does not match the source SHA');
    const sourceConfig = candidateGit(copy, [
      'config',
      '--local',
      '--get',
      'krn.sourceOnly',
    ]);
    if (sourceConfig.status === 0)
      failures.push('candidate inherited source-local Git config');

    const hiddenBorrowed = `${f.borrowed}.hidden-${randomUUID()}`;
    renameSync(f.borrowed, hiddenBorrowed);
    try {
      for (const object of expectedObjects) {
        const available = candidateGit(copy, [
          'cat-file',
          '-e',
          `${object}^{object}`,
        ]);
        if (available.status !== 0)
          failures.push(
            `candidate cannot read object ${object} without its source`,
          );
      }
      const sourceLocalGitConfig = readFileSync(join(f.root, '.git', 'config'));
      if (!sourceLocalGitConfig.equals(configBefore))
        failures.push('candidate execution changed source Git config');
    } finally {
      renameSync(hiddenBorrowed, f.borrowed);
    }
    if (failures.length) throw new Error(failures.join('; '));
    observations.push(sha);

    return capturePass(job, id, sha);
  };

  const report = await redFirst(f.root, f.base, f.head, undefined, run);

  assert.deepEqual(
    report.results.map(({ side, sha, classification }) => ({
      side,
      sha,
      classification,
    })),
    [
      { side: 'base', sha: f.base, classification: 'pass' },
      { side: 'head', sha: f.head, classification: 'pass' },
    ],
    JSON.stringify(report.results),
  );
  assert.deepEqual(observations, [f.base, f.head]);
  assert.equal(
    readFileSync(join(f.root, '.git', 'config')).equals(configBefore),
    true,
  );
  assert.deepEqual(
    readdirSync(temporaryDirectory).filter(
      (entry) => !temporaryEntriesBefore.has(entry),
    ),
    [],
    'candidate copies must be cleaned after review',
  );
});
