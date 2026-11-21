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
import {
  parseSessionResult,
  repeatedStopRefusal,
  transcriptTurns,
} from '../../evals/replay/session-result.ts';
import { readExposures } from '../../src/brain/exposures.ts';
import { SERVE_POLICY } from '../../src/brain/packet.ts';
import { startLane } from '../../src/cli/lane.ts';
import { laneBriefText, workerRules } from '../../src/cli/lane-brief.ts';
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
  sessionEnvironment,
  sessionTimeoutMs,
  tokenMinimumRemainingSeconds,
} from '../../src/cli/lane-run/environment.ts';
import { receiverGaps } from '../../src/cli/lane-run/receiver.ts';
import {
  redCheckFile,
  redCheckFinding,
  redCheckOf,
} from '../../src/cli/lane-run/red-check.ts';
import { mintFailure } from '../../src/cli/lane-run/steps.ts';
import {
  failingTests,
  settledRun,
} from '../../src/cli/lane-run/test-output.ts';
import { laneRunCommand } from '../../src/cli/lane-run.ts';
import { CliUsageError } from '../../src/cli-kit/usage-error.ts';
import { rerunCommand } from '../../src/repo/contract.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';

admitLanesOnAnyHost();

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
  taskBody: string[] = ['Outcome: o'],
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
        body: taskBody,
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
    // Tokens by type from modelUsage; at the list price they sum to the reported cost.
    tokens: {
      input: 2,
      output: 4,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 21474,
    },
    model: 'claude-sonnet-5-5',
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

// The Stop hook lets a session end on any line `BLOCKER: <reason>` (bold or not, anywhere in the last
// message), so the lane run must read the same line, or the commit of a session that declared a blocker ships.
test('parseSessionResult reads the BLOCKER line the Stop hook accepts', () => {
  const blocked = (text: string) =>
    parseSessionResult(JSON.stringify({ ...JSON.parse(capture), result: text }))
      .blocker;
  assert.equal(
    blocked(
      'The test cannot be red at the base.\n**BLOCKER:** a new test of an existing function passes at the base',
    ),
    'BLOCKER: a new test of an existing function passes at the base',
  );
  assert.equal(
    blocked(
      'BLOCKER: clause 1 cannot fail at the base\nThe commit is on the branch.',
    ),
    'BLOCKER: clause 1 cannot fail at the base',
  );
  assert.equal(blocked('BLOCKER:'), undefined);
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
  delete process.env.KRN_APP_CACHE_DIR;
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
    assert.match(env, /^CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1$/mu);
    assert.match(
      env,
      /^GIT_CONFIG_VALUE_\d+=.*github-app-token\.ts' git-credential$/mu,
    );
  } finally {
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'KRN_APP_CACHE_DIR',
    ])
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

for (const [name, fixtureName, pattern] of [
  ['a red baseline', 'check-runs-main-red', /baseline is red/u],
  [
    'a missing required Check',
    'rules-missing',
    /no single required status check/u,
  ],
] as const)
  test(`lane run refuses ${name} with exit 72 before any session or claim`, async () => {
    const { base, repo, claude } = fixture('touch started');
    process.env.KRN_LANE_CLAUDE = claude;
    // A GitHub origin makes the lane probe its receiver; the probe reads the verbatim captures.
    git(
      repo,
      'remote',
      'set-url',
      'origin',
      'https://github.com/krn-works/krn.git',
    );
    const read = (file: string) =>
      readFileSync(
        new URL(`../fixtures/gh/${file}.stdout.json`, import.meta.url),
        'utf8',
      );
    const missing = fixtureName === 'rules-missing';
    let started = false;
    try {
      const verdict = await laneRunCommand(
        ['--task', 't-abc1234', '--root', repo],
        {
          start: async (args) => {
            started = true;
            return startLane(args);
          },
          ship: async () => 'unreachable',
          mint: async () => undefined,
          receiver: async (_root, branch) =>
            receiverGaps(branch, {
              repo: read('repo-krn-works-krn'),
              branch: read(
                missing
                  ? 'branch-unprotected-krn-works-krn'
                  : 'branch-main-krn-works-krn',
              ),
              rules: read(
                missing
                  ? 'rules-branches-unprotected-krn-works-krn'
                  : 'rules-branches-main-krn-works-krn',
              ),
              checkRuns: read(missing ? 'check-runs-main-green' : fixtureName),
            }),
        },
      );
      assert.equal(verdict.exitCode, 72);
      assert.match(verdict.line, /receiver not ready, no session started/u);
      assert.match(verdict.line, pattern);
      assert.equal(started, false);
      assert.equal(
        spawnSync('test', ['-e', join(base, 'repo', 'started')]).status,
        1,
      );
      assert.equal(existsSync(join(repo, '.krn', 'worktrees')), false);
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
      fileURLToPath(new URL('../fixtures/conventions.json', import.meta.url)),
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
      .replace(`\n\n${workerRules(dir)}\n`, '\n')
      .replace(
        /\n\nAcceptance clauses \(write them first\):[^\n]*\n[^\n]*(?=\n$)/u,
        '',
      );
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
        `Repository conventions (brain packet ${sha.slice(0, 12)}; ${SERVE_POLICY}):\n- [r-trailer] `,
      ),
      prompt,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
    rmSync(seen, { recursive: true, force: true });
  }
});

test('a lane run appends the served standards and the outcome to the exposure log', async () => {
  const conventions = `[
  {"id": "r-trailer", "type": "convention", "text": "Every commit for a task carries a Ticket trailer.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md"},
  {"id": "r-unrelated", "type": "convention", "text": "Zebra stripes persist.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md"}
]
`;
  const { base, repo, claude } = fixture(deliver(), {
    '.krn/conventions.json': conventions,
  });
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
    const [entry] = readExposures(repo);
    assert.equal(entry?.task, 't-abc1234');
    assert.equal(entry?.channel, 'lane');
    assert.deepEqual(entry?.served, ['r-trailer']);
    // Only the task's deterministic holdout is withheld; a record that merely did not match is not.
    assert.ok(!(entry?.withheld ?? []).includes('r-trailer'));
    // The record has no check of its own, so the run outcome is not copied onto it.
    assert.deepEqual(entry?.violated, { 'r-trailer': null });
    assert.equal(entry?.schema, 'krn.exposure/v1');
    assert.equal(entry?.attempt, 1);
    assert.ok((entry?.tokens ?? 0) > 0);
    assert.equal(entry?.lane_ok, true);
    assert.ok(!('rework' in (entry ?? {})));
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
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

test('a rerun that reuses a worktree holding a failed attempt commit names that commit in the session prompt', async () => {
  const { base, repo, claude } = fixture(
    'git commit -q --allow-empty -m "wip: earlier attempt"',
  );
  process.env.KRN_LANE_CLAUDE = claude;
  const steps = {
    start: startLane,
    ship: async () => 'unreachable',
    mint: async () => undefined,
  };
  const argv = join(base, 'argv');
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    const prompt = readFileSync(argv, 'utf8');
    assert.match(
      prompt,
      /Reused worktree: this lane branch already holds 1 commit\(s\) from a failed attempt \([0-9a-f]+ wip: earlier attempt\)/u,
    );
    assert.match(prompt, /last-refusal\.txt/u);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
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

test('a rerun after a session that closed its task but never reached ship starts a new session', async () => {
  // Seen on pilot-py t-2s70evn: a killed session left the task closed, and the rerun shipped it with no session and no Stop.
  const { base, repo, claude } = fixture(deliver(undefined, false));
  process.env.KRN_LANE_CLAUDE = claude;
  const steps = {
    start: startLane,
    ship: async () => 'unreachable',
    mint: async () => undefined,
  };
  const sessions = join(base, 'sessions');
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    writeFileSync(
      claude,
      `#!/bin/sh\necho run >> '${sessions}'\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    assert.equal(existsSync(sessions), true, 'the rerun started no session');
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a handed-off commit that conflicts with the moved base reruns in a session told to rebase, not a repeated ship', async () => {
  // Seen on pilot-py t-03pvpwp: every rerun shipped the same commit and hit the same conflict (exit 76).
  const { base, repo, claude } = fixture(
    `printf 'lane\\n' >> shared.txt; git add shared.txt; ${deliver()}`,
    { 'shared.txt': 'seed\n' },
  );
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: string[][] = [];
  const steps = {
    start: startLane,
    ship: async (args: string[]) => {
      shipped.push(args);
      throw new Error('push rejected');
    },
    mint: async () => undefined,
  };
  const argv = join(base, 'argv');
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    assert.equal(shipped.length, 1);
    assert.ok(
      shipped[0]?.includes('--force'),
      'a lane ship may push a rebased branch',
    );
    writeFileSync(join(repo, 'shared.txt'), 'seed\nbase\n');
    git(repo, 'commit', '-qam', 'base moves');
    git(repo, 'push', '-q', 'origin', 'main');
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    assert.equal(existsSync(argv), true, 'the rerun shipped without a session');
    assert.match(
      readFileSync(argv, 'utf8'),
      /Base moved: this lane branch conflicts with origin\/main in shared\.txt/u,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a rerun that ships an earlier delivery installs the dependencies its final check needs', async () => {
  // Seen on pilot-py: the rerun of a delivered lane skipped the session and the install, so the final check found no .venv.
  // No fast-pass marker: the runner proves the tree with the contract test itself.
  const { base, repo, claude } = fixture(deliver(undefined, false), {
    'krn.json': JSON.stringify({
      install: 'mkdir -p .deps && touch .deps/ok',
      test: 'test -f .deps/ok',
      tracker: 'krn',
    }),
    '.gitignore': '.krn\nnode_modules\n.deps/\n',
  });
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
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode, 74, first.line);
    // The worktree an earlier release left had no dependencies.
    rmSync(join(repo, '.krn', 'worktrees', 't-abc1234', '.deps'), {
      recursive: true,
    });
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
      `Check concluded failure on ${sha} in run 43501009193; logs: gh run view 43501009193 --log-failed; rerun: gh run rerun 43501009193 --failed`,
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
        `ship: Check concluded failure on ${redSha} in run 43501009193; logs: gh run view 43501009193 --log-failed`,
      );
    },
    mint: async () => undefined,
    ciLogs: async (run: string) => {
      logRuns.push(run);
      return ciLogsCapture('logs-test-shard-43501061076.txt');
    },
  };
  const efforts = join(base, 'efforts.txt');
  const rewrite = (action: string) =>
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s' "$2" > '${brief}'\nprev=; for a in "$@"; do [ "$prev" = --effort ] && echo "$a" >> '${efforts}'; prev=$a; done\n${action}\ncat <<'JSON'\n${capture}\nJSON\n`,
    );
  try {
    rewrite(deliver());
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
      /Failing job and step: Test \(11\/13\): failure; failed step 4 Run test shard/u,
    );
    assert.match(
      text,
      /First finding: failing tests: test\/portability\/fixtures\.test\.ts \(2 failed\)/u,
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
    // The first turn ran at low effort; every turn after the red Check ran at high.
    assert.deepEqual(readFileSync(efforts, 'utf8').trim().split('\n'), [
      'low',
      'high',
      'high',
    ]);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a commit parked while the App token is locked ships on rerun without the worker', async () => {
  const { base, repo, claude } = fixture(
    deliver().replace('"Ticket: t-abc1234"', '"Refs: t-abc1234"'),
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    let mints = 0;
    let ships = 0;
    const steps = {
      start: startLane,
      ship: async () => {
        ships += 1;
        return 'verdict: merged abc';
      },
      // The first mint opens the session; the mint before ship finds the vault locked.
      mint: async () => (++mints === 2 ? 'vault is locked' : undefined),
    };
    const parked = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(parked.exitCode, 69, parked.line);
    assert.match(parked.line, /commit parked/u);
    assert.equal(ships, 0);
    assert.equal(inspectClaim(repo, 't-abc1234').state, 'none');

    // The worker would fail loudly: only the parked commit may ship.
    process.env.KRN_LANE_CLAUDE = join(base, 'no-such-claude');
    const resumed = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(resumed.exitCode, 0, resumed.line);
    assert.equal(ships, 1);
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

test('lane run runs the contract install before the session', async () => {
  const out = await runPrepared({
    'krn.json': JSON.stringify({
      install:
        'mkdir -p node_modules/dep && echo {} > node_modules/dep/package.json',
      test: 'true',
    }),
  });
  assert.equal(out.started, true, out.verdict.line);
  assert.equal(out.installed, true);
});

// The base suite runs once on the untouched worktree before the session; the red node:test capture is verbatim.
const redBaseFiles = {
  'krn.json': JSON.stringify({
    test: 'cat red.txt; exit 1',
    tracker: 'krn',
  }),
  'red.txt': readFileSync(
    fileURLToPath(
      new URL('../fixtures/node-test/failing-run.stdout.txt', import.meta.url),
    ),
    'utf8',
  ),
};

test('lane run exits 72 naming the failing files of a red base and spawns no session', async () => {
  const out = await runPrepared(redBaseFiles);
  assert.equal(out.verdict.exitCode, 72, out.verdict.line);
  assert.match(
    out.verdict.line,
    /the base suite is red \(failing files test\/math\.test\.mjs;.*no session started/u,
  );
  assert.equal(out.started, false);
  assert.notEqual(out.claim.state, 'live');
});

test('lane run exits 78 when the base suite fails with timeouts only', async () => {
  const out = await runPrepared({
    'krn.json': JSON.stringify({
      test: 'echo "FAIL test/slow.test.ts > waits"; echo "Error: Test timed out in 5000ms."; exit 1',
      tracker: 'krn',
    }),
  });
  assert.equal(out.verdict.exitCode, 78, out.verdict.line);
  assert.match(out.verdict.line, /timeouts only .*test\/slow\.test\.ts/u);
  assert.equal(out.started, false);
});

test('lane run names a red base that prints no failing file by its exit status', async () => {
  const out = await runPrepared({
    'krn.json': JSON.stringify({ test: 'exit 3', tracker: 'krn' }),
  });
  assert.equal(out.verdict.exitCode, 72, out.verdict.line);
  assert.match(out.verdict.line, /exit 3 exited 3|exited 3/u);
  assert.equal(out.started, false);
});

test('a green base run is cached per base SHA: a second run does not rerun the suite', async () => {
  const { base, repo, claude } = fixture('echo x > started', {
    'krn.json': JSON.stringify({
      test: 'test -f started || echo run >> "$KRN_COUNT_FILE"',
      tracker: 'krn',
    }),
  });
  const counter = join(base, 'count');
  process.env.KRN_LANE_CLAUDE = claude;
  process.env.KRN_COUNT_FILE = counter;
  const steps = {
    start: startLane,
    ship: async () => 'unreachable',
    mint: async () => undefined,
  };
  try {
    const first = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      steps,
    );
    assert.equal(first.exitCode !== 72, true, first.line);
    // Only the base run counts: the final check runs after the session wrote `started`.
    const runs = () => readFileSync(counter, 'utf8').split('\n').length - 1;
    const afterFirst = runs();
    assert.equal(afterFirst, 1);
    // The same base SHA on a fresh lane worktree: the cached green answers.
    git(
      repo,
      'worktree',
      'remove',
      '--force',
      join(repo, '.krn', 'worktrees', 't-abc1234'),
    );
    git(repo, 'branch', '-D', 't-abc1234');
    await laneRunCommand(['--task', 't-abc1234', '--root', repo], steps);
    assert.equal(runs(), afterFirst);
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    delete process.env.KRN_COUNT_FILE;
    rmSync(base, { recursive: true, force: true });
  }
});

// KRN-12: the pilot-py contract shape (a venv install, a test command that needs .venv); offline, without pip.
test('lane run builds the Python venv of the contract before the session starts', async () => {
  const { base, repo } = fixture('true', {
    'krn.json': JSON.stringify({
      install: 'python3 -m venv --without-pip .venv',
      test: '.venv/bin/python -c pass',
      tracker: 'krn',
    }),
    '.gitignore': '.krn\n.venv/\n',
  });
  const claude = join(base, 'claude-venv');
  writeFileSync(
    claude,
    `#!/bin/sh\ntest -x .venv/bin/python && .venv/bin/python -c 'print(1)' > started\ncat <<'JSON'\n${capture}\nJSON\n`,
  );
  chmodSync(claude, 0o755);
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
    const worktree = join(repo, '.krn', 'worktrees', 't-abc1234');
    assert.equal(
      existsSync(join(worktree, 'started')),
      true,
      `the session saw no .venv: ${verdict.line}`,
    );
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane run exits 71 naming a failed install, starts no session and releases the claim', async () => {
  const out = await runPrepared({
    'krn.json': JSON.stringify({
      install: 'echo no network >&2; exit 3',
      test: 'exit 1',
    }),
  });
  assert.equal(out.verdict.exitCode, 71);
  assert.match(
    out.verdict.line,
    /preflight install failed, no session started: the install command failed \(echo no network.*exit 3: no network\)/u,
  );
  assert.equal(out.started, false);
  assert.notEqual(out.claim.state, 'live');
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

test('failingTests reads plain jest and pytest failure lines', () => {
  assert.deepEqual(
    failingTests(
      'FAIL src/a.test.js\nFAILED tests/test_b.py::test_x - assert 1 == 2\n',
    ),
    ['src/a.test.js', 'tests/test_b.py'],
  );
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

test('a lane session mints and helps git for its own origin repository', () => {
  const env = { PATH: '/bin', KRN_APP_REPOSITORY: 'krn-works/krn' };
  assert.equal(
    sessionEnvironment(env, '/c', {
      lane: 'l',
      repository: 'krn-works/seo-audit-harness',
    }).KRN_APP_REPOSITORY,
    'krn-works/seo-audit-harness',
  );
  assert.equal(
    sessionEnvironment({ PATH: '/bin' }, '/c', { lane: 'l' })
      .KRN_APP_REPOSITORY,
    undefined,
  );
});

test('a lane session environment holds one helper pair however many generations inherit it', () => {
  let env: NodeJS.ProcessEnv = {
    PATH: '/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
  for (let generation = 0; generation < 4; generation += 1)
    env = sessionEnvironment(env, '/c', { lane: 'l' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_0, '*');
  assert.equal(env.GIT_CONFIG_KEY_3, undefined);
});

test('a lane session disables the advisor tool unless the brief opts in', () => {
  const env = { PATH: '/bin' };
  assert.equal(
    sessionEnvironment(env, '/c', { lane: 'l' })
      .CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
    '1',
  );
  assert.equal(
    sessionEnvironment(
      { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' },
      '/c',
      { lane: 'l', advisor: true },
    ).CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
    undefined,
  );
});

// KRN-12: a real testless git clone (vacuous contract, seeded first-test task), a stub session that writes the test.
const bootstrapFiles = (title: string): Record<string, string> => ({
  'krn.json': JSON.stringify({
    test: 'exit 1',
    tracker: 'krn',
    vacuous: true,
  }),
  'lib.mjs': 'export const add = (a, b) => {\n  return a + b;\n};\n',
  'tasks/t-abc1234.json': `${JSON.stringify(
    {
      id: 't-abc1234',
      status: 'open',
      resolution: null,
      created: '2026-11-09',
      priority: 1,
      title,
      after: [],
      body: ['Outcome: one real test'],
    },
    null,
    2,
  )}\n`,
});

const writeTest = (body: string) =>
  `cat > check.mjs <<'EOF'\n${body}\nEOF\necho '{"test":"node check.mjs","tracker":"krn"}' > krn.json\ngit add -A\n${deliver('test(x): first test (t-abc1234)', false)}`;

async function bootstrapRun(title: string, sessionTest: string) {
  const { base, repo, claude } = fixture(
    writeTest(sessionTest),
    bootstrapFiles(title),
  );
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: string[][] = [];
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async (args) => {
          shipped.push(args);
          return 'verdict: merged abc1234';
        },
        mint: async () => undefined,
      },
    );
    const body =
      shipped[0] === undefined
        ? ''
        : readFileSync(
            shipped[0][shipped[0].indexOf('--body-file') + 1] ?? '',
            'utf8',
          );
    return { verdict, body, shipped: shipped.length };
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
}

test('lane run delivers the seeded first-test task on a vacuous contract, proven red on mutation and green on revert', async () => {
  const out = await bootstrapRun(
    'one real test and a test command',
    "import { add } from './lib.mjs';\nif (add(1, 2) !== 3) process.exit(1);",
  );
  assert.equal(out.verdict.exitCode, 0, out.verdict.line);
  assert.equal(out.shipped, 1);
  assert.match(
    out.body,
    /went red with line 1 of lib\.mjs deleted .* green on revert; bootstrap state cleared/u,
  );
});

test('a first test that never calls production code is not delivered', async () => {
  const out = await bootstrapRun(
    'one real test and a test command',
    'if (1 + 1 !== 2) process.exit(1);',
  );
  assert.notEqual(out.verdict.exitCode, 0);
  assert.match(out.verdict.line, /does not exercise production code/u);
  assert.equal(out.shipped, 0);
});

const lockedManifest = (version: string) =>
  `${JSON.stringify({ name: 'locked-pkg', version }, null, 2)}\n`;
const lockfileOf = (version: string) =>
  `${JSON.stringify(
    {
      name: 'locked-pkg',
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'locked-pkg', version } },
    },
    null,
    2,
  )}\n`;

async function runWithManifest(action: string, files: Record<string, string>) {
  const { base, repo, claude } = fixture(action, files);
  process.env.KRN_LANE_CLAUDE = claude;
  const shipped: { lock: string; subjects: string[] }[] = [];
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        ship: async (args) => {
          const worktree = args[args.indexOf('--worktree') + 1] as string;
          shipped.push({
            lock: readFileSync(join(worktree, 'package-lock.json'), 'utf8'),
            subjects: git(worktree, 'log', '--format=%s', 'origin/main..HEAD')
              .split('\n')
              .filter(Boolean),
          });
          return 'verdict: merged abc1234';
        },
        mint: async () => undefined,
      },
    );
    return { verdict, shipped };
  } finally {
    delete process.env.KRN_LANE_CLAUDE;
    rmSync(base, { recursive: true, force: true });
  }
}

test('lane run regenerates the tracked lockfile on the host when the worker changed package.json', async () => {
  const { verdict, shipped } = await runWithManifest(
    `sed -i 's/"1.0.0"/"2.0.0"/' package.json; ${deliver()}`,
    {
      'package.json': lockedManifest('1.0.0'),
      'package-lock.json': lockfileOf('1.0.0'),
    },
  );
  assert.equal(verdict.exitCode, 0, verdict.line);
  assert.equal(shipped.length, 1);
  assert.equal(JSON.parse(shipped[0]?.lock ?? '').version, '2.0.0');
  assert.match(shipped[0]?.subjects[0] ?? '', /regenerate the lockfile/u);
});

test('lane run leaves the lockfile alone when package.json did not change', async () => {
  const { verdict, shipped } = await runWithManifest(
    `echo y > note.txt; git add note.txt; ${deliver()}`,
    {
      'package.json': lockedManifest('1.0.0'),
      'package-lock.json': lockfileOf('1.0.0'),
    },
  );
  assert.equal(verdict.exitCode, 0, verdict.line);
  assert.equal(shipped[0]?.subjects.length, 1);
});

// Stop refusals as the session transcript records them (stop_hook_summary lines, one JSON object per line).
const stopHook =
  "command -v krn >/dev/null 2>&1 || { while read -r _; do :; done; echo 'krn is not on PATH'; exit 2; }; exec krn hook stop";
function refusal(text: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
    hookInfos: [{ command: stopHook }],
    hookErrors: [`[${stopHook}]: ${text}\n`],
    preventedContinuation: false,
    hasOutput: true,
  });
}
const failingRefusal =
  'Stop refused: 1 related test(s) fail that passed at the base:\n- test/parse.test.ts: parses a plain list\nFix them and commit, or end with a line `BLOCKER: <what stops you>`.';
function edit(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'src/parse.ts', new_string: text },
        },
      ],
    },
  });
}

test('three identical Stop refusals with no edit between them are no progress', () => {
  const transcript = [
    refusal(failingRefusal),
    refusal(failingRefusal),
    refusal(failingRefusal),
  ].join('\n');
  assert.match(repeatedStopRefusal(transcript) ?? '', /parses a plain list/u);
});

test('an edit between refusals, a changed refusal or only two refusals is progress', () => {
  const same = refusal(failingRefusal);
  assert.equal(
    repeatedStopRefusal([same, edit('a'), same, same].join('\n')),
    undefined,
  );
  assert.equal(
    repeatedStopRefusal(
      [same, same, refusal(`${failingRefusal} again`)].join('\n'),
    ),
    undefined,
  );
  assert.equal(repeatedStopRefusal([same, same].join('\n')), undefined);
});

test('a failed session whose transcript shows no progress exits 79 naming the repeated refusal', async () => {
  const config = mkdtempSync(join(tmpdir(), 'krn-lane-run-config-'));
  mkdirSync(join(config, 'projects', 'p'), { recursive: true });
  writeFileSync(
    join(config, 'projects', 'p', 'sess-np.jsonl'),
    `${[refusal(failingRefusal), refusal(failingRefusal), refusal(failingRefusal)].join('\n')}\n`,
  );
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const { verdict } = await run(
      `printf '%s' '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-np","total_cost_usd":1.5}'; exit 0`,
    );
    assert.equal(verdict.exitCode, 79);
    assert.match(verdict.line, /no progress: 3 identical Stop refusals/u);
    assert.match(verdict.line, /Stop refused: 1 related test/u);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(config, { recursive: true, force: true });
  }
});

test('clause 6: a lane ending prints the proof line from the real Stop log, the brief and the tree', async () => {
  const config = mkdtempSync(join(tmpdir(), 'krn-lane-run-config-'));
  mkdirSync(join(config, 'projects', 'p'), { recursive: true });
  writeFileSync(
    join(config, 'projects', 'p', 'sess-pl.jsonl'),
    `${[refusal(failingRefusal), edit('a'), refusal(`${failingRefusal} again`)].join('\n')}\n`,
  );
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const { verdict } = await run(
      `printf '%s' '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-pl","total_cost_usd":1.5}'; exit 0`,
    );
    assert.match(
      verdict.proof ?? '',
      /^proof: clauses \d+\/\d+, red-first [01], precedent \d+ modules, stop refusals 2, diff-coverage n\/a$/u,
    );
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(config, { recursive: true, force: true });
  }
});

// The merged outside lane of rerun 1115i (npm, t-0lpk5qu): the task body and the test file are verbatim from its
// session transcript; ship removed the lane worktree, and the proof line then read an empty tree and printed 0/4.
const outsideBody = [
  'Outcome: the repository has one real test and a test command in krn.json that runs it; "vacuous" is dropped from krn.json.',
  'Why: the base declares no test command, and lane run admits only this task on it.',
  'Proof: the test command exits 0 and runs at least one test.',
];
const outsideTest = `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const krn = JSON.parse(readFileSync(new URL("../krn.json", import.meta.url), "utf8"));

test("clause 1: sha256 hashes a hand-written input", () => {
  assert.equal(1, 1);
});

test("clause 2: krn.json no longer carries vacuous", () => {
  assert.equal("vacuous" in krn, false);
});

test("clause 3: krn.json declares a real test command", () => {
  assert.match(krn.test, /node --test/);
});

test("clause 4: the declared command targets this test file", () => {
  assert.equal(krn.test, "node --test test/*.test.mjs");
});
`;

test('failingTests names the file of a red node:test TAP run, so a preamble warning is never the failing file', () => {
  assert.deepEqual(
    failingTests(fixtureText('node-test/tap-red-run.stdout.txt')),
    ['/work/repo/test/claude/worker-stop.test.ts'],
  );
});

test('clause 8: a merged lane prints the proof of the tree it shipped, though ship removed its worktree', async () => {
  const { base, repo, claude } = fixture(
    `mkdir -p test; cat > test/shell-hash.test.mjs <<'EOF'\n${outsideTest}EOF\ngit add test; ${deliver()}`,
    {},
    capture,
    outsideBody,
  );
  process.env.KRN_LANE_CLAUDE = claude;
  try {
    const verdict = await laneRunCommand(
      ['--task', 't-abc1234', '--root', repo],
      {
        start: startLane,
        // The real ship merges, then removes the lane worktree and branch.
        ship: async (args) => {
          const worktree = args[args.indexOf('--worktree') + 1] ?? '';
          git(repo, 'worktree', 'remove', '--force', worktree);
          return 'merged\nverdict: merged abc1234';
        },
        mint: async () => undefined,
      },
    );
    assert.equal(verdict.exitCode, 0, verdict.line);
    assert.match(verdict.proof ?? '', /^proof: clauses 4\/4, /u);
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
