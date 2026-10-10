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
import { recordRepo } from '../../src/foreman/state.ts';
import type { Capsule, Deps } from '../../src/foreman/types.ts';
import { verifyCheckpoint } from '../../src/foreman/verdict.ts';
import { judge } from '../../src/verdict/index.ts';
import { MAX_CHECK_OUTPUT_BYTES } from '../../src/verdict/sandbox.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('final teardown fallback targets the canonical systemd scope', () => {
  const source = readFileSync(
    new URL('../../src/verdict/sandbox.ts', import.meta.url),
    'utf8',
  );
  const fallback = source.match(
    /if \(state\.status !== 0 \|\| group\.status !== 0 \|\| survivors\) \{\s*await killAndVerifyScope\(root, busEnv, (\w+)\);/u,
  );
  assert.ok(fallback, 'final teardown fallback must remain covered');
  assert.equal(
    fallback[1],
    'scope',
    'final teardown fallback must target the canonical .scope identity',
  );
});

function fixture(
  argv: readonly string[],
  withLockfile = false,
  timeoutMs = 3000,
) {
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
      checks: [{ id: 'declared', argv, timeoutMs }],
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

test('real SIGTERM during a sleeping verdict check stops before submit and is traced', async (t) => {
  if (
    !requiresIsolation(
      t,
      'real SIGTERM during a sleeping verdict check stops before submit and is traced',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = fixture(['/usr/bin/sleep', '30'], false, 30000);
  recordRepo(f.job, f.root);
  const busEnv = {
    ...process.env,
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ??
      `unix:path=/run/user/${process.getuid?.() ?? 0}/bus`,
  };
  const scopeUnits = () => {
    const result = spawnSync(
      'systemctl',
      [
        '--user',
        'list-units',
        '--type=scope',
        '--all',
        '--no-legend',
        '--plain',
        '--no-pager',
      ],
      { encoding: 'utf8', env: busEnv },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter(
        (unit) => unit?.startsWith('krn-check-') && unit.endsWith('.scope'),
      );
  };
  const scopesBefore = new Set(scopeUnits());
  const marker = join(f.root, 'submit-called');
  const source = `
    import { writeFileSync } from 'node:fs';
    import { verifyCheckpoint } from ${JSON.stringify(new URL('../../src/foreman/verdict.ts', import.meta.url).href)};
    import * as trace from ${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)};
    const job=${JSON.stringify(f.job)};
    const controller=new AbortController();
    process.once('SIGTERM',()=>controller.abort('SIGTERM'));
    const capsule=${JSON.stringify({ jobId: f.job.id, issue: f.job.issue, contractRevision: 'r1', epoch: 0, base: f.base, head: f.sha, branch: 'main', worktree: f.root, nextAction: 'done', lease: 'checkpointed', blockers: [], decisions: [], rejectedApproaches: [], references: [] })};
    const contract=${JSON.stringify({ issueId: f.job.issue, identifier: 'fixture', title: 'fixture', description: 'fixture', revision: 'r1', targetRepo: 'fixture/repo', checks: ['declared'] })};
    const deps={budget:{maxRepairs:0},signal:controller.signal,trace:{verdict:trace.verdict},ledger:{submitForReview:async()=>{writeFileSync(${JSON.stringify(marker)},'called');return 'submitted'}},stop:(_job,state,reasons)=>({kind:'stop',state,reasons})};
    const result=await verifyCheckpoint(job,capsule,${JSON.stringify(f.sha)},contract,0,deps);
    if(controller.signal.aborted) await trace.stopped(job,'SIGTERM');
    process.stdout.write(JSON.stringify(result)+'\\n');
    if(controller.signal.aborted) process.exitCode=130;
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  const startedAt = Date.now();
  child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (errors += chunk));
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.root, '.krn', 'tmp')) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    let ownedScope: string | undefined;
    while (Date.now() < deadline && !ownedScope) {
      ownedScope = scopeUnits().find((unit) => !scopesBefore.has(unit));
      if (!ownedScope) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ownedScope, 'verdict did not create an observable systemd scope');
    assert.ok(child.pid);
    process.kill(child.pid, 'SIGTERM');
    const code = await new Promise<number | null>((resolve) =>
      child.once('close', resolve),
    );
    assert.ok(
      Date.now() - startedAt < 8000,
      'SIGTERM must kill the verdict scope promptly',
    );
    const scope = spawnSync(
      'systemctl',
      [
        '--user',
        'show',
        ownedScope,
        '-p',
        'Id',
        '-p',
        'ActiveState',
        '-p',
        'ControlGroup',
        '--value',
      ],
      { encoding: 'utf8', env: busEnv },
    );
    assert.equal(scope.status, 0, scope.stderr);
    const [scopeId, activeState, controlGroup] = scope.stdout
      .trimEnd()
      .split(/\r?\n/u);
    assert.equal(
      scopeId,
      ownedScope,
      'cancellation must verify the created .scope identity',
    );
    assert.ok(
      activeState === 'inactive' || activeState === 'failed',
      `cancelled verdict scope must be stopped (state=${activeState})`,
    );
    const cgroupProcs = controlGroup
      ? `/sys/fs/cgroup${controlGroup}/cgroup.procs`
      : '';
    assert.ok(
      !cgroupProcs ||
        !existsSync(cgroupProcs) ||
        readFileSync(cgroupProcs, 'utf8').trim() === '',
      'cancelled verdict scope must have no remaining processes',
    );
    assert.equal(code, 130, errors);
    assert.equal(
      existsSync(marker),
      false,
      'SIGTERM must prevent submitForReview',
    );
    assert.match(output, /stopped/u);
    assert.match(
      readFileSync(
        join(f.root, '.krn', 'runs', 'foreman', f.job.id, 'trace.jsonl'),
        'utf8',
      ),
      /"kind":"stopped"/u,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Paperclip board changes and conflicts return human decision outcomes', async (t) => {
  if (
    !requiresIsolation(
      t,
      'Paperclip board changes and conflicts return human decision outcomes',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
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
  let submission: 'board_conflict' | 'board_changed' = 'board_conflict';
  const deps = {
    budget: { maxRepairs: 0 },
    ledger: { submitForReview: async () => submission },
    trace: {},
    stop: (_job: unknown, state: string, reasons: readonly string[]) => ({
      kind: 'stop',
      state,
      reasons,
    }),
  } as unknown as Deps;
  try {
    for (const reason of ['board_conflict', 'board_changed'] as const) {
      submission = reason;
      const result = await verifyCheckpoint(
        f.job,
        capsule,
        f.sha,
        {
          issueId: f.job.issue,
          identifier: 'fixture',
          title: 'sandbox fixture',
          description: 'sandbox fixture',
          revision: 'r1',
          targetRepo: 'fixture/repo',
          checks: ['declared'],
        },
        0,
        deps,
      );
      assert.equal(result.kind, 'stop');
      if (result.kind === 'stop') {
        assert.deepEqual(result.outcome, {
          kind: 'stop',
          state: 'human_decision',
          reasons: [reason],
        });
      }
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('worker HEAD registry edits cannot replace commands from the base registry', async (t) => {
  if (
    !requiresIsolation(
      t,
      'worker HEAD registry edits cannot replace commands from the base registry',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
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

test('sandbox checks can write to the detached copy', async (t) => {
  if (
    !requiresIsolation(t, 'sandbox checks can write to the detached copy', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
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

test('a successful check command returns zero', async (t) => {
  if (
    !requiresIsolation(t, 'a successful check command returns zero', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
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

test('16 MiB check output is capped with the correct hash and rolling tail', async (t) => {
  if (
    !requiresIsolation(
      t,
      '16 MiB check output is capped with the correct hash and rolling tail',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const expectedBytes = MAX_CHECK_OUTPUT_BYTES;
  assert.equal(expectedBytes, 8 * 1024 * 1024);
  const f = fixture([
    process.execPath,
    '-e',
    `process.stdout.write('x'.repeat(16*1024*1024))`,
  ]);
  const beforeExternal = process.memoryUsage().external;
  let peakExternal = beforeExternal;
  const sample = setInterval(() => {
    peakExternal = Math.max(peakExternal, process.memoryUsage().external);
  }, 1);
  let event:
    | {
        readonly checks: readonly {
          readonly exitCode: number;
          readonly sha256: string;
        }[];
      }
    | undefined;
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async (value) => {
        event = value;
      },
    );
    assert.equal(result.kind, 'fail');
    assert.equal(event?.checks[0]?.exitCode, 125);
    const diagnostic = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const [diagnosticFile] = readdirSync(diagnostic);
    assert.ok(diagnosticFile);
    const tail = readFileSync(join(diagnostic, diagnosticFile));
    assert.equal(
      event?.checks[0]?.sha256,
      createHash('sha256')
        .update(Buffer.alloc(expectedBytes, 'x'))
        .digest('hex'),
      `unexpected bounded output digest; tail=${tail.toString('hex')}`,
    );
    assert.equal(tail.toString(), 'x'.repeat(2 * 1024));
    assert.ok(
      peakExternal - beforeExternal < 12 * 1024 * 1024,
      `captured output expanded parent external memory by ${peakExternal - beforeExternal} bytes`,
    );
  } finally {
    clearInterval(sample);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('locked dependencies install offline inside the detached copy', async (t) => {
  if (
    !requiresIsolation(
      t,
      'locked dependencies install offline inside the detached copy',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
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

test('a detached background writer cannot produce a pass', async (t) => {
  if (
    !requiresIsolation(
      t,
      'a detached background writer cannot produce a pass',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
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

test('network access is blocked inside checks', async (t) => {
  if (
    !requiresIsolation(t, 'network access is blocked inside checks', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
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

test('moving the worker HEAD during checks is refused', async (t) => {
  if (
    !requiresIsolation(t, 'moving the worker HEAD during checks is refused', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
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
    const moverDone = new Promise<void>((resolve) =>
      mover.once('exit', () => resolve()),
    );
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    await moverDone;
    assert.equal(result.kind, 'refused');
    assert.match(result.findings.join(' '), /HEAD changed/u);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} during a verdict removes its registered check worktree`, async (t) => {
    if (
      !requiresIsolation(
        t,
        `${signal} during a verdict removes its registered check worktree`,
        ['bwrap', 'systemdUserScope'],
      )
    )
      return;
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
