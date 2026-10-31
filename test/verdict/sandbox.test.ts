import assert from 'node:assert/strict';
import childProcess, {
  type ChildProcess,
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createConnection } from 'node:net';
import { delimiter, join } from 'node:path';
import test, { mock } from 'node:test';
import { redFirst } from '../../src/flow/repository.ts';
import { recordRepo } from '../../src/foreman/state.ts';
import * as systemdScope from '../../src/hosts/systemd-scope.ts';
import { judge } from '../../src/verdict/index.ts';
import * as sandbox from '../../src/verdict/sandbox.ts';
import {
  CONDITION_WAIT_MS,
  conditionTimeoutFor,
  waitForCondition,
  waitForProcessExit,
} from '../helpers/condition-wait.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import { systemdEnvironment } from '../helpers/systemd-environment.ts';

const { parseSystemdScopeProperties } = systemdScope;
const { execute, MAX_CHECK_OUTPUT_BYTES, scopePids, scopeReadbackIsDrained } =
  sandbox;

function fixture(
  argv: readonly string[],
  withLockfile = false,
  timeoutMs = 2 * CONDITION_WAIT_MS,
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

// Keep the check alive until its owner releases it. The marker is written only
// after the watcher is installed, so it proves the check is running.
const heldCheck = [
  process.execPath,
  '-e',
  `const fs=require('node:fs');const gate=fs.watch('.',()=>{if(fs.existsSync('check-release'))gate.close()});fs.writeFileSync('check-ready','ready');if(fs.existsSync('check-release'))gate.close();`,
];

function registeredWorktree(root: string): string | undefined {
  const result = spawnSync(
    'git',
    ['-C', root, 'worktree', 'list', '--porcelain'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .find((line) =>
      line.startsWith(`worktree ${join(root, '.krn', 'tmp', 'verdict-')}`),
    )
    ?.slice('worktree '.length);
}

function waitForRunningCheck(root: string): Promise<string> {
  return waitForCondition(() => {
    const copy = registeredWorktree(root);
    return copy && existsSync(join(copy, 'check-ready')) ? copy : undefined;
  }, 'the registered verdict worktree with its running check marker');
}

test('real SIGTERM during a running verdict check stops before review readiness and is traced', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'real SIGTERM during a running verdict check stops before review readiness and is traced',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = fixture(heldCheck);
  recordRepo(f.job, f.root);
  const marker = join(f.root, 'ready-for-review-called');
  const source = `
    import { writeFileSync } from 'node:fs';
    import { verifyCheckpoint } from ${JSON.stringify(new URL('../../src/foreman/verdict.ts', import.meta.url).href)};
    import * as trace from ${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)};
    const job=${JSON.stringify(f.job)};
    const controller=new AbortController();
    process.once('SIGTERM',()=>controller.abort('SIGTERM'));
    const capsule=${JSON.stringify({ jobId: f.job.id, issue: f.job.issue, contractRevision: 'r1', epoch: 0, base: f.base, head: f.sha, branch: 'main', worktree: f.root, nextAction: 'done', lease: 'checkpointed', blockers: [], decisions: [], rejectedApproaches: [], references: [] })};
    const contract=${JSON.stringify({ issueId: f.job.issue, identifier: 'fixture', title: 'fixture', description: 'fixture', revision: 'r1', targetRepo: 'fixture/repo', checks: ['declared'] })};
    const deps={budget:{maxRepairs:0},signal:controller.signal,trace:{verdict:trace.verdict,readyForReview:async()=>{writeFileSync(${JSON.stringify(marker)},'called')}},stop:(_job,state,reasons)=>({kind:'stop',state,reasons})};
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
  child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (errors += chunk));
  try {
    await waitForRunningCheck(f.root);
    assert.ok(child.pid);
    process.kill(child.pid, 'SIGTERM');
    const { code } = await waitForProcessExit(
      child,
      'the signalled verdict process to exit',
    );
    assert.equal(code, 130, errors);
    assert.equal(
      existsSync(marker),
      false,
      'SIGTERM must prevent local review readiness',
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
    await waitForProcessExit(
      child,
      'the owned verdict child to exit during cleanup',
    );
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
    const result = await judge(
      f.job,
      sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(result.kind, 'refused');
    assert.ok(
      result.kind === 'refused' &&
        result.findings.includes('evaluator surface changed: krn.checks.json'),
    );
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

test('a check cannot connect to the host user bus', async (t) => {
  if (
    !requiresIsolation(t, 'a check cannot connect to the host user bus', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
  const runtime = systemdEnvironment().XDG_RUNTIME_DIR;
  assert.ok(runtime, 'the systemd runtime directory must be available');
  const bus = join(runtime, 'bus');
  const hostConnection = await new Promise<boolean>((resolve) => {
    const socket = createConnection(bus);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(CONDITION_WAIT_MS, () => {
      socket.destroy();
      resolve(false);
    });
  });
  assert.equal(
    hostConnection,
    true,
    'host user bus must be connectable for this falsifier',
  );
  const f = fixture([
    process.execPath,
    '-e',
    `const {createConnection}=require('node:net');const s=createConnection(${JSON.stringify(bus)});s.once('connect',()=>{s.destroy();process.exit(0)});s.once('error',()=>process.exit(1));s.setTimeout(${CONDITION_WAIT_MS},()=>{s.destroy();process.exit(1)});`,
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
      'fail',
      'sandbox check unexpectedly connected to the host user bus',
    );
    assert.notEqual(result.checks[0]?.exitCode, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a check cannot read a planted file outside its candidate copy', async (t) => {
  if (
    !requiresIsolation(
      t,
      'a check cannot read a planted file outside its candidate copy',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const scratch = join(process.cwd(), '.krn', 'tmp');
  mkdirSync(scratch, { recursive: true });
  const plantedRoot = mkdtempSync(join(scratch, 'krn-verdict-home-probe-'));
  const planted = join(plantedRoot, 'probe');
  const content = `planted-${process.pid}`;
  writeFileSync(planted, content, { flag: 'wx', mode: 0o600 });
  assert.equal(
    readFileSync(planted, 'utf8'),
    content,
    'host probe file must be readable',
  );
  const f = fixture([
    process.execPath,
    '-e',
    `try{require('node:fs').readFileSync(${JSON.stringify(planted)});process.exit(0)}catch{process.exit(1)}`,
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
      'fail',
      'sandbox check unexpectedly read a host file outside its candidate copy',
    );
    assert.notEqual(result.checks[0]?.exitCode, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(plantedRoot, { recursive: true, force: true });
  }
});

test('candidate package manifests are not read through worktree symlinks', async (t) => {
  if (
    !requiresIsolation(
      t,
      'candidate package manifests are not read through worktree symlinks',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = fixture(['/usr/bin/true'], true);
  try {
    rmSync(join(f.root, 'package.json'));
    symlinkSync('missing-manifest-target.json', join(f.root, 'package.json'));
    f.git(['add', 'package.json']);
    f.git(['commit', '-qm', 'symlink package manifest']);
    f.sha = f.git(['rev-parse', 'HEAD']);
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(result.kind, 'refused');
    assert.ok(
      result.kind === 'refused' &&
        result.findings.includes('evaluator surface changed: package.json'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('candidate lockfiles are not read through worktree symlinks', async (t) => {
  if (
    !requiresIsolation(
      t,
      'candidate lockfiles are not read through worktree symlinks',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = fixture(['/usr/bin/true'], true);
  try {
    rmSync(join(f.root, 'pnpm-lock.yaml'));
    symlinkSync('missing-lockfile-target.yaml', join(f.root, 'pnpm-lock.yaml'));
    f.git(['add', 'pnpm-lock.yaml']);
    f.git(['commit', '-qm', 'symlink package lockfile']);
    f.sha = f.git(['rev-parse', 'HEAD']);
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(result.kind, 'refused');
    assert.match(
      result.findings.join(' '),
      /pnpm-lock\.yaml must be a regular Git file/u,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('candidate package manifests have a strict size cap', async (t) => {
  if (
    !requiresIsolation(
      t,
      'candidate package manifests have a strict size cap',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = fixture(['/usr/bin/true'], true);
  try {
    writeFileSync(
      join(f.root, 'package.json'),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );
    f.git(['add', 'package.json']);
    f.git(['commit', '-qm', 'oversize package manifest']);
    f.sha = f.git(['rev-parse', 'HEAD']);
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(result.kind, 'refused');
    assert.ok(
      result.kind === 'refused' &&
        result.findings.includes('evaluator surface changed: package.json'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a check timeout is reported as a timeout', async (t) => {
  if (
    !requiresIsolation(t, 'a check timeout is reported as a timeout', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
  const f = fixture(heldCheck, false, 3000);
  try {
    const result = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(result.kind, 'fail');
    assert.match(result.findings.join(' '), /timed out/iu);
    assert.equal(result.checks[0]?.exitCode, 124);
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

test('the trusted base selects host pnpm while candidate dependencies remain installed', async (t) => {
  if (
    !requiresIsolation(
      t,
      'the trusted base selects host pnpm while candidate dependencies remain installed',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const expectedDependencyVersion = '0.0.2';
  const f = fixture(
    [
      process.execPath,
      '-e',
      `const assert=require('node:assert/strict');const fs=require('node:fs');const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));assert.equal(require('./node_modules/fixture-dependency/package.json').version,${JSON.stringify(expectedDependencyVersion)});if(manifest.name==='workspace-poison-fixture'){const workspace=fs.readFileSync('pnpm-workspace.yaml','utf8');assert.ok(workspace.includes("packages:\\n  - 'packages/*'\\n")&&workspace.includes('storeDir: '),'candidate workspace configuration was not preserved')}assert.equal(fs.existsSync('.krn/pnpm-store/HOST_CANARY'),false,'owned host canary appeared in staged .krn/pnpm-store')`,
    ],
    true,
  );
  const originalPath = process.env.PATH;
  try {
    const state = join(f.root, '.krn', 'tmp', 'manager-tool-fixture');
    const bin = join(state, 'bin');
    const managerA = 'pnpm@9.9.0';
    const managerB = 'pnpm@10.0.0';
    const pnpmA = join(state, 'pnpm-A');
    const pnpmB = join(state, 'pnpm-B');
    assert.notEqual(pnpmA, pnpmB);
    const hostAReceipt = join(state, 'host-a-used');
    const hostBCanary = join(state, 'host-b-canary');
    const hostProbeCwds = join(state, 'host-probe-cwds');
    const hostProbeFailure = join(state, 'host-probe-failure');
    const workspaceCanaryStore = join(state, 'workspace-host-canary', 'store');
    mkdirSync(bin, { recursive: true, mode: 0o700 });

    const managerDirectories = new Map([
      [managerA, pnpmA],
      [managerB, pnpmB],
    ]);
    const mise = join(bin, 'mise');
    writeFileSync(
      mise,
      `#!/usr/bin/env node\nconst tools=${JSON.stringify(Object.fromEntries(managerDirectories))};\nconst [command,manager]=process.argv.slice(2);\nif(command!=='where'||typeof tools[manager]!=='string'){process.stderr.write('unknown fake manager');process.exit(1)}\nprocess.stdout.write(tools[manager]+'\\n');\n`,
      { mode: 0o700 },
    );
    const fakePnpm = (
      directory: string,
      hostReceipt: string,
      version: string,
    ) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const storeArg = args.find((arg) => arg.startsWith('--store-dir='));
if (!storeArg) fs.appendFileSync(${JSON.stringify(hostReceipt)}, args.join(' ') + '\\n');
const workspaceStoreDir = () => {
  let current = process.cwd();
  for (;;) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(marker)) {
      const content = fs.readFileSync(marker, 'utf8');
      const configured = content.match(/^storeDir:\\s*(.+)$/m)?.[1];
      return configured ? path.resolve(current, configured.trim()) : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
if (args.includes('store') && args.includes('path')) {
  if (!storeArg) {
    fs.appendFileSync(${JSON.stringify(hostProbeCwds)}, process.cwd() + '\\n');
    if (fs.existsSync(${JSON.stringify(hostProbeFailure)})) {
      process.stderr.write('forced fake host store probe failure');
      process.exit(1);
    }
  }
  const discoveredStoreDir = storeArg ? undefined : workspaceStoreDir();
  const storeDir = storeArg
    ? storeArg.slice('--store-dir='.length)
    : discoveredStoreDir ?? ${JSON.stringify(join(directory, 'store'))};
  const storePath = path.join(storeDir, 'v3');
  process.stdout.write(storePath + '\\n');
  process.exit(0);
}
if (args.includes('install')) {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = manifest.dependencies?.['fixture-dependency'];
  const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8');
  if (typeof version !== 'string' || !lockfile.includes('version: ' + version)) {
    process.stderr.write('candidate dependency and lockfile disagree');
    process.exit(1);
  }
  fs.mkdirSync('node_modules/fixture-dependency', { recursive: true });
  fs.writeFileSync(
    path.join('node_modules/fixture-dependency', 'package.json'),
    JSON.stringify({ name: 'fixture-dependency', version }),
  );
  process.exit(0);
}
process.stderr.write('unsupported fake pnpm invocation');
process.exit(2);
`;
    for (const [directory, receipt, version] of [
      [pnpmA, hostAReceipt, '9.9.0'],
      [pnpmB, hostBCanary, '10.0.0'],
    ] as const) {
      mkdirSync(join(directory, 'store', 'v3'), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(join(directory, 'store', 'seed'), 'owned offline seed');
      writeFileSync(
        join(directory, 'store', 'v3', 'seed'),
        'owned versioned offline seed',
      );
      writeFileSync(
        join(directory, 'pnpm'),
        fakePnpm(directory, receipt, version),
        { mode: 0o700 },
      );
    }
    mkdirSync(join(workspaceCanaryStore, 'v3'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(workspaceCanaryStore, 'HOST_CANARY'), 'owned canary');
    writeFileSync(
      join(workspaceCanaryStore, 'v3', 'seed'),
      'owned canary versioned store',
    );
    process.env.PATH = [bin, originalPath ?? ''].join(delimiter);

    const packageManifest = (
      packageManager: string,
      dependency: string,
      name = 'manager-selection-fixture',
    ) =>
      `${JSON.stringify(
        {
          name,
          version: '1.0.0',
          packageManager,
          dependencies: { 'fixture-dependency': dependency },
        },
        null,
        2,
      )}\n`;
    const lockfile = (version: string) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture-dependency:\n        specifier: ${version}\n        version: ${version}\npackages:\n  fixture-dependency@${version}: {}\n`;

    writeFileSync(
      join(f.root, 'package.json'),
      packageManifest(managerA, '0.0.1'),
    );
    writeFileSync(join(f.root, 'pnpm-lock.yaml'), lockfile('0.0.1'));
    f.git(['add', 'package.json', 'pnpm-lock.yaml']);
    f.git([
      'commit',
      '-qm',
      'trusted base declares manager A and dependency 0.0.1',
    ]);
    f.base = f.git(['rev-parse', 'HEAD']);

    for (const { packageManager, label } of [
      { packageManager: managerA, label: 'honest manager-A candidate' },
      { packageManager: managerB, label: 'manager-B candidate' },
    ]) {
      if (packageManager === managerB) {
        mkdirSync(join(f.root, 'test'), { recursive: true });
        writeFileSync(
          join(f.root, 'test', 'dependency.test.mjs'),
          `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
test('candidate dependency is 0.0.2', () => {
  assert.equal(
    require('../node_modules/fixture-dependency/package.json').version,
    '0.0.2',
  );
});
`,
        );
      }
      writeFileSync(
        join(f.root, 'package.json'),
        packageManifest(packageManager, expectedDependencyVersion),
      );
      writeFileSync(
        join(f.root, 'pnpm-lock.yaml'),
        lockfile(expectedDependencyVersion),
      );
      f.git([
        'add',
        'package.json',
        'pnpm-lock.yaml',
        ...(packageManager === managerB ? ['test/dependency.test.mjs'] : []),
      ]);
      f.git(['commit', '-qm', label]);
      f.sha = f.git(['rev-parse', 'HEAD']);
      rmSync(hostAReceipt, { force: true });
      rmSync(hostBCanary, { force: true });

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
        `${label} must install/check its candidate dependency: ${result.kind === 'pass' ? '' : result.findings.join('; ')}`,
      );
      assert.equal(
        existsSync(hostBCanary),
        false,
        `${label}: candidate manager B must not run as a host tool`,
      );
      assert.equal(
        existsSync(hostAReceipt),
        true,
        `${label}: trusted base manager A must run the host store probe`,
      );

      if (packageManager === managerB) {
        rmSync(hostAReceipt, { force: true });
        rmSync(hostBCanary, { force: true });
        const report = await redFirst(f.root, f.base, f.sha);
        assert.deepEqual(
          report.results.map(({ side, classification }) => [
            side,
            classification,
          ]),
          [
            ['base', 'assertion'],
            ['head', 'pass'],
          ],
          JSON.stringify(report.results),
        );
        assert.equal(
          existsSync(hostBCanary),
          false,
          'red-first must not use candidate manager B as a host tool',
        );
        assert.equal(
          readFileSync(hostAReceipt, 'utf8')
            .trim()
            .split('\n')
            .filter((call) => call === 'store path').length,
          2,
          'red-first base and head checks must each probe trusted manager A',
        );
      }
    }

    const workspaceConfig = `packages:\n  - 'packages/*'\nstoreDir: ${workspaceCanaryStore}\n`;
    writeFileSync(
      join(f.root, 'package.json'),
      packageManifest(
        managerB,
        expectedDependencyVersion,
        'workspace-poison-fixture',
      ),
    );
    writeFileSync(
      join(f.root, 'pnpm-lock.yaml'),
      lockfile(expectedDependencyVersion),
    );
    writeFileSync(join(f.root, 'pnpm-workspace.yaml'), workspaceConfig);
    f.git(['add', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
    f.git(['commit', '-qm', 'candidate workspace selects owned host canary']);
    f.sha = f.git(['rev-parse', 'HEAD']);
    rmSync(hostAReceipt, { force: true });
    rmSync(hostBCanary, { force: true });
    rmSync(hostProbeCwds, { force: true });
    const workspacePoison = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    const diagnosticDirectory = join(
      f.root,
      '.krn',
      'runs',
      'foreman',
      f.job.id,
      'diagnostics',
    );
    const diagnostic = existsSync(diagnosticDirectory)
      ? readdirSync(diagnosticDirectory)
          .map((name) => readFileSync(join(diagnosticDirectory, name), 'utf8'))
          .join('\n')
      : '';
    assert.equal(
      workspacePoison.kind,
      'pass',
      `workspace-poison candidate must retain dependency 0.0.2 without staging HOST_CANARY: ${workspacePoison.kind === 'pass' ? '' : workspacePoison.findings.join('; ')}\n${diagnostic}`,
    );
    assert.equal(
      existsSync(hostBCanary),
      false,
      'workspace-poison candidate must not run candidate manager B as a host tool',
    );
    assert.equal(
      existsSync(hostAReceipt),
      true,
      'workspace-poison candidate must use trusted base manager A for host store discovery',
    );
    const successfulProbeCwds = readFileSync(hostProbeCwds, 'utf8')
      .trim()
      .split('\n');
    assert.equal(successfulProbeCwds.length, 1);
    const [successfulProbeCwd] = successfulProbeCwds;
    assert.ok(successfulProbeCwd);
    assert.ok(
      successfulProbeCwd.startsWith(`${join(f.root, '.krn', 'tmp')}/`),
      'host store query must use an owned probe under repository state/tmp',
    );
    assert.equal(
      existsSync(successfulProbeCwd),
      false,
      'successful host store query must remove its private probe',
    );

    writeFileSync(hostProbeFailure, 'force host query error');
    rmSync(hostProbeCwds, { force: true });
    const failedHostProbe = await judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
    );
    assert.equal(
      failedHostProbe.kind,
      'refused',
      JSON.stringify(failedHostProbe),
    );
    assert.ok(
      failedHostProbe.kind === 'refused' &&
        failedHostProbe.findings.some((finding) =>
          finding.includes('forced fake host store probe failure'),
        ),
      'host query failure must remain visible after probe cleanup',
    );
    const failedProbeCwds = readFileSync(hostProbeCwds, 'utf8')
      .trim()
      .split('\n');
    assert.equal(failedProbeCwds.length, 1);
    const [failedProbeCwd] = failedProbeCwds;
    assert.ok(failedProbeCwd);
    assert.ok(
      failedProbeCwd.startsWith(`${join(f.root, '.krn', 'tmp')}/`),
      'failed host store query must use an owned probe under repository state/tmp',
    );
    assert.equal(
      existsSync(failedProbeCwd),
      false,
      'failed host store query must remove its private probe',
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
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
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify("require('node:fs').watch('.',()=>{})")}],{detached:true,stdio:'ignore'});child.unref();`;
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
  const f = fixture(heldCheck);
  const controller = new AbortController();
  let judging: ReturnType<typeof judge> | undefined;
  try {
    judging = judge(
      f.job,
      f.sha,
      f.base,
      ['declared'],
      async () => {},
      controller.signal,
    );
    const copy = await waitForRunningCheck(f.root);
    f.git(['commit', '--allow-empty', '-qm', 'moved']);
    writeFileSync(join(copy, 'check-release'), 'release');
    const result = await judging;
    assert.equal(result.kind, 'refused');
    assert.match(result.findings.join(' '), /HEAD changed/u);
  } finally {
    controller.abort();
    await judging;
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} during a verdict removes its registered check worktree`, {
    timeout: conditionTimeoutFor(3),
  }, async (t) => {
    if (
      !requiresIsolation(
        t,
        `${signal} during a verdict removes its registered check worktree`,
        ['bwrap', 'systemdUserScope'],
      )
    )
      return;
    const f = fixture(heldCheck);
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
    let checkWorktree: string | undefined;
    try {
      checkWorktree = await waitForRunningCheck(f.root);
      child.kill(signal);
      await waitForProcessExit(
        child,
        `the verdict process to exit after ${signal}`,
      );
      await waitForCondition(
        () => (registeredWorktree(f.root) === undefined ? true : undefined),
        `${signal} to remove its registered check worktree`,
      );
      assert.equal(
        existsSync(checkWorktree),
        false,
        'the detached check directory must also be removed',
      );
      const worktrees = spawnSync(
        'git',
        ['-C', f.root, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' },
      ).stdout;
      assert.ok(
        worktrees.includes(staleDecoy),
        'verdict cleanup pruned an unrelated stale worktree',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await waitForProcessExit(
        child,
        'the owned verdict child to exit during cleanup',
      );
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

test('cancellation accounts for the owned scope and all remaining check processes', {
  timeout: conditionTimeoutFor(3),
}, async (t) => {
  if (
    !requiresIsolation(t, 'canonical scope cancellation', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
  const f = fixture([
    '/bin/sh',
    '-c',
    'mkfifo check-input; (echo ready > descendant-ready; exec cat check-input) & wait',
  ]);
  const controller = new AbortController();
  const env = systemdEnvironment();
  let scope: string | undefined;
  let execution: Promise<unknown> | undefined;
  const originalSpawn = childProcess.spawn;
  // Observe the actual created unit; dispatch every command to the real host.
  const observer = mock.method(
    childProcess,
    'spawn',
    (...args: Parameters<typeof spawn>) => {
      if (args[0] === 'systemd-run' && Array.isArray(args[1])) {
        const unit = args[1][args[1].indexOf('--unit') + 1];
        assert.ok(unit);
        scope = unit.endsWith('.scope') ? unit : `${unit}.scope`;
      }
      return originalSpawn(...args);
    },
  );
  syncBuiltinESMExports();
  const show = (unit: string) => {
    const result = spawnSync(
      'systemctl',
      [
        '--user',
        'show',
        '--property=ActiveState',
        '--property=ControlGroup',
        '--no-pager',
        unit,
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(typeof parseSystemdScopeProperties, 'function');
    const properties = parseSystemdScopeProperties(result.stdout);
    assert.ok(properties, `invalid named systemd properties: ${result.stdout}`);
    const { activeState: state, controlGroup: group } = properties;
    let pids: string[] = [];
    if (group) {
      try {
        pids = readFileSync(`/sys/fs/cgroup${group}/cgroup.procs`, 'utf8')
          .trim()
          .split(/\s+/u)
          .filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { state, pids };
  };
  try {
    // Drain rejection during cleanup too, including assertion failures.
    execution = execute(
      f.root,
      f.root,
      f.job,
      'declared',
      [
        '/bin/sh',
        '-c',
        'mkfifo check-input; (echo ready > descendant-ready; exec cat check-input) & wait',
      ],
      2 * CONDITION_WAIT_MS,
      f.sha,
      controller.signal,
      f.base,
    ).catch((error: unknown) => error);
    const activePids = await waitForCondition(() => {
      if (!scope) return undefined;
      const actual = show(scope);
      return actual.state === 'active' &&
        actual.pids.length >= 3 &&
        existsSync(join(f.root, 'descendant-ready'))
        ? actual.pids
        : undefined;
    }, 'the active owned check scope with wrapper, check and descendant PIDs');
    assert.ok(scope, 'must observe the scope created by this check');
    assert.ok(
      activePids.length >= 3,
      'must observe wrapper, check and descendant in the owned cgroup',
    );
    assert.deepEqual(
      show(scope.replace(/\.scope$/u, '.service')),
      { state: 'inactive', pids: [] },
      'absent .service differs from the active owned .scope',
    );
    controller.abort();
    const ownedScope = scope;
    await waitForCondition(() => {
      const actual = show(ownedScope);
      return actual.state === 'inactive' && actual.pids.length === 0
        ? true
        : undefined;
    }, 'the cancelled owned scope to become inactive with no member PIDs');
    assert.deepEqual(
      show(scope),
      { state: 'inactive', pids: [] },
      'cancellation must kill and verify the owned .scope, not the absent .service',
    );
    const result = await execution;
    assert.ok(result instanceof Error);
    assert.equal(result.message, 'stopped');
    // An empty cgroup can precede child close/reaping by a scheduler turn.
    await waitForCondition(
      () =>
        activePids.every((pid) => !existsSync(`/proc/${pid}`))
          ? true
          : undefined,
      `all owned check PIDs to be reaped: ${activePids.join(', ')}`,
    );
    for (const pid of activePids)
      assert.equal(
        existsSync(`/proc/${pid}`),
        false,
        `owned check PID ${pid} must be reaped`,
      );
  } finally {
    if (scope)
      spawnSync(
        'systemctl',
        ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', scope],
        { env, stdio: 'ignore' },
      );
    controller.abort();
    await execution;
    observer.mock.restore();
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const killActualScope of [false, true]) {
  test(killActualScope
    ? 'missing unit after actual sandbox cleanup is confirmed by the original cgroup'
    : 'missing unit output cannot confirm sandbox teardown while the original scope lives', {
    timeout: conditionTimeoutFor(2),
  }, async (t) => {
    if (
      !requiresIsolation(t, 'missing unit with live sandbox scope', [
        'bwrap',
        'systemdUserScope',
      ])
    )
      return;
    const f = fixture(heldCheck);
    const controller = new AbortController();
    const env = systemdEnvironment();
    let scope: string | undefined;
    let launcher: ChildProcess | undefined;
    let hideUnit = false;
    let execution: Promise<unknown> | undefined;
    const originalSpawn = childProcess.spawn;
    const observer = mock.method(
      childProcess,
      'spawn',
      (...args: Parameters<typeof spawn>) => {
        if (args[0] === 'systemd-run' && Array.isArray(args[1])) {
          scope = args[1][args[1].indexOf('--unit') + 1];
          launcher = originalSpawn(...args);
          return launcher;
        }
        if (
          hideUnit &&
          args[0] === 'systemctl' &&
          Array.isArray(args[1]) &&
          scope &&
          args[1].includes(scope)
        ) {
          const show = args[1].includes('show');
          if (!show && killActualScope) return originalSpawn(...args);
          return originalSpawn(
            '/bin/sh',
            [
              '-c',
              show
                ? "printf 'Unit could not be found.\\n' >&2; exit 1"
                : 'exit 0',
            ],
            args[2],
          );
        }
        return originalSpawn(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      execution = execute(
        f.root,
        f.root,
        f.job,
        'declared',
        heldCheck,
        2 * CONDITION_WAIT_MS,
        f.sha,
        controller.signal,
        f.base,
      ).catch((error: unknown) => error);
      await waitForCondition(
        () => (existsSync(join(f.root, 'check-ready')) ? true : undefined),
        'the owned sandbox check to be running',
      );
      assert.ok(scope);
      assert.ok(launcher?.pid);
      const originalGroup = readFileSync(`/proc/${launcher.pid}/cgroup`, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3);
      assert.ok(originalGroup?.endsWith(`/${scope}`));
      hideUnit = true;
      controller.abort();
      // Only failed teardown verification terminates the launcher as fallback.
      if (!killActualScope)
        await waitForCondition(
          () => (launcher?.signalCode === 'SIGTERM' ? true : undefined),
          'unverified teardown to stop the sandbox launcher',
          10000,
        );
      const result = await execution;
      assert.ok(result instanceof Error);
      if (killActualScope)
        assert.equal(
          result.message,
          'stopped',
          'the original cgroup independently confirms successful cancellation',
        );
      else
        assert.match(
          result.message,
          /teardown_unconfirmed/u,
          'a missing unit must never be accepted as a stopped, cleaned check',
        );
    } finally {
      hideUnit = false;
      if (scope)
        spawnSync(
          '/usr/bin/systemctl',
          ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', scope],
          { env, stdio: 'ignore' },
        );
      controller.abort();
      await execution;
      observer.mock.restore();
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('sandbox teardown property and cgroup readers reject malformed evidence', () => {
  for (const [name, reader] of Object.entries({
    parseSystemdScopeProperties,
    scopePids,
    scopeReadbackIsDrained,
  }))
    assert.equal(typeof reader, 'function', `${name} must be exported`);
  assert.deepEqual(
    parseSystemdScopeProperties(
      'ControlGroup=/user.slice/user-1000.slice/app.slice/krn-captured.scope\nActiveState=active\n',
    ),
    {
      activeState: 'active',
      controlGroup: '/user.slice/user-1000.slice/app.slice/krn-captured.scope',
    },
    'captured systemd 257 ControlGroup-first output preserves names',
  );
  assert.deepEqual(
    parseSystemdScopeProperties('ControlGroup=\nActiveState=inactive\n'),
    { activeState: 'inactive', controlGroup: '' },
    'captured post-GC output preserves empty ControlGroup',
  );
  assert.equal(
    parseSystemdScopeProperties('ControlGroup=\nActiveState=deactivating\n')
      ?.activeState,
    'deactivating',
    'transitional state is preserved for teardown to treat as unresolved',
  );
  for (const malformed of [
    'ActiveState=inactive\n',
    'ControlGroup=\nActiveState=inactive\nActiveState=failed\n',
    'ControlGroup=\nActiveState=inactive\nUnknown=value\n',
  ])
    assert.equal(
      parseSystemdScopeProperties(malformed),
      undefined,
      `malformed named properties must fail closed: ${malformed}`,
    );

  assert.deepEqual(scopePids(''), [], 'a named empty cgroup is empty');
  for (const invalid of [
    'active',
    '/user.slice/../outside',
    '/../../tmp/forged.scope',
  ])
    assert.throws(
      () => scopePids(invalid),
      /invalid cgroup path/u,
      `teardown must reject malformed or traversal cgroup paths: ${invalid}`,
    );

  const emptyOutput = Buffer.alloc(0);
  assert.equal(
    scopeReadbackIsDrained(
      0,
      { activeState: 'inactive', controlGroup: '' },
      [],
      emptyOutput,
      emptyOutput,
    ),
    true,
    'inactive plus an empty cgroup confirms drain',
  );
  assert.equal(
    scopeReadbackIsDrained(
      0,
      { activeState: 'unknown', controlGroup: '' },
      [],
      emptyOutput,
      emptyOutput,
    ),
    false,
    'unknown ActiveState is not proof of drain',
  );
  assert.equal(
    scopeReadbackIsDrained(
      0,
      {
        activeState: 'inactive',
        controlGroup: '/user.slice/user-1000.slice/app.slice/krn-live.scope',
      },
      [1234],
      emptyOutput,
      emptyOutput,
    ),
    false,
    'a live cgroup member prevents a drained result even with inactive state',
  );
  assert.equal(
    scopeReadbackIsDrained(
      1,
      undefined,
      [],
      emptyOutput,
      Buffer.from('Unit was not loaded'),
    ),
    false,
    'a missing unit without original cgroup evidence remains unverified',
  );
  for (const originalActive of [true, null, false]) {
    assert.equal(
      scopeReadbackIsDrained(
        1,
        undefined,
        [],
        emptyOutput,
        Buffer.from('Unit was not loaded'),
        originalActive,
      ),
      originalActive === false,
      `missing unit requires independent absence, original state=${originalActive}`,
    );
  }
  assert.equal(
    scopeReadbackIsDrained(
      1,
      undefined,
      [],
      Buffer.from('unexpected output'),
      Buffer.from('Unit was not loaded'),
    ),
    false,
    'unexpected stdout prevents not-found from proving drain',
  );
  assert.equal(
    scopeReadbackIsDrained(
      1,
      undefined,
      [1234],
      emptyOutput,
      Buffer.from('Unit was not loaded'),
    ),
    false,
    'an observed member prevents not-found from proving drain',
  );
  assert.equal(
    scopeReadbackIsDrained(
      null,
      undefined,
      [],
      emptyOutput,
      Buffer.from('Unit was not loaded'),
    ),
    false,
    'missing process exit status is not proof of an absent scope',
  );
});
