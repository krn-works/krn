import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Capsule, Deps } from '../../src/foreman/types.ts';
import { verifyCheckpoint } from '../../src/foreman/verdict.ts';
import { judge } from '../../src/verdict/index.ts';

function fixture(argv: readonly string[], withLockfile = false) {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'krn-verdict-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  git(['add', '.gitignore']);
  writeFileSync(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'declared', argv, timeoutMs: 3000 }],
    }),
  );
  if (withLockfile) {
    writeFileSync(join(root, 'package.json'), readFileSync('package.json'));
    writeFileSync(join(root, 'pnpm-lock.yaml'), readFileSync('pnpm-lock.yaml'));
  }
  git([
    'add',
    'krn.checks.json',
    ...(withLockfile ? ['package.json', 'pnpm-lock.yaml'] : []),
  ]);
  git(['commit', '-qm', 'registry']);
  const base = git(['rev-parse', 'HEAD']);
  const job = {
    id: 'sandbox-test',
    issue: 'S6P-1',
    worktree: root,
    repoRoot: root,
  };
  return { root, job, git, base, sha: base };
}

test('SIGTERM during verdict recording refuses checkpoint pass', async () => {
  const f = fixture(['/usr/bin/true']);
  const capsule: Capsule = {
    jobId: f.job.id,
    issue: f.job.issue,
    contractRevision: 'r1',
    epoch: 0,
    base: f.base,
    head: f.sha,
    branch: 'main',
    worktree: f.root,
    nextAction: 'done',
    lease: 'active',
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };
  const deps = {
    budget: { maxRepairs: 0 },
    trace: {
      verdict: async () => {
        process.emit('SIGTERM');
      },
    },
    stop: (_job: unknown, state: string, reasons: readonly string[]) => ({
      kind: 'stop',
      state,
      reasons,
    }),
  } as unknown as Deps;
  try {
    const result = await verifyCheckpoint(
      f.job,
      capsule,
      f.sha,
      { revision: 'r1', checks: ['declared'] },
      0,
      deps,
    );
    assert.equal(result.kind, 'stop');
    if (result.kind === 'stop') {
      assert.equal(result.outcome.kind, 'stop');
      if (result.outcome.kind === 'stop')
        assert.match(result.outcome.reasons.join(' '), /SIGTERM/u);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('worker HEAD registry edits cannot replace commands from the base registry', async () => {
  const f = fixture(['/usr/bin/printf', 'from-base']);
  try {
    writeFileSync(
      join(f.root, 'krn.checks.json'),
      JSON.stringify({
        version: 1,
        checks: [
          {
            id: 'declared',
            argv: ['/usr/bin/printf', 'from-head'],
            timeoutMs: 3000,
          },
        ],
      }),
    );
    f.git(['add', 'krn.checks.json']);
    f.git(['commit', '-qm', 'worker registry edit']);
    const sha = f.git(['rev-parse', 'HEAD']);
    let event:
      | {
          readonly sha: string;
          readonly checks: readonly { readonly sha256: string }[];
        }
      | undefined;
    const result = await judge(
      f.job,
      sha,
      f.base,
      ['declared'],
      async (value) => {
        event = value;
      },
    );
    assert.equal(
      result.kind,
      'pass',
      result.kind === 'pass' ? '' : result.findings.join('; '),
    );
    assert.equal(
      event?.checks[0]?.sha256,
      createHash('sha256').update('from-base').digest('hex'),
    );
    assert.equal(event?.sha, sha);
    assert.deepEqual(Object.keys(event?.checks[0] ?? {}).sort(), [
      'durationMs',
      'exitCode',
      'id',
      'sha256',
    ]);
    const diagnostic = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const details = readdirSync(diagnostic).map((name) =>
      readFileSync(join(diagnostic, name), 'utf8'),
    );
    assert.ok(details.some((value) => value.includes('from-base')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('zero declared checks are refused', async () => {
  const f = fixture(['/usr/bin/true']);
  try {
    const result = await judge(f.job, f.sha, f.base, [], async () => {});
    assert.equal(result.kind, 'refused');
    assert.match(result.findings.join(' '), /zero declared checks/u);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('sandbox checks can write to the detached copy', async () => {
  const f = fixture(['/usr/bin/touch', 'check-output']);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(
      result.kind,
      'pass',
      result.kind === 'pass' ? '' : result.findings.join('; '),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a successful check command returns zero', async () => {
  const f = fixture(['/usr/bin/true']);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    const directory = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const details = readdirSync(directory)
      .map((name) => readFileSync(join(directory, name), 'utf8'))
      .join('\n');
    assert.equal(
      result.kind,
      'pass',
      `${result.kind === 'pass' ? '' : result.findings.join('; ')} ${details}`,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('locked dependencies install offline inside the detached copy', async () => {
  const f = fixture(['node', '--version'], true);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    const directory = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const diagnostic = existsSync(directory)
      ? readdirSync(directory)
          .map((name) => readFileSync(join(directory, name), 'utf8'))
          .join('\n')
      : '';
    assert.equal(
      result.kind,
      'pass',
      `${result.kind === 'pass' ? '' : result.findings.join('; ')}\n${diagnostic}`,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a detached background writer cannot produce a pass', async () => {
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify('setTimeout(()=>{},30000)')}],{detached:true,stdio:'ignore'});child.unref();`;
  const f = fixture([process.execPath, '-e', source]);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.notEqual(result.kind, 'pass');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('network access is blocked inside checks', async () => {
  const f = fixture([
    process.execPath,
    '-e',
    `fetch('https://example.com').then(()=>process.exit(1),()=>process.exit(0))`,
  ]);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(
      result.kind,
      'pass',
      result.kind === 'pass' ? '' : result.findings.join('; '),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('moving the worker HEAD during checks is refused', async () => {
  const f = fixture([process.execPath, '-e', 'setTimeout(()=>{},1500)']);
  try {
    const mover = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(()=>require('node:child_process').spawnSync('git',${JSON.stringify(['-C', f.root, 'commit', '--allow-empty', '-qm', 'moved'])}),500)`,
      ],
      { stdio: 'ignore' },
    );
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    await new Promise<void>((resolve) => mover.once('exit', () => resolve()));
    assert.equal(result.kind, 'refused');
    assert.match(result.findings.join(' '), /HEAD changed/u);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} during a verdict removes its registered check worktree`, async () => {
    const f = fixture(['/usr/bin/sleep', '30']);
    const staleDecoy = join(f.root, '.krn', 'tmp', 'unrelated-stale-worktree');
    spawnSync('git', [
      '-C',
      f.root,
      'worktree',
      'add',
      '--detach',
      staleDecoy,
      f.sha,
    ]);
    rmSync(staleDecoy, { recursive: true, force: true });
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { judge } from ${JSON.stringify(new URL('../../src/verdict/index.ts', import.meta.url).href)}; await judge(${JSON.stringify(f.job)}, ${JSON.stringify(f.sha)}, ${JSON.stringify(f.base)}, ['declared'], async () => {});`,
      ],
      { stdio: 'ignore' },
    );
    const registered = () =>
      spawnSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .find(
          (line) => line.startsWith('worktree ') && line.includes('/verdict-'),
        )
        ?.slice('worktree '.length);
    let checkWorktree: string | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !checkWorktree) {
        checkWorktree = registered();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        checkWorktree,
        'verdict did not register its detached check worktree',
      );
      child.kill(signal);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const worktrees = spawnSync(
        'git',
        ['-C', f.root, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' },
      ).stdout;
      assert.equal(
        registered(),
        undefined,
        `${signal} left a registered check worktree`,
      );
      assert.ok(
        worktrees.includes(staleDecoy),
        'verdict cleanup pruned an unrelated stale worktree',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      if (checkWorktree) {
        spawnSync('git', [
          '-C',
          f.root,
          'worktree',
          'remove',
          '--force',
          checkWorktree,
        ]);
        spawnSync('git', [
          '-C',
          f.root,
          'worktree',
          'prune',
          '--expire',
          'now',
        ]);
      }
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
