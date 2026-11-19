import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deadlineMs,
  exemption,
  gated,
  gateEntry,
  hostConfig,
  isHeavy,
  judge,
} from '../../src/hook/heavy-command.ts';

const entry = fileURLToPath(
  new URL('../../src/hook/heavy-command.ts', import.meta.url),
);

function repo(name: string, krn = false): string {
  const root = join(mkdtempSync(join(tmpdir(), 'heavy-command-')), name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'sub'));
  if (krn) {
    mkdirSync(join(root, 'scripts', 'host'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'host', 'heavy-gate.ts'), '');
  }
  return root;
}

const payload = (command: string, cwd: string, extra = {}) => ({
  session_id: 's',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  cwd,
  tool_input: { command, description: 'run', ...extra },
});

// KRN-12: the real entry the user-scope hook runs, fed the payload Claude Code sends.
function run(command: string, cwd: string, args: string[] = [], extra = {}) {
  const env = { ...process.env };
  delete env.KRN_TEST_SLOT_HELD;
  delete env.KRN_HEAVY_GATE_EXCLUDE;
  return spawnSync(process.execPath, [entry, ...args], {
    input: JSON.stringify(payload(command, cwd, extra)),
    encoding: 'utf8',
    env,
  });
}

test('test runs, builds, installs and browser tests are heavy; servers, watchers and plain commands are not', () => {
  for (const command of [
    'npm test',
    'pnpm install',
    'npm ci',
    'npm run build',
    'yarn test:unit --reporter dot',
    'cd app && CI=1 npx playwright test e2e/',
    'timeout 900 mise run check:browser',
    'node --test test/a.test.ts > log 2>&1',
    'uv run pytest -q',
    'python3 -m pytest tests',
    'cargo test',
    'go test ./...',
    'composer install',
    'time npx tsc --noEmit',
    'npm install -w packages/app',
  ])
    assert.equal(isHeavy(command), true, command);
  for (const command of [
    'npm run dev',
    'npx vitest --watch',
    'npx playwright test --ui',
    'npm run start',
    'npm run test:watch',
    'npx jest --watchAll',
    "cat > notes.md <<'EOF'\nnpm install\nEOF",
    "git commit -m 'run npm test first'",
    'git status',
    'ls node_modules',
    'echo npm test',
    'cat package.json',
  ])
    assert.equal(isHeavy(command), false, command);
});

test('the Claude Code form rewrites a heavy command into the gate with the Bash timeout halved', () => {
  const root = repo('shop');
  const result = run('cd sub && npm test', root, [], { timeout: 600000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const input = output.hookSpecificOutput.updatedInput;
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(input.description, 'run');
  assert.equal(input.timeout, 600000);
  assert.equal(
    input.command,
    `cd sub && '${gateEntry}' run --deadline-ms 300000 -- bash -c 'npm test'`,
  );
});

test('the gated command runs the original through bash with its quoting intact', () => {
  const command = `echo 'it''s' "a b"`;
  const result = spawnSync(
    'bash',
    [
      '-c',
      gated(command, 1000, 'env').replace(' run --deadline-ms 1000 --', ''),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.stdout, 'its a b\n');
});

test('the Codex form refuses with the wrapped command to run instead', () => {
  const root = repo('shop');
  const result = run('npm run build', root, ['--codex']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /heavy-job gate/u);
  assert.ok(
    result.stderr.includes(
      `'${gateEntry}' run --deadline-ms 60000 -- bash -c 'npm run build'`,
    ),
  );
});

test('a light command passes with no output', () => {
  const result = run('git status', repo('shop'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('wilq-seo is never gated, by cwd or by a path in the command', () => {
  const env = {};
  assert.match(
    exemption('npm test', join(repo('wilq-seo'), 'sub'), env) ?? '',
    /wilq-seo is never gated/u,
  );
  assert.match(
    exemption('cd /x/wilq-seo && npm test', repo('shop'), env) ?? '',
    /wilq-seo/u,
  );
  assert.equal(run('npm test', repo('wilq-seo')).stdout, '');
});

test('KRN_HEAVY_GATE_EXCLUDE replaces the excluded repositories', () => {
  const env = { KRN_HEAVY_GATE_EXCLUDE: 'shop' };
  assert.ok(exemption('npm test', repo('shop'), env));
  assert.equal(exemption('npm test', repo('wilq-seo'), env), undefined);
});

test('a command already gated, inside a slot or in a KRN checkout passes unchanged', () => {
  const shop = repo('shop');
  assert.ok(exemption('heavy-gate run -- npm test', shop, {}));
  assert.ok(exemption(`'/a/bin/heavy-gate' run -- npm test`, shop, {}));
  assert.ok(exemption('npm test', shop, { KRN_TEST_SLOT_HELD: '1' }));
  assert.ok(exemption('npm test', join(repo('krn', true), 'sub'), {}));
  assert.equal(judge(payload('npm test', repo('krn', true)), {}), undefined);
});

test('a background run waits up to half an hour; a foreground one at least ten seconds', () => {
  assert.equal(deadlineMs({ run_in_background: true }), 1_800_000);
  assert.equal(deadlineMs({}), 60_000);
  assert.equal(deadlineMs({ timeout: 5000 }), 10_000);
});

test('wilq-seo is never gated from one of its linked worktrees, whatever the worktree is named', () => {
  const main = repo('wilq-seo');
  const tree = join(mkdtempSync(join(tmpdir(), 'heavy-command-')), 'lane-1');
  mkdirSync(tree);
  writeFileSync(
    join(tree, '.git'),
    `gitdir: ${join(main, '.git', 'worktrees', 'lane-1')}\n`,
  );
  assert.match(exemption('npm test', tree, {}) ?? '', /wilq-seo/u);
});

test('the host config adds heavy patterns and excluded repositories', () => {
  const config = {
    exclude: ['shop'],
    heavy: [String.raw`^\S*python3? \S*replay\.py`],
  };
  const replay = '.venv/bin/python t8/replay.py candidate';
  assert.equal(isHeavy(replay), false);
  assert.equal(isHeavy(replay, config.heavy), true);
  const other = repo('bench');
  assert.ok(judge(payload(replay, other), {}, config));
  assert.equal(judge(payload('npm test', repo('shop')), {}, config), undefined);
});

test('an invalid host config is named and ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-command-'));
  const file = join(dir, 'heavy-gate.json');
  writeFileSync(file, JSON.stringify({ heavy: ['('] }));
  assert.deepEqual(hostConfig(file), { exclude: [], heavy: [] });
  assert.deepEqual(hostConfig(join(dir, 'absent.json')), {
    exclude: [],
    heavy: [],
  });
});
