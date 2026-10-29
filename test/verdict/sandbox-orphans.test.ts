import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execute } from '../../src/verdict/sandbox.ts';
import {
  CONDITION_WAIT_MS,
  conditionTimeoutFor,
} from '../helpers/condition-wait.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const checkTimeoutMs = conditionTimeoutFor(1);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'krn-sandbox-orphans-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Sandbox orphan test']);
  git(['config', 'user.email', 'sandbox-orphan@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.krn/\n');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'sandbox fixture']);
  const sha = git(['rev-parse', 'HEAD']);
  const job = {
    id: randomUUID(),
    issue: 'sandbox-orphans',
    worktree: root,
    repoRoot: root,
  };
  return { root, job, sha };
}

function program(root: string, source: string): string {
  const path = join(root, 'orphan.test.mjs');
  writeFileSync(path, source, { flag: 'wx', mode: 0o600 });
  return path;
}

async function check(
  root: string,
  job: ReturnType<typeof fixture>['job'],
  sha: string,
  id: string,
) {
  return execute(
    root,
    root,
    job,
    id,
    [process.execPath, '--test', 'orphan.test.mjs'],
    checkTimeoutMs,
    sha,
    undefined,
    sha,
  );
}

function diagnostic(root: string, jobId: string, id: string): string {
  const directory = join(root, '.krn', 'runs', 'foreman', jobId, 'diagnostics');
  const name = readdirSync(directory).find((entry) =>
    entry.includes(`-${id}-`),
  );
  assert.ok(name, 'the isolated check output must be captured');
  return readFileSync(join(directory, name), 'utf8');
}

function waitForSource(): string {
  return `const protocolDeadline = Date.now() + ${CONDITION_WAIT_MS};
  const waitFor = async (read, description) => {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() >= protocolDeadline) throw new Error('Timed out waiting for ' + description);
      await new Promise(setImmediate);
    }
  };`;
}

function processInfoSource(): string {
  return `const processInfo = (pid) => {
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { state: fields[0], parent: Number(fields[1]) };
    } catch { return undefined; }
  };`;
}

test('a completed detached child does not change a passing test exit', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const leafSource = [
    "const fs = require('node:fs');",
    "process.on('SIGUSR1', () => process.exit(0));",
    "fs.watch('.', () => {});",
    "fs.writeFileSync('orphan-ready', 'ready');",
  ].join('\n');
  const creatorSource = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(leafSource)}], { detached: true, stdio: 'ignore' });`,
    "require('node:fs').writeFileSync('orphan-pid', String(child.pid));",
    'child.unref();',
  ].join('\n');
  program(
    f.root,
    `import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
${waitForSource()}
${processInfoSource()}
test('a reaped child is a zombie before the check exits', async () => {
  assert.equal(execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim(), ${JSON.stringify(f.sha)});
  const creator = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(creatorSource)}], { detached: true, stdio: 'ignore' });
  creator.unref();
  const pid = await waitFor(() => {
    try {
      const marker = readFileSync('orphan-pid', 'utf8').trim();
      if (!/^[1-9]\\d*$/u.test(marker)) return undefined;
      const value = Number(marker);
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }, 'the detached child PID');
  await waitFor(() => existsSync('orphan-ready') ? true : undefined, 'the detached child readiness marker');
  await waitFor(() => {
    const info = processInfo(pid);
    return info?.parent === 1 && info.state !== 'Z' ? info : undefined;
  }, 'the live child to be adopted by namespace PID 1');
  process.kill(pid, 'SIGUSR1');
  const zombie = await waitFor(() => {
    const info = processInfo(pid);
    return info?.parent === 1 && info.state === 'Z' ? info : undefined;
  }, 'the adopted child to exit');
  assert.equal(zombie.state, 'Z');
  assert.equal(zombie.parent, 1);
});
`,
  );
  const id = randomUUID();

  const result = await check(f.root, f.job, f.sha, id);

  assert.equal(result.exitCode, 0, diagnostic(f.root, f.job.id, id));
  assert.match(diagnostic(f.root, f.job.id, id), /pass 1/u);
});

test('a live detached child is killed and rejected', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const leafSource = [
    "const fs = require('node:fs');",
    "process.on('SIGUSR1', () => process.exit(0));",
    "fs.watch('.', () => {});",
    "fs.writeFileSync('live-ready.tmp', 'ready');",
    "fs.renameSync('live-ready.tmp', 'live-ready');",
  ].join('\n');
  program(
    f.root,
    `import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
${waitForSource()}
test('a detached process stays alive after its passing test exits', async () => {
  assert.equal(execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim(), ${JSON.stringify(f.sha)});
  const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(leafSource)}], { detached: true, stdio: 'ignore' });
  child.unref();
  await waitFor(() => existsSync('live-ready') ? true : undefined, 'the detached child readiness marker');
  assert.equal(readFileSync('live-ready', 'utf8'), 'ready');
});
`,
  );
  const id = randomUUID();

  const result = await check(f.root, f.job, f.sha, id);

  assert.equal(result.exitCode, 125, diagnostic(f.root, f.job.id, id));
  assert.match(diagnostic(f.root, f.job.id, id), /pass 1/u);
});

test('an assertion failure keeps its nonzero test exit', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  program(
    f.root,
    `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('a failing assertion remains a failure', () => assert.equal(1, 2));
`,
  );
  const id = randomUUID();

  const result = await check(f.root, f.job, f.sha, id);

  assert.equal(result.exitCode, 1, diagnostic(f.root, f.job.id, id));
  assert.match(diagnostic(f.root, f.job.id, id), /ERR_ASSERTION/u);
});
