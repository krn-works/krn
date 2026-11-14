import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { laneBriefText, startLane, workerRules } from '../../src/cli/lane.ts';
import {
  goalBrief,
  goalSlug,
  taskBrief,
} from '../../src/cli/lane-run/brief.ts';
import {
  sandboxPlaceholders,
  ticketCommitTitle,
} from '../../src/cli/lane-run/delivery.ts';
import {
  laneSandboxSettings,
  sessionTimeoutMs,
  tokenMinimumRemainingSeconds,
} from '../../src/cli/lane-run/environment.ts';
import {
  baselineReason,
  failingTests,
  prepareWorktree,
  remoteFailure,
  rerunCommand,
  settingsFailure,
  settledRun,
} from '../../src/cli/lane-run/preflight.ts';
import {
  redCheckFile,
  redCheckFinding,
  redCheckOf,
} from '../../src/cli/lane-run/red-check.ts';
import {
  parseSessionResult,
  transcriptTurns,
} from '../../src/cli/lane-run/result.ts';
import { mintFailure } from '../../src/cli/lane-run/steps.ts';
import { laneRunCommand } from '../../src/cli/lane-run.ts';
import { CliUsageError } from '../../src/cli/usage-error.ts';

// An ambient lane session sets KRN_SESSION_CLASS=lane, which `krn lane start` rejects; the tests own their environment.
Reflect.deleteProperty(process.env, 'KRN_SESSION_CLASS');

import { claimTask, inspectClaim } from '../../src/task/claims.ts';

// A lane session exports its class; these tests start lanes of their own.
delete process.env.KRN_SESSION_CLASS;

// KRN-12: the session result is a verbatim `claude -p --output-format json` capture;
// a stand-in claude executable prints it, the repositories are real git repositories.
const capture = readFileSync(
  fileURLToPath(
    new URL('../fixtures/claude/headless-session-result.json', import.meta.url),
  ),
  'utf8',
);

// A lane session exports these; the tests start lanes of their own and must not inherit its class.
for (const name of ['KRN_SESSION_CLASS', 'KRN_LANE', 'KRN_TASK'])
  delete process.env[name];

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

function fixture(
  action: string,
  files: Record<string, string> = {},
  sessionCapture = capture,
) {
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
  writeFileSync(join(repo, '.gitignore'), '.krn\nnode_modules\n');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const claude = join(base, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\n${action}\ncat <<'JSON'\n${sessionCapture}\nJSON\n`,
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

test('parseSessionResult marks a session stopped at its budget', () => {
  const result = parseSessionResult(
    '{"subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":3.2}',
  );
  assert.equal(result.ok, false);
  assert.equal(result.capped, true);
});

test('parseSessionResult reads the captured result', () => {
  const result = parseSessionResult(capture, '', () => undefined);
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

test('the verdict counts the distinct assistant messages of the transcript, not num_turns', () => {
  // Verbatim shape of the t-cencnmk session: num_turns printed 1 while the transcript held 22 messages.
  const result = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'fa1a426f-e206-423b-b515-a259639f9f05',
    total_cost_usd: 1.5,
  });
  const lines = [];
  for (let n = 0; n < 22; n++)
    for (const block of ['thinking', 'tool_use'])
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { id: `msg_${n}`, content: [{ type: block }] },
        }),
        JSON.stringify({ type: 'user', message: { content: [] } }),
      );
  const transcript = lines.join('\n');
  assert.equal(transcriptTurns(transcript), 22);
  const parsed = parseSessionResult(result, '', (id) => {
    assert.equal(id, 'fa1a426f-e206-423b-b515-a259639f9f05');
    return transcriptTurns(transcript);
  });
  assert.equal(parsed.turns, 22);
  assert.equal(
    parseSessionResult(result, '', () => undefined).turns,
    undefined,
  );
});

test('an adopted repository without its own sandbox settings uses the copy KRN ships', () => {
  // Seen on the pilot: claude printed 'Error: Settings file not found: .../.claude/settings.sandbox.json'.
  const adopted = mkdtempSync(join(tmpdir(), 'krn-adopted-'));
  try {
    const settings = laneSandboxSettings(adopted);
    assert.ok(existsSync(settings), settings);
    assert.match(settings, /\.claude\/settings\.sandbox\.json$/u);
    mkdirSync(join(adopted, '.claude'));
    writeFileSync(join(adopted, '.claude', 'settings.sandbox.json'), '{}');
    assert.equal(
      laneSandboxSettings(adopted),
      join(adopted, '.claude', 'settings.sandbox.json'),
    );
  } finally {
    rmSync(adopted, { recursive: true, force: true });
  }
});

test('a session without a JSON result names what claude said', () => {
  const said =
    'Error: Settings file not found: /w/.claude/settings.sandbox.json';
  const result = parseSessionResult(`${said}\n`, '');
  assert.equal(result.ok, false);
  assert.match(
    result.detail,
    /not a timeout\): Error: Settings file not found/u,
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

test('sandboxPlaceholders covers the files the sandbox mounts in a repository without a root package.json', () => {
  // Seen on the pilot lane t-g1fc0cz: these five empty files made the tree dirty (exit 74).
  const names = [
    '.gitmodules',
    '.yarnrc',
    '.yarnrc.yml',
    'bunfig.toml',
    'package.json',
  ];
  const found = sandboxPlaceholders(
    names.map((name) => `?? ${name}\0`).join(''),
    () => ({ isFile: () => true, size: 0 }),
  );
  assert.deepEqual(found, names);
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

const blockerCapture = JSON.stringify({
  ...JSON.parse(capture),
  result:
    'I could not edit scripts/.\nBLOCKER: sandbox mounts scripts/, .claude/ and .agents/ read-only',
});

test('parseSessionResult keeps a final BLOCKER line', () => {
  const result = parseSessionResult(blockerCapture);
  assert.equal(
    result.blocker,
    'BLOCKER: sandbox mounts scripts/, .claude/ and .agents/ read-only',
  );
  assert.equal(parseSessionResult(capture).blocker, undefined);
});

test('lane run prints the session BLOCKER line and exits 73 instead of dirty tree', async () => {
  const { base, repo, claude } = fixture(
    'echo x > stray.txt',
    {},
    blockerCapture,
  );
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
    assert.equal(verdict.exitCode, 73);
    assert.match(
      verdict.line,
      /^lane t-abc1234: BLOCKER: sandbox mounts scripts\/, \.claude\/ and \.agents\/ read-only /u,
    );
    assert.doesNotMatch(verdict.line, /dirty tree/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
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
    mkdirSync(join(dir, '.krn'), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL('../../evals/fr40/records.json', import.meta.url)),
      join(dir, '.krn', 'conventions.json'),
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
      .replace(`\n\n${workerRules(dir)}\n`, '\n');
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

test('lane run caps the session spend, names a fallback model and reads only project settings', async () => {
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-cap-'));
  try {
    await run(`printf '%s\\n' "$@" > ${seen}/argv`);
    const argv = readFileSync(join(seen, 'argv'), 'utf8');
    assert.match(argv, /^--max-budget-usd\n3$/mu);
    assert.match(argv, /^--fallback-model\nhaiku$/mu);
    assert.match(argv, /^--setting-sources\nproject$/mu);
  } finally {
    rmSync(seen, { recursive: true, force: true });
  }
});

test('a session that hit its spend cap exits 75 with its own reason', async () => {
  const { verdict } = await run(
    `printf '%s' '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":3.01,"num_turns":9}'; exit 0`,
  );
  assert.equal(verdict.exitCode, 75);
  assert.match(verdict.line, /session error_max_budget_usd/u);
});

test('the lane verdict records the sha of the packet its session prompt carried', async () => {
  const conventions = `[
  {"id": "r-trailer", "type": "convention", "text": "Every commit for a task carries a Ticket trailer.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md"}
]
`;
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-sha-'));
  const { base, repo, claude } = fixture(
    `printf '%s' "$2" > ${seen}/prompt; ${deliver()}`,
    { '.krn/conventions.json': conventions },
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async () => 'merged\nverdict: merged abc1234',
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 0, verdict.line);
    const sha = verdict.packet ?? '';
    assert.match(sha, /^[0-9a-f]{64}$/u);
    assert.ok(
      verdict.line.endsWith(` packet ${sha.slice(0, 12)}`),
      verdict.line,
    );
    const prompt = readFileSync(join(seen, 'prompt'), 'utf8');
    assert.ok(
      prompt.startsWith(
        `Repository conventions (brain packet ${sha.slice(0, 12)}):\n- [r-trailer] `,
      ),
      prompt,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
    rmSync(seen, { recursive: true, force: true });
  }
});

test('a lane whose prompt carries no packet records none', async () => {
  const { verdict } = await run(
    deliver(),
    async () => 'merged\nverdict: merged abc1234',
  );
  assert.equal(verdict.packet, null);
  assert.doesNotMatch(verdict.line, / packet /u);
});

test('lane run marks the session as a lane session', async () => {
  const seen = mkdtempSync(join(tmpdir(), 'krn-lane-run-class-'));
  try {
    await run(`env > ${seen}/env`);
    const env = readFileSync(join(seen, 'env'), 'utf8');
    assert.match(env, /^KRN_SESSION_CLASS=lane$/mu);
    assert.match(env, /^KRN_TASK=t-abc1234$/mu);
    assert.match(env, /^KRN_LANE=\S+$/mu);
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

test('lane run reads the ship verdict before the cleanup lines a merge prints', async () => {
  // Verbatim tail of krn pr ship on pilot PR krn-works/seo-audit-harness#78 (merged, yet the lane said 'not merged').
  const shipped = [
    'pr: #78 krn-works/seo-audit-harness 0f1e2d3',
    'gate: success 0f1e2d3',
    'merged: 4b5c6d7e8f',
    'verdict: merged 4b5c6d7e8f',
    'cleanup: removed worktree /p/.krn/worktrees/empty-alt and branch empty-alt',
    'main checkout: /p',
  ].join('\n');
  const { verdict } = await run(deliver(), async () => shipped);
  assert.equal(verdict.exitCode, 0);
  assert.match(verdict.line, /shipped verdict: merged 4b5c6d7e8f/u);
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

test('lane run names the failing check, its files and its output path when the final tree is red', async () => {
  const { base, repo, claude } = fixture(
    `${deliver('feat(x): done (t-abc1234)', false)}`,
  );
  withContract(repo, {
    base: 'main',
    test: 'true',
    fast: "echo 'not ok 1 - test/a/broken.test.ts'; echo 'fast FAIL (test): 1 changed'; exit 1",
  });
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
    assert.match(verdict.line, /no passing check on the final tree/u);
    assert.match(verdict.line, /fast FAIL \(test\)/u);
    assert.match(verdict.line, /failing files: test\/a\/broken\.test\.ts/u);
    const path = /full output (\S+?);? /u.exec(verdict.line)?.[1] ?? '';
    assert.ok(existsSync(path), path);
    assert.match(readFileSync(path, 'utf8'), /not ok 1/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a Ticket line outside the trailer block still names the task', () => {
  // Seen on pilot lane t-g1fc0cz: Ticket, a blank line, then Co-Authored-By.
  const log =
    'fix(onsite): treat empty alt as decorative (t-g1fc0cz)\x1fTicket: t-g1fc0cz\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\x1e';
  assert.equal(
    ticketCommitTitle(log, 't-g1fc0cz'),
    'fix(onsite): treat empty alt as decorative (t-g1fc0cz)',
  );
  assert.equal(
    ticketCommitTitle('feat(x): y\x1fRefs: t-g1fc0cz\n\x1e', 't-g1fc0cz'),
    undefined,
  );
});

test('lane run refuses to ship without a commit carrying the Ticket trailer', async () => {
  const { verdict } = await run(
    'git commit -q --allow-empty -m "feat(x): done (t-abc1234)"',
  );
  assert.equal(verdict.exitCode, 74);
  assert.match(verdict.line, /no commit with a Ticket: t-abc1234 trailer/u);
});

test('a Refs-only commit ships with a Refs body while the task stays open', async () => {
  let title = '';
  let body = '';
  const { verdict } = await run(
    deliver('feat(x): step one (t-abc1234)')
      .replace(/^node -e "[^;]*;[^"]*"; /u, '')
      .replace('git commit -qam', 'git commit -q --allow-empty -m')
      .replace('"Ticket: t-abc1234"', '"Refs: t-abc1234"'),
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
  assert.equal(title, 'feat(x): step one (t-abc1234)');
  assert.match(body, /^Refs: t-abc1234$/mu);
  assert.doesNotMatch(body, /^Ticket: /mu);
});

test('ticketCommitTitle reads the Refs trailer only when asked', () => {
  const log = 'feat(x): step\x1fRefs: t-g1fc0cz\n\x1e';
  assert.equal(
    ticketCommitTitle(log, 't-g1fc0cz', 'Refs'),
    'feat(x): step (t-g1fc0cz)',
  );
  assert.equal(ticketCommitTitle(log, 't-g1fc0cz'), undefined);
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

test('a rerun carries a task record edited after the failed run into the worktree', async () => {
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
    const file = join(repo, 'tasks', 't-abc1234.json');
    const edited = readFileSync(file, 'utf8').replace(
      '"Outcome: o"',
      '"Outcome: o",\n    "Lead note: rework"',
    );
    assert.notEqual(edited, readFileSync(file, 'utf8'));
    writeFileSync(file, edited);
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    assert.equal(
      readFileSync(
        join(repo, '.krn', 'worktrees', 't-abc1234', 'tasks', 't-abc1234.json'),
        'utf8',
      ),
      edited,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun merges a lead body note into the record the lane closed, commits it and ships', async () => {
  const { base, repo, claude } = fixture(deliver());
  // The carry commit changes the tree, so the rerun verifies it with the contract check.
  withContract(repo, { base: 'main', test: 'true' });
  process.env.KRN_LANE_CLAUDE = claude;
  let shipCalls = 0;
  const steps = {
    start: startLane,
    ship: async () => {
      shipCalls += 1;
      if (shipCalls === 1) throw new Error('push rejected');
      return 'verdict: merged abc1234';
    },
    mint: async () => undefined,
  };
  const worktree = join(repo, '.krn', 'worktrees', 't-abc1234');
  const lanePath = join(worktree, 'tasks', 't-abc1234.json');
  const mainPath = join(repo, 'tasks', 't-abc1234.json');
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(
        '"Outcome: o"',
        '"Outcome: o",\n    "Lead note: rework"',
      ),
    );
    const second = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(second.exitCode, 0, second.line);
    for (const path of [lanePath, mainPath]) {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(record.status, 'closed', path);
      assert.deepEqual(record.body, ['Outcome: o', 'Lead note: rework'], path);
    }
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    assert.equal(
      git(worktree, 'log', '-1', '--format=%s%n%b'),
      "chore(tasks): carry the lead's record edits into the lane (t-abc1234)\nRefs: t-abc1234",
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun refuses a record both sides changed in the same field and names it', async () => {
  const { base, repo, claude } = fixture(deliver());
  process.env.KRN_LANE_CLAUDE = claude;
  const steps = {
    start: startLane,
    ship: async () => {
      throw new Error('push rejected');
    },
    mint: async () => undefined,
  };
  const mainPath = join(repo, 'tasks', 't-abc1234.json');
  try {
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    const record = JSON.parse(readFileSync(mainPath, 'utf8'));
    record.status = 'closed';
    record.resolution = { kind: 'done', ref: null, note: 'lead closed it' };
    writeFileSync(mainPath, `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(
      laneRunCommand(['--task', 't-abc1234', '--root', repo], steps),
      (error: Error) =>
        error instanceof CliUsageError &&
        /both changed resolution; reconcile them/u.test(error.message),
    );
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
    assert.match(
      verdict.line,
      /session did not run: \S*missing-claude not found \(put claude on PATH or set KRN_LANE_CLAUDE\)/u,
    );
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

/** The fixture turned into a repository with this contract, committed and pushed. */
function withContract(repo: string, contract: object): void {
  writeFileSync(join(repo, 'krn.json'), `${JSON.stringify(contract)}\n`);
  git(repo, 'add', 'krn.json');
  git(repo, 'commit', '-qm', 'contract');
  git(repo, 'push', '-q', 'origin', 'main');
}

test('lane start cuts the worktree from the contract base branch', async () => {
  const { base, repo } = fixture('true');
  try {
    git(repo, 'checkout', '-q', '-b', 'master');
    // The adoption is on origin/master, the contract's base; lane start refuses one only local.
    writeFileSync(
      join(repo, 'krn.json'),
      '{"base": "master", "test": "true", "tracker": "none"}\n',
    );
    git(repo, 'add', 'krn.json');
    git(repo, 'commit', '-q', '-m', 'only on master');
    git(repo, 'push', '-q', 'origin', 'master');
    const started = await startLane(['on-master', '--root', repo]);
    assert.equal(
      git(started.path, 'rev-parse', 'HEAD'),
      git(repo, 'rev-parse', 'origin/master'),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run --goal ships a repository without a tracker, verified by its contract check', async () => {
  const { base, repo, claude } = fixture(
    'echo x > goal.txt; git add goal.txt; git commit -qm "feat(x): goal done"',
  );
  withContract(repo, { base: 'main', test: 'true', tracker: 'none' });
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: string[][] = [];
  try {
    const verdict = await laneRunCommand(
      ['--goal', 'Fix the parser.', '--root', repo],
      {
        start: startLane,
        ship: async (args) => {
          shipped.push(args);
          return 'verdict: merged abc1234';
        },
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 0, verdict.line);
    assert.match(verdict.line, /^lane goal-fix-the-parser: shipped /u);
    const args = shipped[0] ?? [];
    assert.equal(args[args.indexOf('--title') + 1], 'feat(x): goal done');
    const body = readFileSync(
      args[args.indexOf('--body-file') + 1] ?? '',
      'utf8',
    );
    assert.match(body, /Fix the parser\./u);
    assert.match(body, /true PASS on the final tree/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run takes --goal only without a tracker and --task only with one', async () => {
  const { base, repo } = fixture('true');
  const steps = {
    start: startLane,
    ship: async () => 'unreachable',
    mint: async () => undefined,
  };
  try {
    await assert.rejects(
      laneRunCommand(['--goal', 'x', '--root', repo], steps),
      /tracks work in tasks\//u,
    );
    withContract(repo, { test: 'true', tracker: 'none' });
    await assert.rejects(
      laneRunCommand(['--root', repo], steps),
      /--goal TEXT names the work/u,
    );
    await assert.rejects(
      laneRunCommand(
        ['--goal', 'x', '--task', 't-abc1234', '--root', repo],
        steps,
      ),
      /exclude each other/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a lane on a master base ships with --base master', async () => {
  const { base, repo, claude } = fixture(
    'echo x > goal.txt; git add goal.txt; git commit -qm "feat(x): goal done"',
  );
  withContract(repo, { base: 'master', test: 'true', tracker: 'none' });
  git(repo, 'branch', 'master');
  git(repo, 'push', '-q', 'origin', 'master');
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: string[][] = [];
  try {
    const verdict = await laneRunCommand(['--goal', 'x', '--root', repo], {
      start: startLane,
      ship: async (args) => {
        shipped.push(args);
        return 'verdict: merged abc1234';
      },
      mint: async () => undefined,
    });
    assert.equal(verdict.exitCode, 0, verdict.line);
    const args = shipped[0] ?? [];
    assert.equal(args[args.indexOf('--base') + 1], 'master');
    assert.equal(args[args.indexOf('--title') + 1], 'feat(x): goal done');
    assert.match(verdict.line, /^lane goal-x: shipped /u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the goal brief names the contract check and no task record', () => {
  const { base, repo } = fixture('true');
  try {
    withContract(repo, { test: 'pytest -q', tracker: 'none' });
    const brief = goalBrief(repo, 'Fix the parser.', '2026-11-13');
    assert.match(brief, /Run `pytest -q`/u);
    assert.doesNotMatch(brief, /Ticket|npm run fast|task close/u);
    assert.equal(goalSlug('  Fix the parser!  '), 'goal-fix-the-parser');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a ship that throws releases the claim and a rerun ships', async () => {
  const { base, repo, claude } = fixture(deliver());
  process.env.KRN_LANE_CLAUDE = claude;
  let shipCalls = 0;
  const steps = {
    start: startLane,
    ship: async () => {
      shipCalls += 1;
      if (shipCalls === 1) throw new Error('push rejected\nremote detail');
      return 'verdict: merged abc1234';
    },
    mint: async () => undefined,
  };
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    assert.match(first.line, /failed: push rejected \(.*claim released\)/u);
    assert.equal(inspectClaim(repo, 't-abc1234').state, 'none');
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

// KRN-12: verbatim `krn ci logs` captures of the two red Checks a rerun pushed no fix for (2026-11-13).
const ciLogsCapture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/ci/${name}`, import.meta.url)),
    'utf8',
  );

test('redCheckOf reads the run and head of a red Check ship failure and nothing else', () => {
  const sha = 'dde09ec3d8ba484dce8afd4e4079fc84daefbe3a';
  assert.deepEqual(
    redCheckOf(
      `Check concluded failure on ${sha} in run 43501009193; logs: bin/krn ci logs --run 43501009193; rerun: gh run rerun 43501009193 --failed`,
    ),
    { sha, run: '43501009193' },
  );
  assert.equal(redCheckOf('push rejected'), undefined);
  assert.equal(
    redCheckOf(`Check concluded success on ${sha} in run 1`),
    undefined,
  );
});

test('redCheckFinding names the failing step and its first finding in real ci logs captures', () => {
  const weak = redCheckFinding(
    ciLogsCapture('logs-weak-tests-43501009193.txt'),
  );
  assert.equal(weak.job, 'Lint: failure; failed step 6 Weakened tests');
  assert.match(
    weak.finding,
    /^weak-tests: test\/brain\/worker-packet\.test\.ts: net 5 assertion\(s\) removed/u,
  );
  const shard = redCheckFinding(
    ciLogsCapture('logs-test-shard-43501061076.txt'),
  );
  assert.equal(
    shard.job,
    'Test (11/13): failure; failed step 4 Run test shard',
  );
  assert.equal(
    shard.finding,
    'failing tests: test/portability/fixtures.test.ts (2 failed)',
  );
});

test('a rerun after a red Check briefs the failure, exits 74 without a new commit and ships after one', async () => {
  const { base, repo, claude } = fixture(deliver());
  process.env.KRN_LANE_CLAUDE = claude;
  const brief = join(base, 'brief.txt');
  const logRuns: string[] = [];
  let shipCalls = 0;
  let redSha = '';
  const steps = {
    start: startLane,
    ship: async (args: string[]) => {
      shipCalls += 1;
      if (shipCalls > 1) return 'verdict: merged abc1234';
      redSha = git(args[1] as string, 'rev-parse', 'HEAD');
      throw new Error(
        `ship: Check concluded failure on ${redSha} in run 43501009193; logs: bin/krn ci logs --run 43501009193`,
      );
    },
    mint: async () => undefined,
    ciLogs: async (run: string) => {
      logRuns.push(run);
      return ciLogsCapture('logs-weak-tests-43501009193.txt');
    },
  };
  const rewrite = (action: string) =>
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s' "$2" > '${brief}'\n${action}\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    assert.ok(existsSync(redCheckFile(repo, 't-abc1234')));

    // The session sees its earlier commit and ends without a fix.
    rewrite('true');
    const idle = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(idle.exitCode, 74, idle.line);
    assert.match(
      idle.line,
      new RegExp(
        `no new commit since the red Check \\(run 43501009193 on ${redSha.slice(0, 12)}\\)`,
        'u',
      ),
    );
    assert.deepEqual(logRuns, ['43501009193']);
    const text = readFileSync(brief, 'utf8');
    assert.match(text, /^The previous attempt of this lane FAILED CI/u);
    assert.match(
      text,
      /Failing job and step: Lint: failure; failed step 6 Weakened tests/u,
    );
    assert.match(
      text,
      /First finding: weak-tests: test\/brain\/worker-packet\.test\.ts: net 5 assertion\(s\) removed/u,
    );
    assert.equal(shipCalls, 1);

    // A session that commits a fix ships, and the red record goes.
    rewrite(
      `echo fix > fix.txt && git add fix.txt && ${deliver('fix(x): repair (t-abc1234)')}`,
    );
    const fixed = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(fixed.exitCode, 0, fixed.line);
    assert.equal(shipCalls, 2);
    assert.equal(existsSync(redCheckFile(repo, 't-abc1234')), false);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a missing origin base ref after the session releases the claim', async () => {
  const { base, repo, claude } = fixture(
    `${deliver()}; git update-ref -d refs/remotes/origin/main`,
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async () => assert.fail('nothing may ship'),
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 74, verdict.line);
    assert.match(verdict.line, /failed: git log/u);
    assert.equal(inspectClaim(repo, 't-abc1234').state, 'none');
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun resumes the live claim its own actor left in the lane worktree', async () => {
  const { base, repo, claude } = fixture(deliver());
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    // A run killed before it released: the worktree and a live claim of the lane actor remain.
    const started = await startLane(['t-abc1234', '--root', repo]);
    await claimTask(repo, 't-abc1234', {
      actor: 'lane-t-abc1234',
      worktree: started.path,
      reason: 'lane t-abc1234',
    });
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: async () => assert.fail('the lane exists'),
        ship: async () => 'verdict: merged abc1234',
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 0, verdict.line);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun never resumes a claim another actor holds', async () => {
  const { base, repo, claude } = fixture(deliver());
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const started = await startLane(['t-abc1234', '--root', repo]);
    await claimTask(repo, 't-abc1234', {
      actor: 'someone-else',
      worktree: started.path,
      reason: 'theirs',
    });
    await assert.rejects(
      laneRunCommand(['--task', 't-abc1234', '--root', repo], {
        start: async () => assert.fail('the lane exists'),
        ship: async () => 'unreachable',
        mint: async () => undefined,
      }),
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a token helper run is a failure unless it exited 0, and names its first stderr line', () => {
  assert.equal(mintFailure({ status: 0, stderr: 'noise' }), undefined);
  assert.equal(
    mintFailure({ status: 1, stderr: 'bw serve unavailable\nmore' }),
    'bw serve unavailable',
  );
  assert.equal(
    mintFailure({ status: null, stderr: '', error: new Error('spawn failed') }),
    'spawn failed',
  );
  assert.equal(
    mintFailure({ status: 3, stderr: '' }),
    'token helper exited with status 3',
  );
});

// KRN-12: the receiver is a real npm install of a tiny package with a file: dependency (offline).
function npmFiles(
  test: string,
  install = 'npm install --no-audit --no-fund --offline',
): Record<string, string> {
  return {
    'krn.json': JSON.stringify({ install, test }),
    'package.json': JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      dependencies: { dep: 'file:./dep' },
    }),
    'dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }),
  };
}

async function runPrepared(
  files: Record<string, string>,
  before: (repo: string, base: string) => void = () => {},
) {
  const { base, repo, claude } = fixture('echo x > started', files);
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    before(repo, base);
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async () => 'unreachable',
        mint: async () => undefined,
      },
    );
    const worktree = join(repo, '.krn', 'worktrees', 't-abc1234');
    return {
      verdict,
      started: existsSync(join(worktree, 'started')),
      installed: existsSync(
        join(worktree, 'node_modules', 'dep', 'package.json'),
      ),
      claim: inspectClaim(repo, 't-abc1234'),
    };
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
}

test('lane run installs the contract dependencies in the worktree and runs the baseline test before the session', async () => {
  const out = await runPrepared(
    npmFiles('test -f node_modules/dep/package.json'),
  );
  assert.equal(out.installed, true);
  assert.equal(out.started, true);
  assert.match(out.verdict.line, /dirty tree/u);
});

test('lane run exits 71 naming the install when it fails and starts no session', async () => {
  const out = await runPrepared(
    npmFiles('true', 'echo no network >&2; exit 3'),
  );
  assert.equal(out.verdict.exitCode, 71);
  assert.match(
    out.verdict.line,
    /install failed \(echo no network.*exit 3: no network/u,
  );
  assert.equal(out.started, false);
  assert.notEqual(out.claim.state, 'live');
});

test('lane run exits 72 on a red baseline and starts no session', async () => {
  const out = await runPrepared(npmFiles(`node -e "process.exit(1)"`));
  assert.equal(out.verdict.exitCode, 72);
  assert.match(out.verdict.line, /red baseline/u);
  assert.equal(out.installed, true);
  assert.equal(out.started, false);
});

test('lane run skips install and baseline when the contract names none', async () => {
  const out = await runPrepared({});
  assert.equal(out.started, true);
});

// KRN-12: verbatim captures of a red vitest 5 run (stdout, stderr) and a red node --test run.
const fixtureText = (path: string) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)),
    'utf8',
  );
const vitestRed = {
  stdout: fixtureText('vitest/failing-run.stdout.txt'),
  stderr: fixtureText('vitest/failing-run.stderr.txt'),
};

test('failingTests names the failing files of a red vitest run', () => {
  assert.deepEqual(failingTests(`${vitestRed.stdout}\n${vitestRed.stderr}`), [
    'test/math.test.ts',
    'test/other.test.ts',
  ]);
});

test('failingTests names the failing file of a red node --test run', () => {
  assert.deepEqual(
    failingTests(fixtureText('node-test/failing-run.stdout.txt')),
    ['test/math.test.mjs'],
  );
});

test('failingTests names the file of a red node:test TAP run, so a preamble warning is never the baseline reason', () => {
  const stdout = fixtureText('node-test/tap-red-run.stdout.txt');
  assert.deepEqual(failingTests(stdout), [
    '/work/repo/test/claude/worker-stop.test.ts',
  ]);
  assert.equal(
    baselineReason({ status: 1, stdout, stderr: '' }),
    'exit 1; failing: /work/repo/test/claude/worker-stop.test.ts',
  );
});

test('failingTests reads plain jest and pytest failure lines', () => {
  assert.deepEqual(
    failingTests(
      'FAIL src/a.test.js\nFAILED tests/test_b.py::test_x - assert 1 == 2\n',
    ),
    ['src/a.test.js', 'tests/test_b.py'],
  );
});

test('a red baseline names the failing test files, never the vitest separator', () => {
  // Seen on the pilot: the exit-72 detail quoted `⎯⎯⎯⎯[3/3]⎯` instead of the failing tests.
  const reason = baselineReason({ status: 1, ...vitestRed });
  assert.equal(
    reason,
    'exit 1; failing: test/math.test.ts, test/other.test.ts',
  );
  assert.equal(
    baselineReason({ status: 1, stdout: '', stderr: 'boom\n⎯⎯⎯⎯[1/1]⎯\n' }),
    'exit 1: boom',
  );
});

test('lane run exit 72 names the failing test file', async () => {
  const out = await runPrepared(
    npmFiles(
      `node -e "console.log(' FAIL  test/a.test.ts > adds'); process.exit(1)"`,
    ),
  );
  assert.equal(out.verdict.exitCode, 72);
  assert.match(out.verdict.line, /failing: test\/a\.test\.ts\)/u);
  assert.equal(out.started, false);
});

test('lane run waits for the baseline lock another lane holds under the main checkout', async () => {
  // Seen on the pilot: five lanes ran the suite at once, it timed out, and every lane refused with 72.
  const out = await runPrepared(
    npmFiles('test -e ../../../../released'),
    (repo, base) => {
      const lock = join(repo, '.krn', 'tmp', 'lane-baseline.lock');
      mkdirSync(join(repo, '.krn', 'tmp'), { recursive: true });
      const other = spawn('sh', [
        '-c',
        `sleep 1.5; touch '${join(base, 'released')}'; rm -f '${lock}'`,
      ]);
      writeFileSync(lock, String(other.pid));
    },
  );
  assert.equal(out.started, true, out.verdict.line);
});

test('settingsFailure names a missing or unreadable sandbox settings file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-settings-'));
  try {
    const file = join(dir, 'settings.sandbox.json');
    assert.match(settingsFailure(file) ?? '', /settings file missing/u);
    writeFileSync(file, '{ not json');
    assert.match(settingsFailure(file) ?? '', /settings file is not JSON/u);
    writeFileSync(file, '{}');
    assert.equal(settingsFailure(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lane run refuses an unreadable sandbox settings file before the install and the session', async () => {
  const out = await runPrepared({
    ...npmFiles('true'),
    '.claude/settings.sandbox.json': '{ not json',
  });
  assert.equal(out.verdict.exitCode, 69);
  assert.match(
    out.verdict.line,
    /preflight: sandbox settings file is not JSON/u,
  );
  assert.equal(out.started, false);
  assert.equal(out.installed, false);
  assert.notEqual(out.claim.state, 'live');
});

test('remoteFailure reads origin with the session credentials, not the operator ones', () => {
  const { base, repo } = fixture('true');
  try {
    assert.equal(remoteFailure(repo, 'main', process.env), undefined);
    assert.equal(
      remoteFailure(repo, 'nope', process.env),
      'origin has no branch nope',
    );
    // A session environment the remote refuses (here: file transport forbidden) fails the preflight.
    assert.match(
      remoteFailure(repo, 'main', {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.file.allow',
        GIT_CONFIG_VALUE_0: 'never',
      }) ?? '',
      /origin unreachable with the lane credentials/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run fails in seconds on an unreachable remote and creates no worktree', async () => {
  const out = await runPrepared({}, (repo, base) =>
    git(repo, 'remote', 'set-url', 'origin', join(base, 'missing.git')),
  );
  assert.equal(out.verdict.exitCode, 69);
  assert.match(
    out.verdict.line,
    /^lane t-abc1234: preflight: origin unreachable with the lane credentials/u,
  );
  assert.equal(out.started, false);
});

test('rerunCommand appends the failing files, behind -- for an npm script', () => {
  assert.equal(
    rerunCommand(
      'npm --prefix packages/seo run build && npm --prefix packages/seo test',
      ['test/a.test.ts', 'test/b.test.ts'],
    ),
    "npm --prefix packages/seo run build && npm --prefix packages/seo test -- 'test/a.test.ts' 'test/b.test.ts'",
  );
  assert.equal(
    rerunCommand('pytest', ['tests/test_a.py']),
    "pytest 'tests/test_a.py'",
  );
  assert.equal(
    rerunCommand('npm test -- --run', ['a.test.ts']),
    "npm test -- --run 'a.test.ts'",
  );
});

/** A clean base checkout whose contract test is check.mjs: red without arguments, then `rerun` decides. */
function flakyBaseline(rerun: 'pass' | 'fail') {
  return fixture('true', {
    'krn.json': JSON.stringify({ test: 'node check.mjs' }),
    'check.mjs': `const files = process.argv.slice(2);
if (files.length === 0 || ${rerun === 'fail'}) {
  console.log(' FAIL  test/flaky.test.ts > times out under load');
  process.exit(1);
}
console.log('reran ' + files.join(' '));
`,
  });
}

test('a red baseline reruns only its failing test files once and passes when they pass alone', () => {
  // Seen on the pilot: lanes run one at a time still refused with 72 while the suite passed by hand.
  const { base, repo } = flakyBaseline('pass');
  try {
    const flaky: string[] = [];
    assert.equal(prepareWorktree(repo, 'main', repo, flaky), undefined);
    assert.deepEqual(flaky, ['test/flaky.test.ts']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('settledRun: fail then pass is flaky, fail then fail stays red, a nameless failure is not rerun', () => {
  const failed = { status: 1, stdout: ' FAIL  test/a.test.ts > slow\n' };
  const commands: string[] = [];
  const stub = (results: Array<{ status: number; stdout: string }>) => {
    commands.length = 0;
    return (command: string) => {
      commands.push(command);
      return results.shift() as { status: number; stdout: string };
    };
  };
  const pass = { status: 0, stdout: '' };
  const flaky = settledRun(stub([failed, pass]), 'node t.mjs');
  assert.equal(flaky.run.status, 0);
  assert.deepEqual(flaky.flaky, ['test/a.test.ts']);
  assert.deepEqual(commands, ['node t.mjs', "node t.mjs 'test/a.test.ts'"]);
  const red = settledRun(stub([failed, failed]), 'node t.mjs');
  assert.equal(red.run.status, 1);
  assert.deepEqual(red.flaky, []);
  const nameless = settledRun(stub([{ status: 2, stdout: 'boom' }]), 'x');
  assert.equal(nameless.run.status, 2);
  assert.equal(commands.length, 1);
});

test('a vacuous test command refuses the lane before the session with 72', () => {
  const { base, repo } = flakyBaseline('pass');
  try {
    writeFileSync(join(repo, 'krn.json'), '{"test":"exit 0","vacuous":true}\n');
    const refusal = prepareWorktree(repo, 'main', repo);
    assert.equal(refusal?.exitCode, 72);
    assert.match(refusal?.detail ?? '', /vacuous/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a red baseline whose failing files fail again refuses with 72 and names them', () => {
  const { base, repo } = flakyBaseline('fail');
  try {
    const refusal = prepareWorktree(repo, 'main', repo);
    assert.equal(refusal?.exitCode, 72);
    assert.match(refusal?.detail ?? '', /failing: test\/flaky\.test\.ts\)/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run removes the empty placeholders a session left in the main checkout and keeps a non-empty one', async () => {
  const { base, repo, claude } = fixture('');
  const gitDir = join(repo, '.git');
  writeFileSync(
    claude,
    `#!/bin/sh\n: > '${join(repo, '.mcp.json')}'; : > '${join(gitDir, 'config.lock')}'; chmod 444 '${join(repo, '.mcp.json')}' '${join(gitDir, 'config.lock')}'; echo keep > '${join(repo, '.npmrc')}'; ${deliver()}\ncat <<'JSON'\n${capture}\nJSON\n`,
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], {
      start: startLane,
      ship: async () => 'verdict: merged abc1234',
      mint: async () => undefined,
    });
    assert.equal(existsSync(join(repo, '.mcp.json')), false);
    assert.equal(existsSync(join(gitDir, 'config.lock')), false);
    assert.equal(existsSync(join(repo, '.npmrc')), true);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});
