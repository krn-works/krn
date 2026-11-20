import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  // An empty config home: the host's own heavy-gate.json never changes a verdict here.
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'cfg-'));
  return spawnSync(process.execPath, [entry, ...args], {
    input: JSON.stringify(payload(command, cwd, extra)),
    encoding: 'utf8',
    env,
  });
}

test('test runs, builds, installs and browser tests are heavy in watch mode too; servers and plain commands are not', () => {
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
    // Watch mode is no exemption: the gate's lease bounds how long it holds a slot.
    'npx vitest --watch',
    'npx playwright test --ui',
    'npm run test:watch',
    'npm run test:watch.js',
    'npx jest --watchAll',
  ])
    assert.equal(isHeavy(command), true, command);
  for (const command of [
    'npm run dev',
    'npm run start',
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
    `'${gateEntry}' run --deadline-ms 300000 -- bash -c 'cd sub && npm test'`,
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

test('wilq-seo is never gated, by cwd or by the directory the command runs in', () => {
  const env = {};
  assert.match(
    exemption('npm test', join(repo('wilq-seo'), 'sub'), env) ?? '',
    /wilq-seo is never gated/u,
  );
  for (const command of [
    'cd /x/wilq-seo && npm test',
    "cd '/x/wilq-seo/app' && npm test",
    'npm --prefix /x/wilq-seo test',
    'pnpm -C ../wilq-seo build',
    'pnpm --dir=/x/wilq-seo install',
  ])
    assert.match(
      exemption(command, repo('shop'), env) ?? '',
      /wilq-seo/u,
      command,
    );
  assert.equal(run('npm test', repo('wilq-seo')).stdout, '');
});

test('an excluded name in a comment, a message or an argument does not exempt the command', () => {
  const shop = repo('shop');
  for (const command of [
    'npm test # wilq-seo',
    'npm test && echo wilq-seo',
    'npm install wilq-seo',
    'npx vitest run test/wilq-seo/a.test.ts',
    "npm run build -- --name 'x/wilq-seo'",
  ])
    assert.equal(exemption(command, shop, {}), undefined, command);
});

test('a command with a heavy step is gated whole: one lease wraps the original text unchanged', () => {
  const gate = '/g/heavy-gate';
  const wrap = (inner: string, ms = 1000) =>
    `'${gate}' run --deadline-ms ${ms} -- bash -c '${inner}'`;
  for (const command of [
    'npm install && npm run dev',
    'cd app && npm ci && npm test',
    'npm test 2>&1 | tail -5',
    'for d in a b; do npm test; done',
    '(npm i && npm run dev)',
    'T=unit; npm test -- $T',
    'npm test -- --watch |\ncat',
  ])
    assert.equal(gated(command, 1000, gate), wrap(command), command);
  const shop = repo('shop');
  const none = { exclude: [], heavy: [] };
  assert.deepEqual(judge(payload('npm i && npm run dev', shop), {}, none), {
    rewrite: `'${gateEntry}' run --deadline-ms 60000 -- bash -c 'npm i && npm run dev'`,
  });
});

// The gate is replaced by a stand-in that drops its own arguments and runs the command: the wrapped
// command must behave as the original does in the same shell.
test('shell state, pipes, heredocs and comments reach the heavy step as they do without the gate', () => {
  const setup =
    'npm() { printf "<%s>\\n" "$@"; }\nexport -f npm\ngate() { shift 4; "$@"; }\n';
  for (const command of [
    'printf -v filter %s example.test.js; npm test -- --watch "$filter"',
    'printf -v T %s unit; npm test -- "$T"',
    'false && npm test; npm test',
    'npm test -- --watch |\ncat',
    'npm test # output |\necho after',
    'cat <<EOF | cat\nbody\nEOF\nnpm test',
    'set -o pipefail; npm test | tail -5',
  ]) {
    const exec = (line: string) =>
      spawnSync('bash', ['-c', setup + line], {
        encoding: 'utf8',
        timeout: 3000,
      });
    const original = exec(command);
    const verdict = judge(
      { tool_name: 'Bash', cwd: '/tmp', tool_input: { command } },
      {},
      { exclude: [], heavy: [] },
    );
    const rewritten = exec(
      verdict?.rewrite.replace(gateEntry, 'gate') ?? command,
    );
    assert.deepEqual(
      [rewritten.status, rewritten.stdout, rewritten.stderr],
      [original.status, original.stdout, original.stderr],
      command,
    );
  }
});

test('through the real gate, the whole command runs inside one slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-compound-'));
  const shim = join(dir, 'heavy-gate');
  const gateScript = fileURLToPath(
    new URL('../../scripts/host/heavy-gate.ts', import.meta.url),
  );
  writeFileSync(
    shim,
    `#!/bin/sh\nexec '${process.execPath}' '${gateScript}' "$@"\n`,
    { mode: 0o755 },
  );
  const command = gated(
    `echo in=$KRN_TEST_SLOT_HELD && printf 'out=%s\\n' "$KRN_TEST_SLOT_HELD"`,
    5000,
    shim,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KRN_HEAVY_GATE_DIR: join(dir, 'slots'),
  };
  delete env.KRN_TEST_SLOT_HELD;
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'in=1\nout=1\n');
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
  // A gate call beside an ungated heavy command exempts nothing.
  assert.equal(
    exemption('npm test && printf "%s\\n" "$(heavy-gate status)"', shop, {}),
    undefined,
  );
  assert.ok(exemption('npm test', shop, { KRN_TEST_SLOT_HELD: '1' }));
  assert.ok(exemption('npm test', join(repo('krn', true), 'sub'), {}));
  assert.equal(
    judge(
      payload('npm test', repo('krn', true)),
      {},
      { exclude: [], heavy: [] },
    ),
    undefined,
  );
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

// KRN-12: a verbatim Codex PreToolUse payload (paths redacted), captured from `codex exec` 0.170.
test('the Codex form refuses the captured Codex payload and names the gated command', () => {
  const capture = readFileSync(
    fileURLToPath(
      new URL('../fixtures/codex-hooks/pre-tool-use.json', import.meta.url),
    ),
    'utf8',
  );
  const env = { ...process.env };
  delete env.KRN_TEST_SLOT_HELD;
  delete env.KRN_HEAVY_GATE_EXCLUDE;
  const result = spawnSync(process.execPath, [entry, '--codex'], {
    input: capture,
    encoding: 'utf8',
    env: { ...env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'cfg-')) },
  });
  assert.equal(result.status, 2);
  assert.ok(
    result.stderr.includes(
      `'${gateEntry}' run --deadline-ms 60000 -- bash -c 'cd sub && npm test --prefix ..'`,
    ),
    result.stderr,
  );
});

test('a quoted Go test filter does not make the command a server', () => {
  const result = judge(
    {
      tool_name: 'Bash',
      tool_input: { command: "go test -run 'start' ./..." },
      cwd: '/tmp',
    },
    {},
    { exclude: [], heavy: [] },
  );
  assert.ok(result?.rewrite);
});

test('a test run is gated whether it names a watch file or runs in watch mode', () => {
  const result = judge(
    {
      tool_name: 'Bash',
      tool_input: { command: "npm test -- 'watch.test.js'" },
      cwd: '/tmp',
    },
    {},
    { exclude: [], heavy: [] },
  );
  assert.ok(result?.rewrite);
  const watching = judge(
    {
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- --watch' },
      cwd: '/tmp',
    },
    {},
    { exclude: [], heavy: [] },
  );
  assert.ok(watching?.rewrite);
});

test('a quoted test filter and a dotted watch script are gated like any test run', () => {
  const verdict = (command: string) =>
    judge(
      { tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' },
      {},
      { exclude: [], heavy: [] },
    );
  assert.ok(verdict("npm test -- -t 'start'")?.rewrite);
  assert.ok(verdict("go test -run 'start' ./...")?.rewrite);
  assert.ok(verdict('npm run test:watch.dev')?.rewrite);
  assert.ok(verdict('npm run test:watch.js')?.rewrite);
});
