import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_OPTIONAL_LOCKS: '0',
};
const packet = '\uFEFFone two three four five six seven eight 💫\r\n';
const control = '\uFEFFred tan sky sea sun fog ice ash 🌟\r\n'.padEnd(
  packet.length,
  ' ',
);
const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function git(repo: string, args: string[], input?: string) {
  const result = spawnSync(
    'git',
    ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args],
    { env, encoding: 'utf8', input },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) {
      for (const [child, bytes] of Object.entries(await files(path)))
        result[join(name, child)] = bytes;
    } else result[name] = (await readFile(path)).toString('base64');
  }
  return result;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'krn-eval-blind-'));
  const candidate = join(directory, 'candidate');
  await mkdir(candidate);
  git(candidate, ['init', '--quiet', '--template=', '--initial-branch=main']);
  await writeFile(join(candidate, 'base.txt'), 'parent\n');
  git(candidate, ['add', '.']);
  git(candidate, ['commit', '--quiet', '-m', 'Parent']);
  const parent = git(candidate, ['rev-parse', 'HEAD']);
  await writeFile(join(candidate, 'base.txt'), 'base\n');
  git(candidate, ['add', '.']);
  git(candidate, ['commit', '--quiet', '-m', 'Base']);
  const base = git(candidate, ['rev-parse', 'HEAD']);
  await writeFile(join(candidate, 'exemplar.txt'), 'future\n');
  git(candidate, ['add', '.']);
  git(candidate, ['commit', '--quiet', '-m', 'Exemplar']);
  const exemplar = git(candidate, ['rev-parse', 'HEAD']);
  git(candidate, ['reset', '--hard', base]);
  await writeFile(join(candidate, 'answer.txt'), 'intermediate\n');
  git(candidate, ['add', '.']);
  git(candidate, [
    'commit',
    '--quiet',
    '-m',
    'arm-B-secret codex',
    '-m',
    'Co-Authored-By: Harness <harness@example.invalid>',
  ]);
  const intermediate = git(candidate, ['rev-parse', 'HEAD']);
  await writeFile(join(candidate, 'answer.txt'), 'final\n');
  git(candidate, ['add', '.']);
  git(candidate, [
    'commit',
    '--quiet',
    '-m',
    'arm-B-secret luna',
    '-m',
    'Co-Authored-By: Harness <harness@example.invalid>',
  ]);
  const head = git(candidate, ['rev-parse', 'HEAD']);
  const tree = git(candidate, ['rev-parse', 'HEAD^{tree}']);
  git(candidate, ['tag', 'arm-B-secret', intermediate]);
  git(candidate, ['remote', 'add', 'source', '/unused-fixture-source']);
  const experiment = join(directory, 'experiment');
  await mkdir(experiment);
  const inputs: Record<string, string> = {};
  for (const [name, bytes] of Object.entries({
    'packet.md': packet,
    'control.md': control,
    'contract.md': 'contract\n',
    'checklist.md': 'checklist\n',
  })) {
    await writeFile(join(experiment, name), bytes);
    inputs[name] = digest(bytes);
  }
  const value = {
    id: 'blinding-experiment',
    frozen: true,
    seed: 'blind',
    replicas: 2,
    arms: [
      { id: 'A', model: 'luna', harness: 'codex', material: 'none' },
      { id: 'B', model: 'luna', harness: 'codex', material: 'packet' },
      { id: 'C', model: 'luna', harness: 'codex', material: 'control' },
      { id: 'R', model: 'opus', harness: 'claude', material: 'none' },
    ],
    tasks: [
      {
        id: 'blinding-task',
        repository: 'fixture',
        baseSha: base,
        exemplarSha: exemplar,
        packet: 'packet.md',
        control: 'control.md',
        contract: 'contract.md',
        checklist: 'checklist.md',
        focusedCheck: ['node', '--test'],
        suiteChecks: [['npm', 'test']],
      },
    ],
    inputs,
  };
  const root = join(directory, 'runs');
  const out = join(directory, 'judges');
  const runId = digest([value.id, 'blinding-task', '1', 'B'].join('\0'));
  const ledger = join(root, value.id, 'ledger');
  const save = () =>
    writeFile(join(experiment, 'manifest.json'), JSON.stringify(value));
  await save();
  const invoke = (args: string[], cwd = process.cwd()) =>
    spawnSync(process.execPath, [cli, 'eval', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
  const blind = (
    overrides: Record<string, string> = {},
    extra: string[] = [],
  ) =>
    invoke([
      'blind',
      ...Object.entries({
        experiment,
        root,
        run: runId,
        candidate,
        out,
        ...overrides,
      }).flatMap(([key, value]) => [`--${key}`, value]),
      '--json',
      ...extra,
    ]);
  const command = (verb: string, extra: string[] = []) =>
    invoke([
      'ledger',
      verb,
      '--experiment',
      experiment,
      '--root',
      root,
      '--json',
      ...extra,
    ]);
  const entry = (id: string) => join(ledger, 'entries', `${id}.json`);
  const verdict = async (
    id: string,
    bytes = JSON.stringify({ blindedId: id, verdict: 'PASS' }),
  ) => {
    await mkdir(join(ledger, 'verdicts'), { recursive: true });
    await writeFile(join(ledger, 'verdicts', `${id}.json`), bytes);
  };
  return {
    directory,
    candidate,
    experiment,
    root,
    out,
    runId,
    ledger,
    value,
    base,
    parent,
    exemplar,
    intermediate,
    head,
    tree,
    save,
    invoke,
    blind,
    command,
    entry,
    verdict,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
function success(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  return value;
}
function failure(result: SpawnSyncReturns<string>, code = 65, pattern = /./u) {
  assert.equal(result.status, code, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['code', 'error', 'ok']);
  assert.equal(value.ok, false);
  assert.equal(value.code, code);
  assert.match(value.error, pattern);
  assert.equal(result.stderr, `${value.error}\n`);
}

test('eval blind exposes only the base snapshot and one neutral commit, with stable opaque ids', async () => {
  const f = await fixture();
  try {
    const sourceBefore = await files(f.candidate);
    const inputsBefore = await files(f.experiment);
    const otherSlot = join(f.root, f.value.id, 'neighbour');
    await mkdir(otherSlot, { recursive: true });
    await writeFile(join(otherSlot, 'private'), 'neighbour stays unchanged\n');
    const otherBefore = await files(otherSlot);
    const firstResult = f.blind();
    const first = success(firstResult); // RED on base: unknown eval subcommand returns 64.
    assert.match(first.blindedId, /^[a-f0-9]{12}$/u);
    const repo = join(f.out, first.blindedId, 'repo');
    const synthetic = git(repo, ['rev-parse', 'HEAD']);
    assert.deepEqual(
      git(repo, ['rev-list', '--all']).split('\n').sort(),
      [synthetic, f.base].sort(),
    );
    assert.equal(git(repo, ['rev-parse', 'HEAD^{tree}']), f.tree);
    assert.equal(
      git(repo, [
        'show',
        '-s',
        '--format=%P|%an|%ae|%cn|%ce|%aI|%cI|%B',
        'HEAD',
      ]),
      `${f.base}|krn-eval|eval@krn.invalid|krn-eval|eval@krn.invalid|2000-01-01T00:00:00Z|2000-01-01T00:00:00Z|candidate`,
    );
    assert.equal(
      git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
      `refs/heads/main ${synthetic}\nrefs/remotes/origin/main ${f.base}`,
    );
    assert.equal(git(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.equal(git(repo, ['remote']), '');
    assert.equal(git(repo, ['reflog', 'show', '--all']), '');
    assert.equal(git(repo, ['status', '--porcelain']), '');
    const gitFiles = await files(join(repo, '.git'));
    assert.ok(
      !Object.keys(gitFiles).some((name) => /^(hooks|logs)\//u.test(name)),
    );
    const all = git(repo, ['cat-file', '--batch-all-objects', '--batch']);
    assert.doesNotMatch(
      all,
      /Co-Authored-By|arm-B-secret|harness@example|intermediate/u,
    );
    const objects = git(repo, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)',
    ])
      .split('\n')
      .sort();
    const reachable = git(repo, ['rev-list', '--objects', '--all'])
      .split('\n')
      .map((line) => line.split(' ')[0])
      .sort();
    assert.deepEqual(objects, reachable);
    for (const sha of [f.parent, f.exemplar, f.intermediate, f.head])
      assert.ok(!objects.includes(sha));
    const secondResult = f.blind();
    const second = success(secondResult);
    assert.deepEqual(second, first);
    assert.equal(secondResult.stdout, firstResult.stdout);
    const another = success(f.blind({ out: join(f.directory, 'another') }));
    assert.equal(another.blindedId, first.blindedId);
    assert.equal(
      git(join(f.directory, 'another', first.blindedId, 'repo'), [
        'rev-parse',
        'HEAD',
      ]),
      synthetic,
    );
    const keyPath = join(f.ledger, 'key');
    const key = await readFile(keyPath);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    assert.equal(
      first.blindedId,
      createHmac('sha256', key).update(f.runId).digest('hex').slice(0, 12),
    );
    const stored = JSON.parse(await readFile(f.entry(first.blindedId), 'utf8'));
    assert.deepEqual(stored, {
      runId: f.runId,
      task: 'blinding-task',
      replica: 1,
      arm: 'B',
      candidateTreeSha: f.tree,
      flags: [],
    });
    assert.deepEqual(await files(f.candidate), sourceBefore);
    assert.deepEqual(await files(f.experiment), inputsBefore);
    assert.deepEqual(await files(otherSlot), otherBefore);
    f.value.id = 'another-experiment';
    await f.save();
    const run = digest([f.value.id, 'blinding-task', '1', 'B'].join('\0'));
    const other = success(f.blind({ run }));
    assert.notEqual(other.blindedId, first.blindedId);
  } finally {
    await f.cleanup();
  }
});

test('eval blind records diff leakage only in the assignment ledger and preserves the final tree', async () => {
  const f = await fixture();
  try {
    const slot = join(f.root, f.value.id, 'blinding-task');
    const text = `one\r\ntwo three four five six seven eight\nred tan sky sea sun fog ice ash\n${f.exemplar.slice(0, 12)}\n${slot}\nCo-Authored-By: codex luna opus claude\n`;
    await writeFile(join(f.candidate, 'leak.txt'), text);
    await writeFile(
      join(f.candidate, 'binary.bin'),
      Buffer.from([0, 0xff, ...Buffer.from(text)]),
    );
    await writeFile(
      join(f.candidate, 'large.txt'),
      text.padEnd(1024 * 1024 + 1, 'x'),
    );
    git(f.candidate, ['add', '.']);
    git(f.candidate, ['commit', '--quiet', '-m', 'leak fixture']);
    const output = success(f.blind());
    const entry = JSON.parse(await readFile(f.entry(output.blindedId), 'utf8'));
    assert.deepEqual(
      entry.flags.map((flag: { kind: string }) => flag.kind).sort(),
      [
        'co-author',
        'control-ngram',
        'exemplar-sha',
        'harness',
        'model',
        'packet-ngram',
        'run-path',
        'slot-path',
      ],
    );
    assert.ok(
      entry.flags.every((flag: { file: string }) => flag.file === 'leak.txt'),
    );
    const repo = join(f.out, output.blindedId, 'repo');
    assert.equal(
      git(repo, ['rev-parse', 'HEAD^{tree}']),
      git(f.candidate, ['rev-parse', 'HEAD^{tree}']),
    );
    assert.equal(await readFile(join(repo, 'leak.txt'), 'utf8'), text);
    assert.deepEqual((await readdir(repo)).sort(), [
      '.git',
      'answer.txt',
      'base.txt',
      'binary.bin',
      'large.txt',
      'leak.txt',
    ]);
    assert.ok(!(await files(repo))['ledger/entries']);
  } finally {
    await f.cleanup();
  }
});

test('eval blind refuses dirty candidates, unrelated bases and unknown runs without changing inputs', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.candidate, 'untracked.txt'), 'dirty');
    failure(f.blind(), 65, /clean|uncommitted/u);
    await rm(join(f.candidate, 'untracked.txt'));
    await writeFile(join(f.candidate, 'answer.txt'), 'dirty');
    failure(f.blind());
    git(f.candidate, ['add', '.']);
    failure(f.blind());
    git(f.candidate, ['reset', '--hard', f.head]);
    failure(f.blind({ run: 'unknown' }), 65, /run/u);
    git(f.candidate, ['checkout', '--quiet', '--detach', f.parent]);
    failure(f.blind(), 65, /base/u);
    git(f.candidate, ['checkout', '--quiet', 'main']);
    f.value.frozen = false;
    await f.save();
    failure(f.blind(), 65, /frozen/u);
    success(f.blind({}, ['--draft']));
  } finally {
    await f.cleanup();
  }
});

test('eval blind accepts a clean shallow working tree prepared from the task base', async () => {
  const f = await fixture();
  try {
    const candidate = join(f.root, f.value.id, 'blinding-task', 'repo');
    await mkdir(candidate, { recursive: true });
    git(candidate, ['init', '--quiet', '--template=', '--initial-branch=main']);
    git(candidate, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--depth=1',
      '--',
      f.candidate,
      f.base,
    ]);
    git(candidate, ['update-ref', 'refs/heads/main', f.base]);
    git(candidate, ['update-ref', 'refs/remotes/origin/main', f.base]);
    git(candidate, ['checkout', '--quiet', 'main']);
    await writeFile(join(candidate, 'answer.txt'), 'answer\n');
    git(candidate, ['add', '.']);
    git(candidate, ['commit', '--quiet', '-m', 'arm-B-secret']);
    const before = await files(candidate);
    const id = success(f.blind({ candidate })).blindedId;
    const repo = join(f.out, id, 'repo');
    assert.equal(git(repo, ['rev-list', '--count', '--all']), '2');
    assert.equal(
      git(repo, ['rev-parse', 'HEAD^{tree}']),
      git(candidate, ['rev-parse', 'HEAD^{tree}']),
    );
    assert.deepEqual(await files(candidate), before);
  } finally {
    await f.cleanup();
  }
});

test('eval blind scans changed nested text at the byte limit and excludes unchanged base files', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.candidate, 'inherited.txt'),
      'codex luna Co-Authored-By\n',
    );
    git(f.candidate, ['add', '.']);
    git(f.candidate, ['commit', '--quiet', '-m', 'Snapshot']);
    const task = f.value.tasks[0];
    assert.ok(task);
    task.baseSha = git(f.candidate, ['rev-parse', 'HEAD']);
    await f.save();
    await mkdir(join(f.candidate, 'nested'));
    await writeFile(join(f.candidate, 'nested', '💫[candidate].txt'), 'codex');
    await writeFile(
      join(f.candidate, 'base.txt'),
      'luna'.padEnd(1024 * 1024, 'x'),
    );
    await symlink('codex', join(f.candidate, 'link'));
    git(f.candidate, ['add', '.']);
    git(f.candidate, ['commit', '--quiet', '-m', 'Final']);
    const id = success(f.blind()).blindedId;
    const entry = JSON.parse(await readFile(f.entry(id), 'utf8'));
    assert.deepEqual(entry.flags, [
      { file: 'base.txt', kind: 'model' },
      { file: 'nested/💫[candidate].txt', kind: 'harness' },
    ]);
  } finally {
    await f.cleanup();
  }
});

test('eval blind refuses reused output with modified metadata or additional unreachable objects', async () => {
  const f = await fixture();
  try {
    const id = success(f.blind()).blindedId;
    const repo = join(f.out, id, 'repo');
    git(repo, ['commit', '--quiet', '--amend', '-m', 'arm-B-secret']);
    failure(f.blind(), 65, /invariant|changed/u);
    const out = join(f.directory, 'fresh-judges');
    success(f.blind({ out }));
    git(
      join(out, id, 'repo'),
      ['hash-object', '-w', '--stdin'],
      'arm-B-secret\n',
    );
    failure(f.blind({ out }), 65, /invariant|changed/u);
    await writeFile(join(f.candidate, 'answer.txt'), 'new final tree\n');
    git(f.candidate, ['add', '.']);
    git(f.candidate, ['commit', '--quiet', '-m', 'Another final']);
    failure(
      f.blind({ out: join(f.directory, 'yet-another') }),
      65,
      /already blinded/u,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval ledger hides assignments until sealed entries and all strict verdicts are verified', async () => {
  const f = await fixture();
  try {
    const a = success(f.blind()).blindedId;
    const run = digest([f.value.id, 'blinding-task', '2', 'R'].join('\0'));
    const b = success(f.blind({ run })).blindedId;
    const ids = [a, b].sort();
    assert.deepEqual(
      success(f.command('show')).candidates,
      ids.map((blindedId) => ({ blindedId, task: 'blinding-task' })),
    );
    const text = f.invoke([
      'ledger',
      'show',
      '--experiment',
      f.experiment,
      '--root',
      f.root,
    ]);
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /arm|replica|\t[BR]\b|runId/u);
    const seal = success(f.command('seal'));
    assert.deepEqual(success(f.command('seal')), seal);
    const sealed = JSON.parse(
      await readFile(join(f.ledger, 'sealed.json'), 'utf8'),
    );
    assert.deepEqual(
      sealed.entries,
      Object.fromEntries(
        await Promise.all(
          ids.map(async (id) => [id, digest(await readFile(f.entry(id)))]),
        ),
      ),
    );
    failure(f.blind(), 65, /sealed/u);
    failure(f.command('unblind'), 65, /verdict/u);
    await f.verdict(a);
    failure(f.command('unblind'), 65, /verdict/u);
    for (const bytes of [
      '{}',
      '{broken',
      JSON.stringify({ blindedId: a, verdict: 'PASS' }),
      JSON.stringify({ blindedId: b, verdict: 'pass' }),
      JSON.stringify({ blindedId: b, verdict: 'PASS', arm: 'R' }),
      `{"blindedId":"${b}","verdict":"PASS","__proto__":{}}`,
      '\uFEFF{}',
    ]) {
      await f.verdict(b, bytes);
      failure(f.command('unblind'));
    }
    await writeFile(
      join(f.ledger, 'verdicts', `${b}.json`),
      Buffer.from([0xff]),
    );
    failure(f.command('unblind'));
    await f.verdict(
      b,
      JSON.stringify(
        { blindedId: b, verdict: 'INCOMPLETE' },
        null,
        2,
      ).replaceAll('\n', '\r\n'),
    );
    const full = success(f.command('unblind'));
    assert.equal(full.candidates.length, 2);
    assert.deepEqual(
      full.candidates.map((entry: { blindedId: string }) => entry.blindedId),
      ids,
    );
    assert.ok(
      full.candidates.some(
        (entry: { arm: string; replica: number }) =>
          entry.arm === 'R' && entry.replica === 2,
      ),
    );
    const marker = await readFile(join(f.ledger, 'unblinded.json'), 'utf8');
    assert.ok(
      marker.includes(
        digest(await readFile(join(f.ledger, 'verdicts', `${b}.json`))),
      ),
    );
    assert.deepEqual(success(f.command('unblind')), full);
    await f.verdict(b, JSON.stringify({ blindedId: b, verdict: 'FAIL' }));
    failure(f.command('unblind'), 65, /verdict|changed/u);
  } finally {
    await f.cleanup();
  }
});

test('eval ledger refuses any post-seal entry mutation and empty sealing', async () => {
  const f = await fixture();
  try {
    failure(f.command('seal'));
    const id = success(f.blind()).blindedId;
    success(f.command('seal'));
    await f.verdict(id);
    const path = f.entry(id);
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
    for (const action of ['show', 'seal', 'unblind'])
      failure(f.command(action), 65, /hash|changed|integrity/u);
    await writeFile(path, bytes);
    await writeFile(join(f.ledger, 'entries', 'aaaaaaaaaaaa.json'), bytes);
    failure(f.command('unblind'));
    await rm(join(f.ledger, 'entries', 'aaaaaaaaaaaa.json'));
    await rm(path);
    failure(f.command('show'));
  } finally {
    await f.cleanup();
  }
});

test('eval blind checks overlapping paths in both directions before writing', async () => {
  const f = await fixture();
  try {
    const before = await files(f.directory);
    for (const protectedPath of [f.candidate, f.root, f.experiment]) {
      for (const out of [protectedPath, `${protectedPath}/child`, f.directory])
        failure(f.blind({ out }), 65, /overlap/u);
    }
    assert.deepEqual(await files(f.directory), before);
    const relativeOutput = success(f.blind({ out: `${f.out}/../judges//./` }));
    const keyBefore = await readFile(join(f.ledger, 'key'));
    const relativeResult = f.invoke(
      [
        'blind',
        '--experiment',
        'experiment/',
        '--root',
        './runs',
        '--run',
        f.runId,
        '--candidate',
        './candidate',
        '--out',
        './other//',
        '--json',
      ],
      f.directory,
    );
    assert.equal(success(relativeResult).blindedId, relativeOutput.blindedId);
    assert.deepEqual(await readFile(join(f.ledger, 'key')), keyBefore);
    assert.equal(relative(f.directory, f.out), 'judges');
  } finally {
    await f.cleanup();
  }
});

test('eval blind and ledger reject symlink components, invalid paths and non-directory targets', async () => {
  const f = await fixture();
  try {
    const linked = join(f.directory, 'link');
    await symlink(f.directory, linked);
    for (const option of ['candidate', 'experiment', 'root', 'out']) {
      failure(f.blind({ [option]: linked }), 65, /symlink/u);
      const name =
        option === 'candidate'
          ? 'candidate'
          : option === 'experiment'
            ? 'experiment'
            : option === 'root'
              ? 'runs'
              : 'judges';
      for (const path of [`${linked}/${name}`, `${linked}/../link/${name}`])
        failure(f.blind({ [option]: path }), 65, /symlink/u);
      for (const path of ['bad\\path', 'x'.repeat(5000)])
        failure(f.blind({ [option]: path }));
    }
    const file = join(f.directory, 'file');
    await writeFile(file, 'x');
    for (const option of ['candidate', 'experiment', 'root', 'out'])
      failure(f.blind({ [option]: file }));
    failure(f.blind({ candidate: join(f.directory, 'missing') }));
    const id = success(f.blind()).blindedId;
    const entry = f.entry(id);
    const bytes = await readFile(entry);
    const external = join(f.directory, 'external');
    await writeFile(external, bytes);
    await rm(entry);
    await symlink(external, entry);
    failure(f.command('show'), 65, /symlink/u);
    await rm(entry);
    await writeFile(entry, bytes);
    const verdictDir = join(f.ledger, 'verdicts');
    await symlink(f.directory, verdictDir);
    success(f.command('seal'));
    failure(f.command('unblind'), 65, /symlink/u);
    await rm(verdictDir);
    await chmod(join(f.ledger, 'key'), 0o644);
    failure(f.command('show'), 65, /0600|permission/u);
  } finally {
    await f.cleanup();
  }
});

test('eval blind and ledger enforce strict CLI options and typed JSON refusals', async () => {
  const f = await fixture();
  try {
    for (const args of [
      ['blind', '--json'],
      ['ledger', '--json'],
      ['ledger', 'other', '--json'],
      [
        'ledger',
        'show',
        '--experiment',
        f.experiment,
        '--root',
        f.root,
        '--draft',
        '--json',
      ],
    ])
      failure(f.invoke(args), 64, /usage|unknown/u);
    for (const extra of [
      ['--json'],
      ['--draft', '--draft'],
      ['--run', f.runId],
      ['--candidate', f.candidate],
      ['--unknown'],
    ])
      failure(f.blind({}, extra), 64, /once|unknown/u);
    for (const extra of [['--json'], ['--root', f.root], ['--unknown']])
      failure(f.command('show', extra), 64, /once|unknown/u);
    const text = f.invoke(['blind']);
    assert.equal(text.status, 64);
    assert.equal(text.stdout, '');
  } finally {
    await f.cleanup();
  }
});
