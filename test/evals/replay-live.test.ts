import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withToolchain } from '../../evals/replay/arm-session.ts';
import { ARMS } from '../../evals/replay/arms.ts';
import * as live from '../../evals/replay/live.ts';
import { armEnv } from '../../evals/replay/live.ts';
import { parseRows } from '../../evals/replay/screen.ts';
import { type DrivenSession, sessionRan } from '../../evals/replay/session.ts';
import { parseSessionResult } from '../../evals/replay/session-result.ts';
import { openerPaths } from '../../evals/units/no-browser.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/**
 * Two fixture units over one local clone; the stub claude fixes only the unit whose prompt names "alpha" and makes a
 * wrong change on the other, so it is a graded fail rather than a no-attempt.
 */
function fixture(root: string) {
  const clone = join(root, 'sources', 'o__r');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'n');
  writeFileSync(join(clone, 'a.txt'), '1');
  writeFileSync(join(clone, '.gitignore'), 'build/\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const base = git(clone, 'rev-parse', 'HEAD');
  // The reference fix passes the unit's grader, so every fixture unit passes the grade preflight.
  writeFileSync(join(clone, 'a.txt'), '2');
  writeFileSync(join(clone, 'fixed.txt'), '');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const units = join(root, 'units');
  for (const [id, word] of [
    ['t-aaaaaaa', 'alpha'],
    ['t-bbbbbbb', 'beta'],
    ['t-ccccccc', 'alpha'],
  ] as const) {
    mkdirSync(join(units, id), { recursive: true });
    writeFileSync(join(units, id, 'hidden.txt'), 'present\n');
    writeFileSync(
      join(units, id, 'unit.json'),
      JSON.stringify({
        id,
        repo: 'o/r',
        base,
        reference,
        task: { title: `Fix ${word}`, body: `Why: ${word} is broken` },
        spec: 's',
        hidden: { file: 'hidden.txt', dest: 'hidden.check' },
        install: 'true',
        test: 'test -f fixed.txt && test ! -e build',
        committed: id === 't-ccccccc' ? '2026-01-01' : '2026-08-01',
        issue: `https://github.com/o/r/issues/${id.charCodeAt(2)}`,
      }),
    );
  }
  const log = join(root, 'scratch', 'sessions.log');
  const stub = join(root, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprompt="$*"\necho +1 >> ${log}\nshift 2\necho "$CLAUDE_CONFIG_DIR|$KRN_PROBE|$*" >> ${join(root, 'scratch', 'env.log')}\nsleep 0.4\nif echo "$prompt" | grep -q alpha; then touch fixed.txt; else touch tried.txt; fi\necho "$prompt" > ${join(root, 'scratch', 'prompt-')}$$\necho -1 >> ${log}\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.25}'\n`,
  );
  chmodSync(stub, 0o755);
  return { units, stub, log };
}

const peak = (log: string) => {
  let live = 0;
  let max = 0;
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    live += Number(l);
    max = Math.max(max, live);
  }
  return max;
};

test('--screen runs one arm-A session per unit under the slot cap and records graded rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub, log } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_PROBE: 'leak',
          KRN_EVAL_MAX_SESSIONS: '1',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.equal(rows.length, 2);
    const byUnit = Object.fromEntries(rows.map((x) => [x.unit, x]));
    assert.equal(byUnit['t-aaaaaaa']?.pass, true);
    assert.equal(byUnit['t-bbbbbbb']?.pass, false);
    for (const x of rows) {
      assert.equal(x.arm, 'A');
      assert.equal(x.cost, 0.25);
      // Queue wait and session time are recorded apart.
      assert.equal(typeof x.queueMs, 'number');
      assert.equal(typeof x.durationMs, 'number');
    }
    assert.match(r.stdout, /^attempt t-aaaaaaa .* queue=\d+s tools=/m);
    assert.equal(peak(log), 1);
    // Arm A: private config dir, no KRN variable, project settings only.
    for (const l of readFileSync(join(root, 'scratch', 'env.log'), 'utf8')
      .split('\n')
      .filter(Boolean)) {
      const [cfg, probe, args] = l.split('|');
      assert.equal(cfg, join(root, 'scratch', 'claude-config'));
      assert.equal(probe, '');
      assert.match(args as string, /--setting-sources project/);
      assert.match(args as string, /--disallowedTools WebFetch,WebSearch/);
    }
    assert.match(r.stdout, /verdict: no-go \(2 eligible units, 70 required\)/);
    assert.match(r.stdout, /^A pass rate: 50\.0% \(2 screened\)/m);
    // A second run grades nothing again; --reps 2 adds only the missing rep of each eligible unit.
    const again = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: '/nonexistent',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(parseRows(readFileSync(rowsFile, 'utf8')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--reps 2 records two graded rows per eligible unit and a unit passes when any rep passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub, log } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--reps',
        '2',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_EVAL_MAX_SESSIONS: '2',
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.deepEqual(rows.map((x) => `${x.unit}/${x.rep}`).sort(), [
      't-aaaaaaa/1',
      't-aaaaaaa/2',
      't-bbbbbbb/1',
      't-bbbbbbb/2',
    ]);
    assert.ok(peak(log) <= 2);
    assert.match(r.stdout, /A pass rate: 50\.0% \(2 screened\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Verbatim `claude -p --output-format json` result of a session stopped by the usage limit (captured 2026-11-13). */
const usageLimit =
  '{"is_error":true,"num_turns":9,"subtype":"success","api_error_status":429,"api_error":"usage_limit_reached","result":"You\'ve hit your weekly limit · resets Nov 13, 7pm (Europe/Warsaw)","type":"result","duration_ms":27467,"total_cost_usd":0.41}';

const driven = (stdout: string, timedOut = false): DrivenSession => ({
  result: parseSessionResult(stdout, ''),
  notStarted: false,
  timedOut,
  stdout,
  stderr: '',
});

test('a usage-limited, crashed or silent session did not run; a result or the time limit did', () => {
  assert.equal(sessionRan(driven(usageLimit)), false);
  assert.equal(sessionRan(driven('')), false);
  assert.equal(sessionRan(driven('Error: boom')), false);
  assert.equal(
    sessionRan(
      driven('{"subtype":"success","result":"ok","total_cost_usd":0.25}'),
    ),
    true,
  );
  assert.equal(sessionRan(driven('', true)), true);
  assert.equal(sessionRan(driven('{"subtype":"success","result":"ok"}')), true);
  assert.equal(
    sessionRan(
      driven(
        '{"subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":1}',
      ),
    ),
    true,
  );
  assert.equal(
    sessionRan({ ...driven('{"subtype":"success"}'), notStarted: true }),
    false,
  );
});

test('--screen records a usage-limited session ungraded and the next run screens it again', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub } = fixture(root);
    const limited = join(root, 'limited');
    writeFileSync(
      limited,
      `#!/bin/sh\ncat >/dev/null\ntouch fixed.txt\ncat <<'J'\n${usageLimit}\nJ\n`,
    );
    chmodSync(limited, 0o755);
    const rowsFile = join(root, 'rows.jsonl');
    const run = (bin: string) =>
      spawnSync(
        'node',
        [
          'evals/replay/run.ts',
          '--screen',
          '--units-dir',
          units,
          '--sources',
          join(root, 'sources'),
          '--scratch',
          join(root, 'scratch'),
          '--rows',
          rowsFile,
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            KRN_EVAL_CLAUDE: bin,
            KRN_EVAL_SLOT_DIR: join(root, 'slots'),
          },
        },
      );
    const first = run(limited);
    assert.equal(first.status, 0, first.stderr);
    const voided = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.equal(voided.length, 2);
    for (const x of voided) assert.equal(x.pass, null);
    assert.match(first.stdout, /A pass rate: unmeasured/);
    const second = run(stub);
    assert.equal(second.status, 0, second.stderr);
    const graded = parseRows(readFileSync(rowsFile, 'utf8')).filter(
      (x) => x.pass !== null,
    );
    assert.deepEqual(Object.fromEntries(graded.map((x) => [x.unit, x.pass])), {
      't-aaaaaaa': true,
      't-bbbbbbb': false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--screen grades the session change without the ignored leftovers of its own installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units } = fixture(root);
    // A session that fixes the unit and leaves an ignored install tree behind (pnpm v11: a later
    // `pnpm install --ignore-scripts` over a plain install's node_modules exits 1 with ERR_PNPM_IGNORED_BUILDS).
    const messy = join(root, 'messy');
    writeFileSync(
      messy,
      `#!/bin/sh\ncat >/dev/null\ntouch fixed.txt\nmkdir -p build && touch build/poison\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.1}'\n`,
    );
    chmodSync(messy, 0o755);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: messy,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = parseRows(readFileSync(rowsFile, 'utf8'));
    assert.equal(rows.length, 2);
    for (const x of rows) assert.equal(x.pass, true, x.unit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a screened session reaches only the unit base: no reference fix, no later refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units } = fixture(root);
    const seen = join(root, 'scratch', 'seen');
    // Records every commit the session can reach by any ref and whether the reference object exists at all.
    const probe = join(root, 'probe');
    writeFileSync(
      probe,
      `#!/bin/sh\ncat >/dev/null\ngit log --all --format=%H >> ${seen}\nfor r in $(cat ${join(root, 'refs')}); do git cat-file -e "$r^{commit}" 2>/dev/null && echo "reach $r" >> ${seen}; done\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.1}'\n`,
    );
    chmodSync(probe, 0o755);
    const unit = JSON.parse(
      readFileSync(join(units, 't-aaaaaaa', 'unit.json'), 'utf8'),
    ) as { base: string; reference: string };
    writeFileSync(join(root, 'refs'), unit.reference);
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        join(root, 'rows.jsonl'),
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: probe,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.includes(unit.base), 'the session sees its base');
    assert.ok(!lines.includes(unit.reference), 'no ref reaches the fix');
    assert.ok(
      !lines.includes(`reach ${unit.reference}`),
      'the fix object is absent',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--screen takes a sources path relative to where it runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        join(repo, 'evals/replay/run.ts'),
        '--screen',
        '--units-dir',
        units,
        '--sources',
        'sources',
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseRows(readFileSync(rowsFile, 'utf8')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a screened session writes its temporaries under scratch', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units } = fixture(root);
    const seen = join(root, 'scratch', 'seen');
    const probe = join(root, 'probe');
    writeFileSync(
      probe,
      `#!/bin/sh\ncat >/dev/null\necho "$TMPDIR" >> ${seen}\necho "$CLAUDE_CODE_TMPDIR" >> ${seen}\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.1}'\n`,
    );
    chmodSync(probe, 0o755);
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        join(root, 'rows.jsonl'),
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: probe,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
          CLAUDE_CODE_TMPDIR: '/host/claude-tmp',
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    for (const l of readFileSync(seen, 'utf8').split('\n').filter(Boolean))
      assert.equal(l, join(root, 'scratch', 'tmp'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a screened session reaches no host loopback listener, no HOME credential and no path outside scratch (t-djde6e9)', async (t) => {
  requiresIsolation(t, 'live arm sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  const home = mkdtempSync(join(tmpdir(), 'replay-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'replay-outside-'));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'planted-key\n');
  const servers = await Promise.all(
    ['127.0.0.1', '::1'].map(
      (host) =>
        new Promise<Server>((resolve) => {
          const s = createServer((_q, r) => r.end('host-secret'));
          s.listen(0, host, () => resolve(s));
        }),
    ),
  );
  const [v4, v6] = servers.map((s) => (s.address() as AddressInfo).port);
  try {
    const { units } = fixture(root);
    const seen = join(root, 'scratch', 'seen');
    const probe = join(root, 'probe');
    const urls = [
      `http://127.0.0.1:${v4}/`,
      `http://localhost:${v4}/`,
      `http://[::1]:${v6}/`,
    ];
    writeFileSync(
      probe,
      [
        '#!/bin/sh',
        'cat >/dev/null',
        ...urls.flatMap((u) => [
          `curl -s -m 5 --noproxy '*' ${u} >> ${seen} 2>&1`,
          `curl -s -m 5 ${u} >> ${seen} 2>&1`,
        ]),
        `cat ${join(home, '.ssh', 'id_ed25519')} >> ${seen} 2>&1`,
        `touch ${join(outside, 'escaped')} 2>/dev/null`,
        `echo probed >> ${seen}`,
        `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.1}'`,
        '',
      ].join('\n'),
    );
    chmodSync(probe, 0o755);
    const status = await new Promise<number | null>((resolve) => {
      const p = spawn(
        'node',
        [
          'evals/replay/run.ts',
          '--screen',
          '--units-dir',
          units,
          '--sources',
          join(root, 'sources'),
          '--scratch',
          join(root, 'scratch'),
          '--rows',
          join(root, 'rows.jsonl'),
        ],
        {
          cwd: repo,
          stdio: 'ignore',
          env: {
            ...process.env,
            HOME: home,
            KRN_EVAL_CLAUDE: probe,
            KRN_EVAL_SLOT_DIR: join(root, 'slots'),
          },
        },
      );
      p.on('close', resolve);
    });
    assert.equal(status, 0);
    const text = readFileSync(seen, 'utf8');
    assert.match(text, /probed/, 'the probe ran');
    assert.doesNotMatch(text, /host-secret/);
    assert.doesNotMatch(text, /planted-key/);
    assert.equal(existsSync(join(outside, 'escaped')), false);
  } finally {
    for (const s of servers) s.close();
    for (const d of [root, home, outside])
      rmSync(d, { recursive: true, force: true });
  }
});

test('an arm session env reaches no desktop: stub openers first on PATH, no display, no real bus (t-nsk5wca)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'arm-env-'));
  try {
    const env = armEnv(ARMS.A, scratch, {
      PATH: '/usr/bin',
      HOME: scratch,
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-1',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/session/bus',
    });
    assert.equal(env.DISPLAY, undefined);
    assert.equal(env.WAYLAND_DISPLAY, undefined);
    assert.equal(
      env.DBUS_SESSION_BUS_ADDRESS,
      `unix:path=${join(scratch, 'no-browser', 'no-bus')}`,
    );
    const opened = spawnSync('sh', ['-c', 'xdg-open https://example.invalid'], {
      env,
    });
    assert.equal(opened.status, 0);
    assert.equal(
      readFileSync(openerPaths(join(scratch, 'no-browser')).log, 'utf8'),
      'xdg-open https://example.invalid\n',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an arm session PATH drops the GitHub App gh wrapper and keeps every other entry (t-7n4hhgr)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'arm-path-'));
  try {
    const env = armEnv(ARMS.A, scratch, {
      PATH: '/r/scripts/app-bin:/usr/bin:/w/scripts/app-bin/:/opt/app-bin',
    });
    assert.equal(
      env.PATH,
      `${join(scratch, 'no-browser', 'bin')}:/usr/bin:/opt/app-bin`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the gh preflight skips the App wrapper that fails when it cannot mint a token', () => {
  assert.equal(typeof live.realGhVersionStatus, 'function');
  const root = mkdtempSync(join(tmpdir(), 'gh-wrapper-'));
  try {
    const wrapper = join(root, 'scripts', 'app-bin');
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, 'gh'), '#!/bin/sh\nexit 69\n');
    chmodSync(join(wrapper, 'gh'), 0o755);
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(real, 'gh'), 0o755);
    const path = `${wrapper}:${real}:/usr/bin:/bin`;
    assert.equal(
      spawnSync('gh', ['--version'], { env: { ...process.env, PATH: path } })
        .status,
      69,
      'the wrapper first on PATH fails the unfiltered preflight',
    );
    assert.equal(live.realGhVersionStatus(path), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an arm session env carries no GitHub identity: gh pr view -R fails with an auth error (t-k7gv1wt)', () => {
  // gh is on every host and runner that screens; a missing gh fails here instead of proving nothing.
  assert.equal(
    live.realGhVersionStatus(process.env.PATH),
    0,
    'gh is not installed',
  );
  const scratch = mkdtempSync(join(tmpdir(), 'arm-gh-'));
  try {
    // The host env, so the host's own gh login (hosts.yml, keyring) is what the session would otherwise inherit.
    const env = armEnv(ARMS.A, scratch, {
      ...process.env,
      GH_TOKEN: 'gho_planted',
      GITHUB_TOKEN: 'ghp_planted',
      GH_ENTERPRISE_TOKEN: 'gho_planted',
      GH_CONFIG_DIR: join(scratch, 'host-gh'),
    });
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'])
      assert.equal(env[k], undefined, k);
    assert.equal(env.GH_CONFIG_DIR, join(scratch, 'gh-config'));
    assert.deepEqual(readdirSync(env.GH_CONFIG_DIR as string), []);
    const r = spawnSync('gh', ['pr', 'view', '1', '-R', 'cli/cli'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(r.status, 0);
    // An auth refusal, not a network failure that would pass offline for the wrong reason.
    assert.match(r.stderr, /gh auth login|GH_TOKEN/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('--screen screens out a unit its grader cannot grade before any session and records the grade tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub, log } = fixture(root);
    // t-bbbbbbb: the reference fix fails the grader; t-ddddddd: the hidden test already passes at base.
    const edit = (id: string, from: string, patch: Record<string, string>) => {
      const u = JSON.parse(
        readFileSync(join(units, from, 'unit.json'), 'utf8'),
      ) as Record<string, unknown>;
      mkdirSync(join(units, id), { recursive: true });
      writeFileSync(join(units, id, 'hidden.txt'), 'present\n');
      writeFileSync(
        join(units, id, 'unit.json'),
        JSON.stringify({
          ...u,
          id,
          issue: `https://github.com/o/r/issues/${id.charCodeAt(2)}`,
          ...patch,
        }),
      );
    };
    edit('t-bbbbbbb', 't-bbbbbbb', {
      test: 'echo "FAIL hidden: other.txt missing"; test -f other.txt',
    });
    edit('t-ddddddd', 't-bbbbbbb', { test: 'true' });
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--units-dir',
        units,
        '--sources',
        join(root, 'sources'),
        '--scratch',
        join(root, 'scratch'),
        '--rows',
        rowsFile,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          KRN_EVAL_CLAUDE: stub,
          KRN_EVAL_SLOT_DIR: join(root, 'slots'),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const byUnit = Object.fromEntries(
      parseRows(readFileSync(rowsFile, 'utf8')).map((x) => [x.unit, x]),
    );
    const bad = byUnit['t-bbbbbbb'];
    assert.equal(bad?.verdict, 'screened');
    assert.equal(bad?.pass, null);
    assert.equal(
      bad?.screenedOut,
      'grade preflight: reference fails the grader (exit 1)',
    );
    assert.match(bad?.gradeTail ?? '', /FAIL hidden: other\.txt missing/);
    assert.equal(
      byUnit['t-ddddddd']?.screenedOut,
      'grade preflight: hidden test passes at base',
    );
    // Only the gradable unit got a session, and its graded row carries the grader's output tail.
    const sessions = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l === '+1');
    assert.equal(sessions.length, 1);
    assert.equal(byUnit['t-aaaaaaa']?.pass, true);
    assert.equal(typeof byUnit['t-aaaaaaa']?.gradeTail, 'string');
    assert.match(
      r.stdout,
      /^attempt t-bbbbbbb .*verdict=screened \(grade preflight: reference fails the grader \(exit 1\)\) grade: FAIL hidden: other\.txt missing$/m,
    );
    assert.match(
      readFileSync(
        join(root, 'grade-preflight', 't-bbbbbbb-preflight.log'),
        'utf8',
      ),
      /preflight t-bbbbbbb: screened/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const screenArgs = (root: string, units: string, rowsFile: string) => [
  'evals/replay/run.ts',
  '--screen',
  '--units-dir',
  units,
  '--sources',
  join(root, 'sources'),
  '--scratch',
  join(root, 'scratch'),
  '--rows',
  rowsFile,
];

test('--screen with free space below the budget exits 73 before cloning a unit and writes no row', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const r = spawnSync('node', screenArgs(root, units, rowsFile), {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_EVAL_CLAUDE: stub,
        KRN_LANE_MIN_FREE_GB: '1000000000',
        KRN_EVAL_SLOT_DIR: join(root, 'slots'),
      },
    });
    assert.equal(r.status, 73, r.stderr);
    assert.match(r.stderr, /replay disk budget: only .* GB free/);
    assert.match(r.stderr, /KRN_LANE_MIN_FREE_GB/);
    assert.equal(existsSync(rowsFile), false);
    const clones = existsSync(join(root, 'scratch'))
      ? readdirSync(join(root, 'scratch')).filter((n) =>
          n.startsWith('session-'),
        )
      : [];
    assert.deepEqual(clones, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--screen appends each unit row as the unit finishes and removes its scratch checkout after the row is written', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-live-'));
  try {
    const { units, stub } = fixture(root);
    const rowsFile = join(root, 'rows.jsonl');
    const probe = join(root, 'scratch', 'probe.log');
    const wrapper = join(root, 'probe-claude');
    // At each session start: rows already in the file, session checkouts alive in scratch.
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho "$(cat ${rowsFile} 2>/dev/null | wc -l) $(ls ${join(root, 'scratch')} | grep -c '^session-')" >> ${probe}\nexec ${stub} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const r = spawnSync('node', screenArgs(root, units, rowsFile), {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_EVAL_CLAUDE: wrapper,
        KRN_EVAL_MAX_SESSIONS: '1',
        KRN_EVAL_SLOT_DIR: join(root, 'slots'),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const seen = readFileSync(probe, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.trim().replace(/\s+/g, ' '));
    // Unit 1 starts with no row and one checkout; unit 2 starts after row 1 landed and unit 1's checkout is gone.
    assert.deepEqual(seen.slice(0, 2), ['0 1', '1 1']);
    assert.equal(parseRows(readFileSync(rowsFile, 'utf8')).length, 2);
    assert.deepEqual(
      readdirSync(join(root, 'scratch')).filter((n) =>
        n.startsWith('session-'),
      ),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('arms running in parallel share the package caches named by KRN_EVAL_CACHE and keep a private Go build cache', () => {
  const shared = join(tmpdir(), 'krn-shared-cache-probe');
  const arm = (name: string) => {
    const scratch = join(tmpdir(), `krn-arm-${name}`);
    return withToolchain({
      CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
      KRN_EVAL_CACHE: shared,
    });
  };
  try {
    const a = arm('one');
    const b = arm('two');
    for (const key of ['GOMODCACHE', 'npm_config_cache', 'PIP_CACHE_DIR'])
      assert.equal(a[key], b[key]);
    assert.equal(a.GOMODCACHE, join(shared, 'go-mod'));
    assert.notEqual(a.GOCACHE, b.GOCACHE);
    // Without the variable an arm keeps its own cache under its scratch.
    const own = withToolchain({
      CLAUDE_CONFIG_DIR: join(tmpdir(), 'krn-arm-one', 'claude-config'),
    });
    assert.equal(
      own.GOMODCACHE,
      join(tmpdir(), 'krn-arm-one', 'cache', 'go-mod'),
    );
  } finally {
    for (const d of [
      shared,
      join(tmpdir(), 'krn-arm-one'),
      join(tmpdir(), 'krn-arm-two'),
    ])
      rmSync(d, { recursive: true, force: true });
  }
});
