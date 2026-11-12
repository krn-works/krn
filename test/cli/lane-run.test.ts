import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { laneBriefText, startLane, WORKER_RULES } from '../../src/cli/lane.ts';
import {
  laneRunCommand,
  parseSessionResult,
  sandboxPlaceholders,
  sessionTimeoutMs,
  taskBrief,
  tokenMinimumRemainingSeconds,
} from '../../src/cli/lane-run.ts';

// KRN-12: the session result is a verbatim `claude -p --output-format json` capture;
// a stand-in claude executable prints it, the repositories are real git repositories.
const capture = readFileSync(
  fileURLToPath(
    new URL('../fixtures/claude/headless-session-result.json', import.meta.url),
  ),
  'utf8',
);

const fastCheck = fileURLToPath(
  new URL('../../scripts/fast-check.ts', import.meta.url),
);

/** Shell for a delivering session: commit with the Ticket trailer, close the task, leave the fast-pass marker. */
function deliver(title = 'feat(x): done (t-abc1234)', verify = true): string {
  const marker = `node --input-type=module -e "import { treeKey } from '${fastCheck}'; import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.krn/cache', { recursive: true }); writeFileSync('.krn/cache/fast-pass', treeKey(process.cwd()));"`;
  const close = `node -e "const fs = require('node:fs'); const f = 'tasks/t-abc1234.json'; const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.status = 'closed'; t.resolution = { kind: 'done', ref: null, note: '' }; fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\\n');"`;
  return `${close}; git commit -qam "${title}" -m "Ticket: t-abc1234"; ${verify ? marker : 'true'}`;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(action: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-run-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane run test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(
    join(repo, 'tasks', 't-abc1234.json'),
    `${JSON.stringify(
      {
        id: 't-abc1234',
        status: 'open',
        resolution: null,
        created: '2026-11-09',
        priority: 3,
        title: 'Lane run task',
        after: [],
        body: ['Outcome: o'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, '.gitignore'), '.krn\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const claude = join(base, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\n${action}\ncat <<'JSON'\n${capture}\nJSON\n`,
  );
  chmodSync(claude, 0o755);
  return { base, repo, claude };
}

async function run(
  action: string,
  ship: (args: string[]) => Promise<string> = async () => 'unreachable',
) {
  const { base, repo, claude } = fixture(action);
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship,
        mint: async () => undefined,
      },
    );
    return { verdict, repo };
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
}

test('parseSessionResult reads the captured result', () => {
  const result = parseSessionResult(capture);
  assert.deepEqual(result, {
    ok: true,
    detail: 'session success',
    cost: 0.08594,
  });
  assert.equal(parseSessionResult('not json').ok, false);
  assert.equal(
    parseSessionResult(
      JSON.stringify({ ...JSON.parse(capture), is_error: true }),
    ).ok,
    false,
  );
});

test('lane run ships a committed task and prints the ship verdict', async () => {
  const { verdict } = await run(
    deliver(),
    async () => 'merged\nverdict: merged abc1234',
  );
  assert.equal(verdict.exitCode, 0);
  assert.match(
    verdict.line,
    /^lane t-abc1234: shipped verdict: merged abc1234 model sonnet cost \$0\.09$/u,
  );
});

test('lane run reports no commit and keeps the worktree', async () => {
  const { verdict } = await run('true');
  assert.equal(verdict.exitCode, 74);
  assert.match(
    verdict.line,
    /^lane t-abc1234: no commit \(worktree .+, rerun reuses it, claim released\) model sonnet cost \$0\.09$/u,
  );
});

test('sandboxPlaceholders keeps only untracked empty regular files', () => {
  const sizes: Record<string, number> = {
    '.env': 0,
    '.npmrc': 0,
    'note.txt': 3,
  };
  const found = sandboxPlaceholders(
    '?? .env\0?? .npmrc\0?? note.txt\0 M tracked.ts\0',
    (path) => ({ isFile: () => true, size: sizes[path] ?? 1 }),
  );
  assert.deepEqual(found, ['.env', '.npmrc']);
});

test('lane run removes empty sandbox placeholders before the dirty-tree check', async () => {
  const { verdict } = await run(
    `: > .env; : > .npmrc; : > yarn.lock; ${deliver()}`,
    async () => 'verdict: merged abc1234',
  );
  assert.equal(verdict.exitCode, 0);
  assert.match(
    verdict.line,
    /^lane t-abc1234: shipped verdict: merged abc1234/u,
  );
});

test('sandboxPlaceholders keeps an intended empty file such as .gitkeep', () => {
  const found = sandboxPlaceholders(
    '?? .gitkeep\0?? docs/.env.local\0?? marker\0?? pnpm-lock.yaml\0',
    () => ({ isFile: () => true, size: 0 }),
  );
  assert.deepEqual(found, ['docs/.env.local', 'pnpm-lock.yaml']);
});

test('lane run reports a dirty tree and does not ship', async () => {
  const { verdict } = await run('echo x > stray.txt');
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /^lane t-abc1234: dirty tree /u);
});

test('lane run starts the session in the sandbox with only the App credential', async () => {
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-seen-'));
  const saved = { ...process.env };
  process.env.GH_TOKEN = 'operator-token';
  process.env.GITHUB_TOKEN = 'operator-token';
  process.env.SSH_AUTH_SOCK = '/run/agent.sock';
  try {
    const { verdict } = await run(
      `printf '%s\\n' "$@" > ${seen}/argv; env > ${seen}/env`,
    );
    assert.equal(verdict.exitCode, 74);
    const argv = readFileSync(join(seen, 'argv'), 'utf8');
    assert.match(argv, /^--settings\n.+\.claude\/settings\.sandbox\.json$/mu);
    assert.doesNotMatch(argv, /bypassPermissions/u);
    const env = readFileSync(join(seen, 'env'), 'utf8');
    assert.doesNotMatch(env, /^(GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK)=/mu);
    assert.doesNotMatch(env, /operator-token/u);
    assert.match(env, /^KRN_APP_CACHE_DIR=.+\.krn\/tmp\/app-cache$/mu);
    assert.match(env, /^PATH=.*scripts\/app-bin:/mu);
    assert.match(
      env,
      /^GIT_CONFIG_VALUE_\d+=.*github-app-token\.ts' git-credential$/mu,
    );
  } finally {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK'])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    rmSync(seen, { recursive: true, force: true });
  }
});

test('lane run stops with exit 69 when the App token cannot be minted', async () => {
  const { base, repo, claude } = fixture('touch started');
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async () => 'unreachable',
        mint: async () => 'bw serve unavailable',
      },
    );
    assert.equal(verdict.exitCode, 69);
    assert.match(verdict.line, /GitHub App credential unavailable/u);
    assert.equal(
      spawnSync('test', ['-e', join(base, 'repo', 'started')]).status,
      1,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

// Receiver evidence (claude -p in a lane worktree, captured 2026-11-10): with
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set the CLI prints "Permission mode forced to
// default ... Declare allowedTools explicitly" and refuses every Write and Edit,
// so --permission-mode acceptEdits grants nothing and the lane never commits.
test('the lane sandbox settings allow edits explicitly when they scrub the subprocess env', () => {
  const settings = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../.claude/settings.sandbox.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as {
    env?: Record<string, string>;
    permissions: { allow: string[] };
    sandbox: { network: { allowedDomains: string[] } };
  };
  assert.equal(settings.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  // bw serve listens on localhost:8087 unauthenticated and holds the App key.
  for (const domain of settings.sandbox.network.allowedDomains)
    assert.doesNotMatch(domain, /localhost|127\.|\[?::1\]?|:8087/u, domain);
  for (const tool of ['Bash', 'Edit', 'Write'])
    assert.ok(settings.permissions.allow.includes(tool), tool);
});

test('a session limit never reaches the App token lifetime', () => {
  const limit = sessionTimeoutMs({});
  assert.ok(limit < tokenMinimumRemainingSeconds * 1000);
  assert.equal(sessionTimeoutMs({ KRN_LANE_TIMEOUT_MS: '7200000' }), limit);
  assert.equal(sessionTimeoutMs({ KRN_LANE_TIMEOUT_MS: '500' }), 500);
});

test('lane run ends a hanging session with the timeout verdict', async () => {
  process.env.KRN_LANE_TIMEOUT_MS = '500';
  try {
    const { verdict } = await run('exec sleep 30');
    assert.equal(verdict.exitCode, 74);
    assert.match(verdict.line, /session timeout/u);
  } finally {
    delete process.env.KRN_LANE_TIMEOUT_MS;
  }
});

test('a failed claim in lane start keeps the uncommitted task record', async () => {
  const { base, repo } = fixture('true');
  try {
    const id = 't-def5678';
    const file = join(repo, 'tasks', `${id}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ id, status: 'closed', resolution: 'done', created: '2026-11-09', priority: 3, title: 'Closed', after: [], body: ['Outcome: o'] })}\n`,
    );
    await assert.rejects(
      startLane(['keep-record', '--task', id, '--root', repo]),
    );
    assert.equal(readFileSync(file, 'utf8').includes(id), true);
    assert.equal(
      spawnSync('git', ['-C', repo, 'branch', '--list', 'keep-record'], {
        encoding: 'utf8',
      }).stdout.trim(),
      '',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the session prompt starts with the packet krn lane brief prints for the task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-lane-run-packet-'));
  try {
    mkdirSync(join(dir, 'tasks'));
    mkdirSync(join(dir, 'evals', 'fr40'), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL('../../evals/fr40/records.json', import.meta.url)),
      join(dir, 'evals', 'fr40', 'records.json'),
    );
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(
        {
          id: 't-abc1234',
          status: 'open',
          resolution: null,
          created: '2026-11-09',
          priority: 3,
          title: 'Lane run task',
          after: [],
          body: ['Outcome: o'],
        },
        null,
        2,
      )}\n`,
    );
    const prompt = taskBrief(dir, 't-abc1234', '2026-11-10');
    assert.match(prompt, /^Repository conventions \(brain packet /u);
    const record = prompt
      .slice(prompt.indexOf('\n\nTask t-abc1234: ') + 2)
      .replace(`\n\n${WORKER_RULES}\n`, '\n');
    assert.match(record, /^Task t-abc1234: Lane run task/u);
    assert.equal(prompt, laneBriefText(dir, record, '2026-11-10', 't-abc1234'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lane run pins the model and passes --model to the session', async () => {
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-model-'));
  try {
    const { verdict } = await run(`printf '%s\\n' "$@" > ${seen}/argv`);
    assert.match(
      readFileSync(join(seen, 'argv'), 'utf8'),
      /^--model\nsonnet$/mu,
    );
    assert.match(verdict.line, / model sonnet /u);
  } finally {
    rmSync(seen, { recursive: true, force: true });
  }
});

test('lane run marks the session as a lane session', async () => {
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-class-'));
  try {
    await run(`env > ${seen}/env`);
    assert.match(
      readFileSync(join(seen, 'env'), 'utf8'),
      /^KRN_SESSION_CLASS=lane$/mu,
    );
  } finally {
    rmSync(seen, { recursive: true, force: true });
  }
});

test('lane run names a timeout apart from a missing JSON result', async () => {
  process.env.KRN_LANE_TIMEOUT_MS = '500';
  try {
    const timeout = await run('exec sleep 30');
    assert.match(timeout.verdict.line, /session timeout after 1s/u);
  } finally {
    delete process.env.KRN_LANE_TIMEOUT_MS;
  }
  const { base, repo, claude } = fixture('true');
  writeFileSync(claude, '#!/bin/sh\necho garbage\n');
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async () => 'unreachable',
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 74);
    assert.match(verdict.line, /no JSON result \(not a timeout\)/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun after a failed run reuses the lane worktree and ships', async () => {
  const { base, repo, claude } = fixture('true');
  process.env.KRN_LANE_CLAUDE = claude;
  const steps = {
    start: startLane,
    ship: async () => 'verdict: merged abc1234',
    mint: async () => undefined,
  };
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74);
    writeFileSync(
      claude,
      `#!/bin/sh\n${deliver()}\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
    const second = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(second.exitCode, 0, second.line);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run titles the PR from the Ticket commit and ships its verification', async () => {
  let title = '';
  let body = '';
  const { verdict } = await run(
    `${deliver('feat(x): done (t-abc1234)')}; git commit -q --allow-empty -m "chore: newest step"`,
    async (args) => {
      title = args[args.indexOf('--title') + 1] as string;
      body = readFileSync(
        args[args.indexOf('--body-file') + 1] as string,
        'utf8',
      );
      return 'verdict: merged abc1234';
    },
  );
  assert.equal(verdict.exitCode, 0, verdict.line);
  assert.equal(title, 'feat(x): done (t-abc1234)');
  assert.match(body, /npm run fast PASS on the final tree/u);
});

test('lane run refuses to ship a task the session left open', async () => {
  const { verdict } = await run(
    `${deliver()}; git reset -q --hard HEAD~1; git commit -q --allow-empty -m "feat(x): done (t-abc1234)" -m "Ticket: t-abc1234"`,
  );
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /task not closed/u);
});

test('lane run refuses to ship when no check passed on the final tree', async () => {
  const { verdict } = await run(deliver('feat(x): done (t-abc1234)', false));
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /no passing check on the final tree/u);
});

test('lane run refuses to ship without a commit carrying the Ticket trailer', async () => {
  const { verdict } = await run(
    'git commit -q --allow-empty -m "feat(x): done (t-abc1234)"',
  );
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /no commit with a Ticket: t-abc1234 trailer/u);
});

test('lane run exits non-zero when the ship verdict is not merged', async () => {
  for (const verdict of [
    'verdict: open: checks pending',
    'verdict: closed unmerged',
  ]) {
    const result = await run(deliver(), async () => verdict);
    assert.equal(result.verdict.exitCode, 74, verdict);
    assert.match(result.verdict.line, /not merged/u);
  }
});

test('a failed run releases the claim, keeps the worktree and a rerun claims it again', async () => {
  const { base, repo, claude } = fixture('true');
  process.env.KRN_LANE_CLAUDE = claude;
  const steps = {
    start: startLane,
    ship: async () => 'verdict: merged abc1234',
    mint: async () => undefined,
  };
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74);
    assert.match(first.line, /claim released/u);
    assert.equal(
      existsSync(join(repo, '.krn', 'task-claims', 't-abc1234.json')),
      false,
    );
    assert.ok(existsSync(join(repo, '.krn', 'worktrees', 't-abc1234')));
    writeFileSync(
      claude,
      `#!/bin/sh\n${deliver()}\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
    const second = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(second.exitCode, 0, second.line);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a session that cannot start exits 69, not the no-delivery 74', async () => {
  const { base, repo } = fixture('true');
  process.env.KRN_LANE_CLAUDE = join(base, 'missing-claude');
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      { start: startLane, ship: async () => 'x', mint: async () => undefined },
    );
    assert.equal(verdict.exitCode, 69);
    assert.match(verdict.line, /session did not run/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a timeout kills the whole session process group', async () => {
  process.env.KRN_LANE_TIMEOUT_MS = '500';
  const { base, repo, claude } = fixture('true');
  const pidFile = join(base, 'child.pid');
  writeFileSync(
    claude,
    `#!/bin/sh\nsleep 60 >/dev/null 2>&1 &\necho $! > '${pidFile}'\nexec sleep 30\n`,
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      { start: startLane, ship: async () => 'x', mint: async () => undefined },
    );
    assert.match(verdict.line, /session timeout/u);
    const child = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 50 && alive(); attempt += 1)
      spawnSync('sleep', ['0.1']);
    assert.equal(alive(), false);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    delete process.env.KRN_LANE_TIMEOUT_MS;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the headless brief states the title format and npm run fast', () => {
  const { base, repo } = fixture('true');
  try {
    const brief = taskBrief(repo, 't-abc1234');
    assert.match(brief, /type\(scope\): outcome \(t-abc1234\)/u);
    assert.match(brief, /npm run fast/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
