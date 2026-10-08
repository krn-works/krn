import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runReview } from '../../src/flow/index.ts';
import { parseJudgeResponse } from '../../src/flow/panel.ts';
import { appendOverride } from '../../src/flow/record.ts';
import { redFirst } from '../../src/flow/repository.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(parent = tmpdir()): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'krn-review-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeCodex(
  directory: string,
  response: string,
  options: { readonly completeTurn?: boolean } = {},
): { readonly executable: string; readonly argsFile: string } {
  const executable = join(directory, 'fake-codex.mjs');
  const argsFile = join(directory, 'codex-args.json');
  const encoded = JSON.stringify(response);
  const completion =
    options.completeTurn === false
      ? ''
      : "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}})+'\\n');";
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nlet prompt=''; for await (const chunk of process.stdin) prompt += chunk;\nwriteFileSync(process.env.KRN_REVIEW_ARGS, JSON.stringify(process.argv.slice(2)));\nconst text=${encoded};\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');\n${completion}\n`,
  );
  chmodSync(executable, 0o700);
  process.env.KRN_REVIEW_ARGS = argsFile;
  return { executable, argsFile };
}

test('mechanical red-first distinguishes assertion failures from missing imports', () => {
  const { root, cleanup } = fixture(join(process.cwd(), '.krn', 'tmp'));
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'test'));
    writeFileSync(
      join(root, 'test', 'assert.test.ts'),
      "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('assertion', () => assert.equal(1, 2));\n",
    );
    writeFileSync(
      join(root, 'test', 'import.test.ts'),
      "import '../src/missing-module.ts';\n",
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'add failing tests');
    const head = git(root, 'rev-parse', 'HEAD');
    const report = redFirst(root, base, head);
    assert.deepEqual(
      report.results.map(({ classification }) => classification),
      ['assertion', 'procedural'],
      JSON.stringify(report.results),
    );
  } finally {
    cleanup();
  }
});

test('red-first contains detached tests and blocks their network access', async () => {
  const { root, cleanup } = fixture(join(process.cwd(), '.krn', 'tmp'));
  const portFile = join(root, 'probe.port');
  const hitFile = join(root, 'probe.hit');
  let server: ReturnType<typeof spawn> | undefined;
  let serverClosed: Promise<void> | undefined;
  try {
    const serverFile = join(root, 'network-server.mjs');
    writeFileSync(
      serverFile,
      `import { createServer } from 'node:http';\nimport { writeFileSync } from 'node:fs';\nconst server=createServer((_request,response)=>{writeFileSync(process.env.KRN_PROBE_HIT,'hit');response.end('reachable');});\nserver.listen(0,'127.0.0.1',()=>writeFileSync(process.env.KRN_PROBE_PORT,String(server.address().port)));\nsetInterval(()=>{},1000);\n`,
    );
    server = spawn(process.execPath, [serverFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        KRN_PROBE_PORT: portFile,
        KRN_PROBE_HIT: hitFile,
      },
    });
    server.stderr?.resume();
    serverClosed = new Promise((resolveClose) =>
      server?.once('close', () => resolveClose()),
    );
    const port = Number(await waitForFile(portFile));
    const target = `http://127.0.0.1:${port}/probe`;
    const base = git(root, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'test'));
    writeFileSync(
      join(root, 'test', 'sandbox.test.ts'),
      [
        "import assert from 'node:assert/strict';",
        "import { spawn } from 'node:child_process';",
        "import { existsSync, readFileSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "import { test } from 'node:test';",
        `const target=${JSON.stringify(target)};`,
        "test('red-first confines test execution', async () => {",
        "  const marker=join(dirname(fileURLToPath(import.meta.url)),'network-result');",
        "  const code='const fs=require(\"node:fs\"); fetch('+JSON.stringify(target)+',{signal:AbortSignal.timeout(1000)}).then(()=>fs.writeFileSync('+JSON.stringify(marker)+',\"reached\"),()=>fs.writeFileSync('+JSON.stringify(marker)+',\"blocked\")); setTimeout(()=>process.exit(0),1800);';",
        "  const child=spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}); child.unref();",
        '  const deadline=Date.now()+3000; while(!existsSync(marker)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));',
        "  assert.equal(readFileSync(marker,'utf8'),'blocked'); console.log('NETWORK_BLOCKED');",
        '});',
        '',
      ].join('\n'),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'add sandbox probe');
    const head = git(root, 'rev-parse', 'HEAD');
    const before = populatedCheckScopes();
    const report = redFirst(root, base, head);
    assert.equal(
      report.results[0]?.classification,
      'other',
      JSON.stringify(report.results[0]),
    );
    assert.match(report.results[0]?.summary ?? '', /NETWORK_BLOCKED/u);
    assert.match(
      report.results[0]?.summary ?? '',
      /detached check processes remained/u,
    );
    assert.equal(
      existsSync(hitFile),
      false,
      'red-first test reached host network',
    );
    assert.deepEqual(
      [...populatedCheckScopes()].filter((unit) => !before.has(unit)),
      [],
    );
  } finally {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1900));
    if (server?.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await serverClosed;
    }
    cleanup();
  }
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  assert.fail(`timed out waiting for ${path}`);
}

function populatedCheckScopes(): Set<string> {
  const listed = spawnSync(
    'systemctl',
    [
      '--user',
      'list-units',
      '--all',
      '--type=scope',
      '--no-pager',
      '--output=json',
    ],
    { encoding: 'utf8', env: systemdEnvironment() },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const scopes: unknown = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(scopes));
  const populated = new Set<string>();
  for (const scope of scopes) {
    if (
      typeof scope?.unit !== 'string' ||
      !scope.unit.startsWith('krn-check-') ||
      scope.active !== 'active'
    )
      continue;
    const shown = spawnSync(
      'systemctl',
      ['--user', 'show', scope.unit, '--property=ControlGroup', '--value'],
      { encoding: 'utf8', env: systemdEnvironment() },
    );
    const cgroup = shown.stdout.trim();
    if (!cgroup.startsWith('/')) continue;
    try {
      if (
        /^populated 1$/mu.test(
          readFileSync(join('/sys/fs/cgroup', cgroup, 'cgroup.events'), 'utf8'),
        )
      )
        populated.add(scope.unit);
    } catch {}
  }
  return populated;
}

test('a judge response without a verdict cannot be parsed into a review record', () => {
  assert.throws(() => parseJudgeResponse('{"findings":[]}'));
});

test('panel launcher forces read-only and a lead override is appended after FAIL', async () => {
  const { root, cleanup } = fixture();
  const priorArgs = process.env.KRN_REVIEW_ARGS;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance and operational behaviour.\n');
    const response = JSON.stringify({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'BLOCKING',
          title: 'Defect',
          path: 'src.ts',
          line: 1,
          defect: 'Acceptance is broken.',
          fix: 'Correct the condition.',
        },
      ],
    });
    const fake = fakeCodex(root, response);
    assert.throws(() =>
      appendOverride(root, head, {
        reason: 'before verdict',
        evidence: 'missing record',
      }),
    );
    const record = await runReview({
      repo: root,
      base,
      head,
      lens,
      panel: ['standards'],
      codexExecutable: fake.executable,
      timeoutMs: 30000,
    });
    assert.equal(record.judges[0]?.state, 'complete');
    if (record.judges[0]?.state === 'complete')
      assert.equal(record.judges[0].verdict, 'FAIL');
    const args = JSON.parse(readFileSync(fake.argsFile, 'utf8')) as string[];
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    const updated = appendOverride(root, head, {
      reason: 'accepted residual risk',
      evidence: 'verified in the follow-up probe',
    });
    assert.equal(updated.override?.reason, 'accepted residual risk');
    assert.equal(updated.headSha, head);
  } finally {
    if (priorArgs === undefined) delete process.env.KRN_REVIEW_ARGS;
    else process.env.KRN_REVIEW_ARGS = priorArgs;
    cleanup();
  }
});

test('an invalid judge verdict is recorded incomplete', async () => {
  const { root, cleanup } = fixture();
  const priorArgs = process.env.KRN_REVIEW_ARGS;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance.\n');
    const fake = fakeCodex(root, '{"findings":[]}');
    const record = await runReview({
      repo: root,
      base,
      head,
      lens,
      panel: ['spec'],
      codexExecutable: fake.executable,
    });
    assert.equal(record.judges[0]?.state, 'incomplete');
    assert.equal(record.panelVerdict, 'INCOMPLETE');
    assert.ok(
      readFileSync(
        join(root, '.krn', 'runs', 'review', head, 'record.json'),
        'utf8',
      ),
    );
  } finally {
    if (priorArgs === undefined) delete process.env.KRN_REVIEW_ARGS;
    else process.env.KRN_REVIEW_ARGS = priorArgs;
    cleanup();
  }
});

test('PASS agent message without turn.completed is recorded incomplete', async () => {
  const { root, cleanup } = fixture();
  const priorArgs = process.env.KRN_REVIEW_ARGS;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance.\n');
    const fake = fakeCodex(root, '{"verdict":"PASS","findings":[]}', {
      completeTurn: false,
    });
    const record = await runReview({
      repo: root,
      base,
      head,
      lens,
      panel: ['spec'],
      codexExecutable: fake.executable,
    });
    const persisted = JSON.parse(
      readFileSync(
        join(root, '.krn', 'runs', 'review', head, 'record.json'),
        'utf8',
      ),
    ) as {
      readonly panelVerdict: string;
      readonly judges: readonly {
        readonly state: string;
        readonly verdict?: string;
      }[];
    };
    assert.equal(persisted.judges[0]?.state, 'incomplete');
    assert.equal(persisted.judges[0]?.verdict, undefined);
    assert.equal(persisted.panelVerdict, 'INCOMPLETE');
    assert.equal(record.judges[0]?.state, 'incomplete');
  } finally {
    if (priorArgs === undefined) delete process.env.KRN_REVIEW_ARGS;
    else process.env.KRN_REVIEW_ARGS = priorArgs;
    cleanup();
  }
});

test('real SIGTERM cancels the judge scope and exits 130 without a review record', async () => {
  const { root, cleanup } = fixture();
  const pidFile = join(root, 'judge.pid');
  let reviewProcess: ReturnType<typeof spawn> | undefined;
  let judgePid: number | undefined;
  let judgeUnit: string | undefined;
  let judgeCgroup: string | undefined;
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'review target');
    const head = git(root, 'rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Check acceptance.\n');
    const fake = join(root, 'slow-codex.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.KRN_REVIEW_PID_FILE, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    chmodSync(fake, 0o700);
    const runner = join(root, 'review-parent.mjs');
    writeFileSync(
      runner,
      `import { reviewCommand } from ${JSON.stringify(new URL('../../src/flow/cli.ts', import.meta.url).href)};\nawait reviewCommand(process.argv.slice(2), { codexExecutable: process.env.KRN_REVIEW_CODEX });\n`,
    );
    const child = spawn(
      process.execPath,
      [
        runner,
        '--repo',
        root,
        '--base',
        base,
        '--head',
        head,
        '--lens',
        lens,
        '--panel',
        'standards',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          KRN_REVIEW_CODEX: fake,
          KRN_REVIEW_PID_FILE: pidFile,
        },
      },
    );
    reviewProcess = child;
    let stderr = '';
    child.stderr
      ?.setEncoding('utf8')
      .on('data', (chunk: string) => (stderr += chunk));
    const closed = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveClose) =>
      child.once('close', (code, signal) => resolveClose({ code, signal })),
    );
    const deadline = Date.now() + 10000;
    while (!existsSync(pidFile) && Date.now() < deadline)
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    assert.ok(existsSync(pidFile), `fake judge did not start: ${stderr}`);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    judgePid = pid;
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3);
    const unit = cgroup?.split('/').at(-1);
    judgeCgroup = cgroup;
    judgeUnit = unit;
    assert.match(unit ?? '', /^krn-repo-[A-Za-z0-9-]+\.scope$/u);
    assert.equal(child.kill('SIGTERM'), true);
    const result = await closed;
    assert.deepEqual(result, { code: 130, signal: null }, stderr);
    assert.equal(isProcessAlive(pid), false);
    assertScopeIsEmpty(unit as string, cgroup as string);
    assert.equal(
      existsSync(join(root, '.krn', 'runs', 'review', head, 'record.json')),
      false,
    );
  } finally {
    if (reviewProcess?.exitCode === null && reviewProcess.signalCode === null) {
      reviewProcess.kill('SIGKILL');
      await new Promise<void>((resolveClose) =>
        reviewProcess?.once('close', () => resolveClose()),
      );
    }
    if (judgeUnit && judgePid !== undefined && isProcessAlive(judgePid)) {
      spawnSync(
        'systemctl',
        ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', judgeUnit],
        { encoding: 'utf8', env: systemdEnvironment() },
      );
      const until = Date.now() + 5000;
      while (
        (isProcessAlive(judgePid) || scopeIsPopulated(judgeCgroup)) &&
        Date.now() < until
      )
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      if (judgeCgroup) assertScopeIsEmpty(judgeUnit, judgeCgroup);
    }
    cleanup();
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return (
      stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    );
  } catch {
    return false;
  }
}

function assertScopeIsEmpty(unit: string, cgroup: string): void {
  const eventsPath = join('/sys/fs/cgroup', cgroup, 'cgroup.events');
  if (existsSync(eventsPath))
    assert.match(
      readFileSync(eventsPath, 'utf8'),
      /^populated 0$/mu,
      `${unit} still has processes`,
    );
  const state = spawnSync(
    'systemctl',
    ['--user', 'show', unit, '--property=ActiveState', '--value'],
    { encoding: 'utf8', env: systemdEnvironment() },
  );
  assert.ok(
    state.status !== 0 || state.stdout.trim() !== 'active',
    `${unit} is still active`,
  );
}

function systemdEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
  };
}

function scopeIsPopulated(cgroup: string | undefined): boolean {
  if (!cgroup) return false;
  try {
    return /^populated 1$/mu.test(
      readFileSync(join('/sys/fs/cgroup', cgroup, 'cgroup.events'), 'utf8'),
    );
  } catch {
    return false;
  }
}
