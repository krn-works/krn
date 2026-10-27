import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  blindUsage,
  candidateId,
  dataOperation,
  directoryPath,
  exists,
  inside,
  type LedgerEntry,
  ledgerState,
  overlaps,
  parseOptions,
  withLedger,
  writeJson,
} from './ledger.ts';
import {
  EvalDataError,
  type ExperimentManifest,
  loadManifest,
} from './manifest.ts';
import { planExperiment } from './plan.ts';

const execute = promisify(execFile);
function gitEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
  };
}
function gitArgs(repo: string, args: string[]) {
  return [
    '-C',
    repo,
    '-c',
    'core.logAllRefUpdates=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
    ...args,
  ];
}
async function git(repo: string, args: string[]): Promise<string> {
  return (
    await execute('git', gitArgs(repo, args), {
      env: gitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim();
}
async function rawGit(repo: string, args: string[]): Promise<Buffer> {
  return (
    await execute('git', gitArgs(repo, args), {
      env: gitEnvironment(),
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}

async function importTree(
  candidate: string,
  repo: string,
  tree: string,
): Promise<void> {
  // A tree revision traverses only trees/blobs, never candidate commits. Stream
  // the pack so repository size does not become a process-buffer limit.
  const pack = spawn(
    'git',
    gitArgs(candidate, ['pack-objects', '--stdout', '--revs']),
    { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const unpack = spawn('git', gitArgs(repo, ['index-pack', '--stdin']), {
    env: gitEnvironment(),
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  function completed(child: ChildProcess): Promise<void> {
    let stderr = '';
    child.stderr?.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-8192);
    });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new EvalDataError(
                `Git tree transfer failed (${code}): ${stderr}`,
              ),
            ),
      );
    });
  }
  const packed = completed(pack);
  const unpacked = completed(unpack);
  pack.stdin.end(`${tree}\n`);
  const results = await Promise.allSettled([
    packed,
    unpacked,
    pipeline(pack.stdout, unpack.stdin),
  ]);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}
async function scan(
  manifest: ExperimentManifest,
  task: ExperimentManifest['tasks'][number],
  options: { experiment: string; root: string; candidate: string; run: string },
  tree: string,
): Promise<LedgerEntry['flags']> {
  const materials = await Promise.all(
    [task.packet, task.control].map((path) =>
      readFile(join(options.experiment, path), 'utf8'),
    ),
  );
  const ngrams = materials.map((text) => {
    const tokens = words(text);
    const values = new Set<string>();
    for (let index = 0; index + 8 <= tokens.length; index += 1)
      values.add(tokens.slice(index, index + 8).join(' '));
    return values;
  });
  const paths = (
    await rawGit(options.candidate, [
      'diff-tree',
      '--no-commit-id',
      '--no-renames',
      '--name-only',
      '-r',
      '-z',
      '--diff-filter=ACMT',
      task.baseSha,
      tree,
    ])
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const flags: LedgerEntry['flags'] = [];
  for (const file of paths) {
    const records = (
      await rawGit(options.candidate, [
        '--literal-pathspecs',
        'ls-tree',
        '-r',
        '-z',
        tree,
        '--',
        file,
      ])
    )
      .toString('utf8')
      .split('\0');
    // --literal-pathspecs prevents a filename being interpreted as a Git glob.
    const record = records.find(
      (record) => record.slice(record.indexOf('\t') + 1) === file,
    );
    const match =
      record && /^(100644|100755) blob ([a-f0-9]{40})\t/u.exec(record);
    if (!match?.[2]) continue;
    const object = match[2];
    if (
      Number(await git(options.candidate, ['cat-file', '-s', object])) >
      1024 * 1024
    )
      continue;
    const bytes = await rawGit(options.candidate, ['cat-file', 'blob', object]);
    if (bytes.includes(0)) continue;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      continue;
    }
    const tokens = words(text);
    const candidateNgrams = new Set<string>();
    for (let index = 0; index + 8 <= tokens.length; index += 1)
      candidateNgrams.add(tokens.slice(index, index + 8).join(' '));
    const hasNgram = (index: number) =>
      [...(ngrams[index] ?? [])].some((value) => candidateNgrams.has(value));
    const signatures: [LedgerEntry['flags'][number]['kind'], boolean][] = [
      ['packet-ngram', hasNgram(0)],
      ['control-ngram', hasNgram(1)],
      ['run-path', text.includes(options.root)],
      [
        'slot-path',
        [
          join(options.root, manifest.id, task.id),
          join(options.root, manifest.id, options.run),
        ].some((path) => text.includes(path)),
      ],
      [
        'exemplar-sha',
        text.toLowerCase().includes(task.exemplarSha.slice(0, 12)),
      ],
      ['co-author', /Co-Authored-By/iu.test(text)],
      [
        'model',
        manifest.arms.some((arm) =>
          text.toLowerCase().includes(arm.model.toLowerCase()),
        ),
      ],
      [
        'harness',
        manifest.arms.some((arm) =>
          text.toLowerCase().includes(arm.harness.toLowerCase()),
        ),
      ],
    ];
    for (const [kind, found] of signatures)
      if (found) flags.push({ file, kind });
  }
  return flags;
}

async function buildRepository(
  candidate: string,
  repo: string,
  base: string,
  tree: string,
): Promise<void> {
  await git(dirname(repo), [
    'init',
    '--quiet',
    '--template=',
    '--initial-branch=main',
    repo,
  ]);
  await git(repo, ['config', 'core.logAllRefUpdates', 'false']);
  await git(repo, [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--no-recurse-submodules',
    '--depth=1',
    '--',
    candidate,
    base,
  ]);
  await importTree(candidate, repo, tree);
  const result = await execute(
    'git',
    gitArgs(repo, ['commit-tree', tree, '-p', base, '-m', 'candidate']),
    {
      env: {
        ...gitEnvironment(),
        GIT_AUTHOR_NAME: 'krn-eval',
        GIT_AUTHOR_EMAIL: 'eval@krn.invalid',
        GIT_COMMITTER_NAME: 'krn-eval',
        GIT_COMMITTER_EMAIL: 'eval@krn.invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
    },
  );
  await git(repo, ['update-ref', 'refs/heads/main', result.stdout.trim()]);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', base]);
  await git(repo, ['checkout', '--quiet', '--force', 'main']);
}

async function verifyRepository(
  repo: string,
  base: string,
  tree: string,
): Promise<void> {
  await directoryPath(repo);
  await directoryPath(join(repo, '.git'));
  const config = (
    await git(repo, ['config', '--local', '--no-includes', '--list'])
  )
    .split('\n')
    .sort();
  if (
    JSON.stringify(config) !==
    JSON.stringify([
      'core.bare=false',
      'core.filemode=true',
      'core.logallrefupdates=false',
      'core.repositoryformatversion=0',
    ])
  )
    throw new EvalDataError('blinded repository configuration changed');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const expected = `tree ${tree}\nparent ${base}\nauthor krn-eval <eval@krn.invalid> 946684800 +0000\ncommitter krn-eval <eval@krn.invalid> 946684800 +0000\n\ncandidate\n`;
  const objects = (
    await git(repo, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)',
    ])
  )
    .split('\n')
    .sort();
  const reachable = (await git(repo, ['rev-list', '--objects', '--all']))
    .split('\n')
    .map((line) => line.split(' ')[0])
    .sort();
  if (
    !(await rawGit(repo, ['cat-file', 'commit', head])).equals(
      Buffer.from(expected),
    ) ||
    (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])) !==
      `refs/heads/main ${head}\nrefs/remotes/origin/main ${base}` ||
    (await git(repo, ['symbolic-ref', 'HEAD'])) !== 'refs/heads/main' ||
    (await git(repo, ['remote'])) !== '' ||
    (await git(repo, ['reflog', 'show', '--all'])) !== '' ||
    (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) !==
      '' ||
    (await readFile(join(repo, '.git', 'shallow'), 'utf8')) !== `${base}\n` ||
    JSON.stringify(objects) !== JSON.stringify(reachable)
  )
    throw new EvalDataError('blinded repository invariant changed');
  for (const path of [
    'hooks',
    'logs',
    'info/grafts',
    'objects/info/alternates',
  ]) {
    if (await exists(join(repo, '.git', path)))
      throw new EvalDataError(
        'blinded repository contains hooks, reflogs or external object sources',
      );
  }
}

export async function blindCommand(args: string[]): Promise<void> {
  const option = parseOptions(
    args,
    ['--experiment', '--root', '--run', '--candidate', '--out'],
    ['--draft', '--json'],
    blindUsage,
  );
  const manifest = await loadManifest(option('--experiment'));
  const result = await dataOperation(async () => {
    const options = {
      experiment: await directoryPath(option('--experiment')),
      root: await directoryPath(option('--root'), true),
      candidate: await directoryPath(option('--candidate')),
      out: await directoryPath(option('--out'), true),
      run: option('--run'),
    };
    for (const path of [options.candidate, options.root, options.experiment])
      if (overlaps(options.out, path))
        throw new EvalDataError(
          'output overlaps candidate, root or experiment',
        );
    const ledgerPath = await directoryPath(
      join(options.root, manifest.id, 'ledger'),
      true,
    );
    if (
      overlaps(ledgerPath, options.candidate) ||
      inside(options.root, options.candidate)
    )
      throw new EvalDataError('ledger root overlaps candidate');
    const run = planExperiment(manifest, {
      draft: Boolean(option('--draft')),
    }).runs.find((run) => run.runId === options.run);
    if (!run) throw new EvalDataError('unknown run id in experiment plan');
    const task = manifest.tasks.find((task) => task.id === run.task);
    if (!task) throw new EvalDataError('run task is missing');
    if (
      (await git(options.candidate, ['rev-parse', '--show-toplevel'])) !==
      options.candidate
    )
      throw new EvalDataError('candidate must be the Git working tree root');
    if (
      (await git(options.candidate, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])) !== ''
    )
      throw new EvalDataError(
        'candidate must be clean (no uncommitted changes)',
      );
    try {
      await git(options.candidate, [
        'merge-base',
        '--is-ancestor',
        task.baseSha,
        'HEAD',
      ]);
    } catch {
      throw new EvalDataError('candidate does not descend from task baseSha');
    }
    const tree = await git(options.candidate, ['rev-parse', 'HEAD^{tree}']);
    return withLedger(manifest, options, true, async (ledger) => {
      const state = await ledgerState(manifest, ledger);
      if (state.sealed)
        throw new EvalDataError('ledger is sealed; blind writes are refused');
      const id = candidateId(ledger.key, run.runId);
      const entry: LedgerEntry = {
        runId: run.runId,
        task: run.task,
        replica: run.replica,
        arm: run.arm,
        candidateTreeSha: tree,
        flags: await scan(manifest, task, options, tree),
      };
      const previous = state.entries.find((entry) => entry.blindedId === id);
      if (previous) {
        const { blindedId: _id, ...stored } = previous;
        if (JSON.stringify(stored) !== JSON.stringify(entry))
          throw new EvalDataError(
            'run already blinded with different tree or flags',
          );
      }
      const target = await directoryPath(join(options.out, id), true);
      const repo = join(target, 'repo');
      if (await exists(target)) {
        if (!previous)
          throw new EvalDataError('candidate output already exists or changed');
        await verifyRepository(repo, task.baseSha, tree);
      } else {
        await mkdir(options.out, { recursive: true });
        await mkdir(target);
        try {
          await buildRepository(options.candidate, repo, task.baseSha, tree);
          await verifyRepository(repo, task.baseSha, tree);
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          throw error;
        }
      }
      if (!previous)
        await writeJson(join(ledger.path, 'entries', `${id}.json`), entry);
      return { blindedId: id, path: repo };
    });
  });
  process.stdout.write(
    option('--json')
      ? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`
      : `${result.blindedId}\t${result.path}\n`,
  );
}
