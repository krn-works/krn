import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { eligible, type ScreenUnit } from '../../evals/replay/screen.ts';
import { openerPaths } from '../../evals/units/no-browser.ts';
import {
  baseVerdict,
  cacheOverLimit,
  commandsFor,
  dirBytes,
  dropsToRemove,
  duplicateIds,
  EXIT_INFRASTRUCTURE,
  forceRemove,
  gradeWorktree,
  INSTALL_SECONDS,
  type ManifestRow,
  pruneCache,
  readManifest,
  regraded,
  toGrade,
  unitId,
  type Verification,
  verified,
} from '../../evals/units/screening.ts';
import { loadUnits } from '../../evals/units/unit.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const unitsDir = join(repo, 'evals/units');
const good: Verification = {
  installBase: 0,
  testBase: 1,
  baseFailure: 'assertion',
  installFix: 0,
  testFix: 0,
};

const row = (n: number, v: Verification | undefined): ManifestRow => ({
  id: unitId(`https://github.com/o/r/issues/${n}`),
  repo: 'o/r',
  issue: `https://github.com/o/r/issues/${n}`,
  fixPr: `https://github.com/o/r/pull/${n}`,
  base: 'a'.repeat(40),
  fix: 'b'.repeat(40),
  committed: '2026-08-01',
  test: 't',
  verification: v,
});

test('a unit counts as verified only when the hidden test is red by assertion on base and green on the fix', () => {
  assert.equal(verified(good), true);
  assert.equal(verified(undefined), false);
  assert.equal(verified({ ...good, testFix: 1 }), false);
  assert.equal(verified({ ...good, testBase: 0, baseFailure: 'none' }), false);
  assert.equal(verified({ ...good, baseFailure: 'compile' }), false);
  assert.equal(verified({ ...good, installFix: 1 }), false);
  assert.equal(verified({ ...good, gold: 0 }), true);
  // The reference fix failing in the screen's isolated checkout leaves the unit ungradable.
  assert.equal(verified({ ...good, gold: 1 }), false);
});

test('a unit id keeps the task id shape and differs per issue', () => {
  const a = unitId('https://github.com/o/r/issues/1');
  assert.match(a, /^t-[a-z0-9]{7}$/);
  assert.notEqual(a, unitId('https://github.com/o/r/issues/2'));
  assert.equal(a, unitId('https://github.com/o/r/issues/1'));
});

test('commands name the runner the base tree shows and nothing when none is named', () => {
  const none = () => null;
  assert.match(
    commandsFor('Go', 'pkg/a/a_test.go', none)?.test ?? '',
    /go test .* \.\/pkg\/a\/$/,
  );
  assert.equal(commandsFor('Python', 'tests/test_a.py', none), null);
  const vitest = (p: string) =>
    p === 'package.json' ? '{"vitest":"1"}' : null;
  assert.match(
    commandsFor('TypeScript', 'src/a.test.ts', vitest)?.test ?? '',
    /vitest run 'src\/a\.test\.ts'/,
  );
  assert.equal(
    commandsFor('TypeScript', 'a.test.ts', (p) =>
      p === 'package.json' ? '{}' : null,
    ),
    null,
  );
});

test('a base test killed by its timeout is not verified, even when recorded as an assertion', () => {
  assert.equal(baseVerdict(124, false), 'timeout');
  assert.equal(baseVerdict(1, false), 'assertion');
  assert.equal(baseVerdict(1, true), 'compile');
  assert.equal(baseVerdict(0, false), 'none');
  assert.equal(
    verified({ ...good, testBase: 124, baseFailure: 'timeout' }),
    false,
  );
  assert.equal(verified({ ...good, testBase: 124 }), false);
});

test('the recorded manifest holds no unit whose base test was killed by its timeout and counted as verified', () => {
  for (const r of readManifest()) {
    if (r.verification?.testBase === 124)
      assert.equal(r.verification.baseFailure, 'timeout', r.id);
  }
  assert.equal(
    readManifest().filter((r) => r.verification?.testBase === 124).length,
    0,
  );
});

function recorded(rows: ManifestRow[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'screening-')), 'm.json');
  writeFileSync(file, JSON.stringify(rows));
  return spawnSync(
    process.execPath,
    [
      join(unitsDir, 'screening.ts'),
      'verify',
      '--recorded',
      '--manifest',
      file,
    ],
    { encoding: 'utf8' },
  );
}

test('verify prints the verified count and exits 0 only from 70 units', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row(i, good)).concat([
      row(900, { ...good, testFix: 1 }),
    ]);
  const few = recorded(rows(69));
  assert.equal(few.stdout.trim(), 'units: 69 verified');
  assert.equal(few.status, 1);
  const enough = recorded(rows(70));
  assert.equal(enough.stdout.trim(), 'units: 70 verified');
  assert.equal(enough.status, 0);
});

test('verify --id re-grades a recorded unit and refuses an id the manifest lacks (t-te4w4zr)', (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'verify-id-'));
  try {
    const clone = join(root, 'sources', 'o__r');
    mkdirSync(clone, { recursive: true });
    const g = (...a: string[]) =>
      spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' }).stdout.trim();
    g('init', '-q');
    g(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base',
    );
    const base = g('rev-parse', 'HEAD');
    writeFileSync(join(clone, 'fixed'), 'x');
    g('add', 'fixed');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fix');
    const fix = g('rev-parse', 'HEAD');
    // Recorded as a drop: a plain verify skips it, --id must grade it again.
    const r = { ...row(1, { ...good, testFix: 1 }), base, fix };
    const units = join(root, 'units');
    mkdirSync(join(units, r.id), { recursive: true });
    writeFileSync(join(units, r.id, 'hidden.txt'), 'x');
    writeFileSync(
      join(units, r.id, 'unit.json'),
      JSON.stringify({
        base,
        reference: fix,
        install: 'true',
        test: 'test -f fixed',
        hidden: { file: 'hidden.txt', dest: 'hidden.check' },
      }),
    );
    const manifest = join(root, 'm.json');
    writeFileSync(manifest, JSON.stringify([r]));
    const verify = (id: string) =>
      spawnSync(
        process.execPath,
        [
          join(unitsDir, 'screening.ts'),
          'verify',
          '--id',
          id,
          '--manifest',
          manifest,
          '--units',
          units,
          '--sources',
          join(root, 'sources'),
          '--scratch',
          join(root, 'scratch'),
          '--log-dir',
          join(root, 'logs'),
        ],
        { encoding: 'utf8' },
      );
    const run = verify(r.id);
    assert.match(run.stdout, new RegExp(`^${r.id} o/r ok `, 'm'), run.stderr);
    const [after] = JSON.parse(readFileSync(manifest, 'utf8')) as ManifestRow[];
    assert.deepEqual(after?.verification, good);
    const missing = verify('t-0000000');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no such manifest row/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify refuses a manifest holding one id twice, naming the id, and the committed manifest has none (t-zt6d2de)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dup-manifest-'));
  try {
    const row = {
      id: 't-dup0001',
      repo: 'o/r',
      issue: 'https://github.com/o/r/issues/1',
      fixPr: 'https://github.com/o/r/pull/2',
      base: 'b',
      fix: 'f',
      committed: '2026-01-01',
      test: 'true',
    };
    const manifest = join(root, 'm.json');
    writeFileSync(
      manifest,
      JSON.stringify([
        row,
        { ...row, id: 't-other01' },
        { ...row, fixPr: 'https://github.com/o/r/pull/3' },
      ]),
    );
    for (const args of [['verify', '--recorded'], ['verify']]) {
      const run = spawnSync(
        process.execPath,
        [join(unitsDir, 'screening.ts'), ...args, '--manifest', manifest],
        { encoding: 'utf8' },
      );
      assert.notEqual(run.status, 0, args.join(' '));
      assert.match(run.stderr, /duplicate unit ids: t-dup0001\b/);
      assert.doesNotMatch(run.stderr, /t-other01/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(duplicateIds(readManifest()), []);
});

test('every committed screening unit is verified, loads, and is eligible for the screen', () => {
  const rows = readManifest();
  const live = rows.filter((r) => verified(r.verification));
  const loaded = loadUnits(unitsDir).filter((u) =>
    rows.some((r) => r.id === u.unit.id),
  );
  assert.deepEqual(
    loaded.map((u) => u.unit.id).sort(),
    live.map((r) => r.id).sort(),
  );
  for (const { unit, dir } of loaded) {
    assert.ok(existsSync(join(dir, unit.hidden.file)), unit.id);
    const r = rows.find((x) => x.id === unit.id) as ManifestRow;
    assert.equal(unit.base, r.base);
    assert.equal(unit.reference, r.fix);
  }
  assert.equal(
    eligible(loaded.map((u) => u.unit as ScreenUnit)).length,
    loaded.length,
  );
});

test('cache pruning takes a cache above the cap below it, read-only module files included', () => {
  const root = mkdtempSync(join(tmpdir(), 'screen-cache-'));
  const fill = (dir: string, files: number, ro: boolean) => {
    mkdirSync(join(root, dir, 'sub'), { recursive: true });
    for (let i = 0; i < files; i++)
      writeFileSync(join(root, dir, 'sub', `f${i}`), Buffer.alloc(1000));
    if (ro) {
      for (let i = 0; i < files; i++)
        chmodSync(join(root, dir, 'sub', `f${i}`), 0o444);
      chmodSync(join(root, dir, 'sub'), 0o555);
    }
  };
  fill('go-mod', 10, true);
  fill('go-build', 6, false);
  fill('npm', 2, false);
  const lim = {
    capBytes: dirBytes(join(root, 'go-build')) + dirBytes(join(root, 'npm')),
    freeFloorBytes: 0,
  };
  assert.equal(cacheOverLimit(root, lim), true);
  const removed = pruneCache(root, lim);
  assert.deepEqual(removed, ['go-mod']);
  assert.ok(dirBytes(root) <= lim.capBytes);
  assert.equal(cacheOverLimit(root, lim), false);
  assert.deepEqual(pruneCache(root, lim), []);
  rmSync(root, { recursive: true, force: true });
});

test('cache pruning continues while free disk is under the floor', () => {
  const root = mkdtempSync(join(tmpdir(), 'screen-cache-'));
  for (const d of ['a', 'b']) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, 'f'), Buffer.alloc(100));
  }
  const lim = { capBytes: 1e9, freeFloorBytes: 10 };
  let free = 0;
  const fake = () => free;
  assert.equal(cacheOverLimit(root, lim, fake), true);
  const removed = pruneCache(root, lim, () => (free += 6));
  assert.equal(removed.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('a session tree holding a read-only directory is removed, where a plain rmSync fails with EACCES', () => {
  const make = () => {
    // The shape a screened session left behind: envtest binaries under a directory without write permission.
    const wt = mkdtempSync(join(tmpdir(), 'session-'));
    const ro = join(wt, 'bin', 'k8s', '1.31.0-linux-amd64');
    mkdirSync(ro, { recursive: true });
    writeFileSync(join(ro, 'kube-apiserver'), 'x');
    chmodSync(ro, 0o555);
    return { wt, ro };
  };
  const plain = make();
  try {
    assert.throws(
      () => rmSync(plain.wt, { recursive: true, force: true }),
      /EACCES/,
    );
  } finally {
    chmodSync(plain.ro, 0o755);
    rmSync(plain.wt, { recursive: true, force: true });
  }
  const forced = make();
  forceRemove(forced.wt);
  assert.equal(existsSync(forced.wt), false);
});

test('a screened session is graded with the install time verification had', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grade-timeout-'));
  const path = process.env.PATH;
  try {
    // A `timeout` on PATH that records its seconds and runs the command, so the test sees the grade's install budget.
    // The stub writes inside the worktree: the sandboxed grade may write nowhere else outside its cache.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const seen = join(wt, 'seen');
    writeFileSync(
      join(bin, 'timeout'),
      `#!/bin/sh\necho "$1" >> ${seen}\nshift\nexec "$@"\n`,
    );
    chmodSync(join(bin, 'timeout'), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const unitDir = join(root, 'unit');
    mkdirSync(unitDir);
    writeFileSync(join(unitDir, 'hidden.txt'), 'x');
    const unit = {
      install: 'true',
      test: 'true',
      hidden: { file: 'hidden.txt', dest: 'hidden.check' },
    } as unknown as Parameters<typeof gradeWorktree>[1];
    const g = await gradeWorktree(wt, unit, unitDir, join(root, 'log'), root);
    assert.equal(g.install, 0);
    assert.equal(INSTALL_SECONDS, 900);
    assert.equal(readFileSync(seen, 'utf8').trim().split('\n')[0], '900');
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('grading temporaries live under scratch, not the size-capped host /tmp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grade-tmpdir-'));
  try {
    const wt = join(root, 'wt');
    const unitDir = join(root, 'unit');
    const scratch = join(root, 'scratch');
    mkdirSync(wt);
    mkdirSync(unitDir);
    writeFileSync(join(unitDir, 'hidden.txt'), 'x');
    const unit = {
      install: 'true',
      test: 'echo "$TMPDIR|$GOTMPDIR" > seen && test -d "$TMPDIR"',
      hidden: { file: 'hidden.txt', dest: 'hidden.check' },
    } as unknown as Parameters<typeof gradeWorktree>[1];
    const g = await gradeWorktree(
      wt,
      unit,
      unitDir,
      join(root, 'log'),
      scratch,
    );
    assert.equal(g.test, 0);
    const [tmp, gotmp] = readFileSync(join(wt, 'seen'), 'utf8')
      .trim()
      .split('|');
    assert.equal(tmp, join(scratch, 'cache', 'tmp'));
    assert.equal(gotmp, tmp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a grade given relative worktree and scratch paths still hands the unit an absolute, existing TMPDIR', async () => {
  const f = gradeFixture(
    'grade-relative-',
    'true',
    'echo "$TMPDIR" > seen && test -d "$TMPDIR"',
  );
  const rel = (p: string) => relative(process.cwd(), p);
  try {
    const g = await gradeWorktree(
      rel(f.wt),
      f.unit,
      rel(f.unitDir),
      f.log,
      rel(f.scratch),
    );
    assert.equal(g.test, 0, readFileSync(f.log, 'utf8'));
    assert.equal(
      readFileSync(join(f.wt, 'seen'), 'utf8').trim(),
      join(f.scratch, 'cache', 'tmp'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a grading command that opens a URL reaches only the stub opener, never the desktop (t-nsk5wca)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grade-no-browser-'));
  const saved = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  // The grader runs under a desktop session: its own env names a display and a bus.
  process.env.DISPLAY = ':0';
  process.env.WAYLAND_DISPLAY = 'wayland-1';
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/host/session/bus';
  try {
    const wt = join(root, 'wt');
    const unitDir = join(root, 'unit');
    const scratch = join(root, 'scratch');
    mkdirSync(wt);
    mkdirSync(unitDir);
    writeFileSync(join(unitDir, 'hidden.txt'), 'x');
    const unit = {
      install: 'true',
      test: 'xdg-open https://example.invalid && "$BROWSER" https://example.invalid/b && echo "${DISPLAY-unset}|${WAYLAND_DISPLAY-unset}|$DBUS_SESSION_BUS_ADDRESS" > seen && true',
      hidden: { file: 'hidden.txt', dest: 'hidden.check' },
    } as unknown as Parameters<typeof gradeWorktree>[1];
    const g = await gradeWorktree(
      wt,
      unit,
      unitDir,
      join(root, 'log'),
      scratch,
    );
    assert.equal(g.test, 0);
    const opened = readFileSync(
      openerPaths(join(scratch, 'cache', 'no-browser')).log,
      'utf8',
    );
    assert.equal(
      opened,
      'xdg-open https://example.invalid\nxdg-open https://example.invalid/b\n',
    );
    const [display, wayland, bus] = readFileSync(join(wt, 'seen'), 'utf8')
      .trim()
      .split('|');
    assert.equal(display, 'unset');
    assert.equal(wayland, 'unset');
    assert.notEqual(bus, process.env.DBUS_SESSION_BUS_ADDRESS);
    assert.ok(bus?.startsWith(`unix:path=${scratch}`), bus);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

/** A worktree, unit dir and scratch for one grade of a unit whose install and test are the given shell commands. */
function gradeFixture(prefix: string, install: string, testCmd: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const wt = join(root, 'wt');
  const unitDir = join(root, 'unit');
  const scratch = join(root, 'scratch');
  mkdirSync(wt);
  mkdirSync(unitDir);
  writeFileSync(join(unitDir, 'hidden.txt'), 'x');
  const unit = {
    install,
    test: testCmd,
    hidden: { file: 'hidden.txt', dest: 'hidden.check' },
  } as unknown as Parameters<typeof gradeWorktree>[1];
  return { root, wt, unitDir, scratch, unit, log: join(root, 'log') };
}

test('a grade runs inside bubblewrap: no desktop, no host tokens, host read-only, own network namespace in both phases', async (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  const outside = mkdtempSync(join(tmpdir(), 'grade-outside-'));
  const runtime = ['', 'run', 'user', String(process.getuid?.() ?? 0)].join(
    '/',
  );
  const planted = {
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-1',
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    GH_TOKEN: 'gho_planted',
  };
  const saved = Object.fromEntries(
    Object.keys(planted).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, planted);
  // /proc/net/dev lists only lo (2 header lines + 1) in a network namespace of its own.
  const f = gradeFixture(
    'grade-sandbox-',
    'grep -c : /proc/net/dev > install-ifaces',
    [
      'xdg-open https://example.invalid',
      'env > env.txt',
      'ls /run/user > /dev/null 2>&1; echo "$?" > run-user',
      `touch ${JSON.stringify(join(outside, 'escaped'))} 2> /dev/null; echo "$?" > host-write`,
      'grep -c : /proc/net/dev > test-ifaces',
    ].join('; '),
  );
  try {
    const g = await gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch);
    assert.equal(g.install, 0, readFileSync(f.log, 'utf8'));
    assert.equal(g.test, 0, readFileSync(f.log, 'utf8'));
    const read = (n: string) => readFileSync(join(f.wt, n), 'utf8').trim();
    const env = read('env.txt');
    for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'])
      assert.doesNotMatch(env, new RegExp(`^${name}=`, 'm'));
    assert.doesNotMatch(env, /gho_planted|GH_TOKEN/);
    assert.doesNotMatch(env, /^DBUS_SESSION_BUS_ADDRESS=.*\/run\/user/m);
    assert.notEqual(read('run-user'), '0', 'ls /run/user must fail');
    assert.notEqual(
      read('host-write'),
      '0',
      'a write outside scratch must fail',
    );
    assert.equal(existsSync(join(outside, 'escaped')), false);
    assert.equal(read('test-ifaces'), '1', 'the test phase has only loopback');
    assert.equal(
      read('install-ifaces'),
      '1',
      'install reaches the internet only through the egress proxy, in a namespace of its own',
    );
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an install reaches no host loopback listener, directly or through the proxy, and no host gh wrapper (t-qjf9g6c)', async (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
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
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const urls = [
    `http://127.0.0.1:${v4}/`,
    `http://localhost:${v4}/`,
    `http://[::ffff:127.0.0.1]:${v4}/`,
    `http://[::1]:${v6}/`,
    `https://localhost:${v6}/`,
    ...(lan ? [`http://${lan}:${v4}/`] : []),
  ];
  const appBin = mkdtempSync(join(tmpdir(), 'grade-appbin-'));
  const wrapperDir = join(appBin, 'scripts', 'app-bin');
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, 'gh'), '#!/bin/sh\necho app-token\n');
  chmodSync(join(wrapperDir, 'gh'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${wrapperDir}:${process.env.PATH}`;
  const probes = urls.flatMap((u) => [
    `curl -s -m 5 --noproxy '*' ${JSON.stringify(u)} >> bodies 2>&1`,
    `curl -s -m 5 ${JSON.stringify(u)} >> bodies 2>&1`,
  ]);
  const f = gradeFixture(
    'grade-loopback-',
    [
      'touch bodies',
      ...probes,
      'command -v gh > gh-path || echo none > gh-path',
      'echo "$HTTPS_PROXY" > proxy',
    ].join('; '),
    'true',
  );
  try {
    const g = await gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch);
    assert.equal(g.install, 0, readFileSync(f.log, 'utf8'));
    const read = (n: string) => readFileSync(join(f.wt, n), 'utf8');
    assert.doesNotMatch(read('bodies'), /host-secret/);
    assert.match(read('proxy'), /^http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(read('gh-path'), /scripts\/app-bin/);
  } finally {
    process.env.PATH = saved;
    for (const s of servers) s.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(appBin, { recursive: true, force: true });
  }
});

test('a grade sees no host HOME credentials, even with network, and still runs toolchains under HOME (t-k7gv1wt)', async (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  const home = mkdtempSync(join(tmpdir(), 'grade-home-'));
  for (const d of ['.config/gh', '.ssh', 'tools/bin'])
    mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.netrc'), 'machine github.com password planted\n');
  writeFileSync(join(home, '.config/gh/hosts.yml'), 'github.com: planted\n');
  writeFileSync(join(home, '.ssh/id_ed25519'), 'planted\n');
  writeFileSync(join(home, 'tools/bin/hometool'), '#!/bin/sh\necho ran\n');
  chmodSync(join(home, 'tools/bin/hometool'), 0o755);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${join(home, 'tools/bin')}:${process.env.PATH}`;
  const probe = (phase: string) =>
    [
      `cat ~/.netrc ~/.config/gh/hosts.yml ~/.ssh/id_ed25519 > ${phase}-secrets 2> /dev/null && echo read > ${phase}-read || echo hidden > ${phase}-read`,
      `hometool > ${phase}-tool`,
    ].join('; ');
  const f = gradeFixture('grade-home-', probe('install'), probe('test'));
  try {
    const g = await gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch);
    assert.equal(g.install, 0, readFileSync(f.log, 'utf8'));
    assert.equal(g.test, 0, readFileSync(f.log, 'utf8'));
    const read = (n: string) => readFileSync(join(f.wt, n), 'utf8').trim();
    for (const phase of ['install', 'test']) {
      assert.equal(
        read(`${phase}-read`),
        'hidden',
        `${phase} read a credential`,
      );
      assert.doesNotMatch(read(`${phase}-secrets`), /planted/);
      assert.equal(read(`${phase}-tool`), 'ran', `${phase} lost the toolchain`);
    }
  } finally {
    Object.assign(process.env, saved);
    rmSync(f.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a unit command sees its own $x, $? and $(...): the grade never expands them in an outer shell (t-xasrw18)', async (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  const probe = (phase: string) =>
    `for x in a b; do echo "[$x]" >> ${phase}-loop; done; false; echo "$?" > ${phase}-status; echo "$(echo inner)" "it's" > ${phase}-sub`;
  const f = gradeFixture('grade-dollar-', probe('install'), probe('test'));
  try {
    const g = await gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch);
    assert.equal(g.install, 0, readFileSync(f.log, 'utf8'));
    assert.equal(g.test, 0, readFileSync(f.log, 'utf8'));
    const read = (n: string) => readFileSync(join(f.wt, n), 'utf8').trim();
    for (const phase of ['install', 'test']) {
      assert.equal(read(`${phase}-loop`), '[a]\n[b]', `${phase} lost $x`);
      assert.equal(read(`${phase}-status`), '1', `${phase} read an outer $?`);
      assert.equal(read(`${phase}-sub`), "inner it's", `${phase} lost $(...)`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('without a working bwrap a grade is refused before any unit command runs', async () => {
  const f = gradeFixture('grade-no-bwrap-', 'touch installed', 'touch tested');
  const path = process.env.PATH;
  try {
    const empty = join(f.root, 'empty-bin');
    mkdirSync(empty);
    process.env.PATH = empty;
    await assert.rejects(
      gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch),
      /refuses to run third-party code without bubblewrap/,
    );
    assert.equal(existsSync(join(f.wt, 'installed')), false);
    assert.equal(existsSync(join(f.wt, 'tested')), false);
  } finally {
    process.env.PATH = path;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('verify removes only the directories of units it graded and dropped, and none when every grade failed install (t-jjp67ch)', () => {
  const failInstall = { ...good, installBase: 1, installFix: -1, testFix: -1 };
  const drop = { ...good, testFix: 1 };
  assert.equal(
    dropsToRemove([
      { id: 'a', v: failInstall },
      { id: 'b', v: { ...failInstall, installBase: 124 } },
    ]),
    'infrastructure',
  );
  assert.deepEqual(
    dropsToRemove([
      { id: 'a', v: failInstall },
      { id: 'b', v: drop },
      { id: 'c', v: good },
    ]),
    ['a', 'b'],
  );
  assert.deepEqual(dropsToRemove([]), []);
});

test('verify --id keeps an earlier drop and every unit when its grade fails install, through the real CLI (t-jjp67ch)', (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'verify-keep-'));
  try {
    const clone = join(root, 'sources', 'o__r');
    mkdirSync(clone, { recursive: true });
    const g = (...a: string[]) =>
      spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' }).stdout.trim();
    const commit = (m: string) =>
      g(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        m,
      );
    g('init', '-q');
    commit('base');
    const base = g('rev-parse', 'HEAD');
    commit('fix');
    const fix = g('rev-parse', 'HEAD');
    const units = join(root, 'units');
    const unit = (id: string, install: string) => {
      mkdirSync(join(units, id), { recursive: true });
      writeFileSync(join(units, id, 'hidden.txt'), 'x');
      writeFileSync(
        join(units, id, 'unit.json'),
        JSON.stringify({
          base,
          reference: fix,
          install,
          test: 'false',
          hidden: { file: 'hidden.txt', dest: 'hidden.check' },
        }),
      );
    };
    // An earlier run recorded this unit as a drop; a run graded on another id must not remove it.
    const earlier = { ...row(1, { ...good, testFix: 1 }), base, fix };
    const target = { ...row(2, undefined), base, fix };
    unit(earlier.id, 'true');
    unit(target.id, 'exit 3');
    const manifest = join(root, 'm.json');
    writeFileSync(manifest, JSON.stringify([earlier, target]));
    const verify = () =>
      spawnSync(
        process.execPath,
        [
          join(unitsDir, 'screening.ts'),
          'verify',
          '--id',
          target.id,
          '--manifest',
          manifest,
          '--units',
          units,
          '--sources',
          join(root, 'sources'),
          '--scratch',
          join(root, 'scratch'),
          '--log-dir',
          join(root, 'logs'),
        ],
        { encoding: 'utf8' },
      );
    const broken = verify();
    assert.equal(broken.status, EXIT_INFRASTRUCTURE, broken.stderr);
    assert.match(broken.stderr, /infrastructure/);
    assert.ok(
      existsSync(join(units, target.id)),
      'install failure removed the graded unit',
    );
    assert.ok(existsSync(join(units, earlier.id)), 'removed an earlier drop');
    // A real drop (install passes, the fix stays red) removes the graded unit only.
    unit(target.id, 'true');
    const dropped = verify();
    assert.match(
      dropped.stdout,
      new RegExp(`^${target.id} o/r drop `, 'm'),
      dropped.stderr,
    );
    assert.equal(existsSync(join(units, target.id)), false);
    assert.ok(existsSync(join(units, earlier.id)), 'removed an earlier drop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a grade refuses a scratch inside a git repository before any unit command runs (t-zk8cmrz)', async (t) => {
  requiresIsolation(t, 'screening grade sandbox', ['bwrap']);
  // go-git finds the checkout above a temp dir under such a scratch and ignores GIT_CEILING_DIRECTORIES (t-1xtk34n).
  const f = gradeFixture('grade-in-repo-', 'touch ran', 'true');
  try {
    assert.equal(spawnSync('git', ['init', '-q', f.root]).status, 0);
    await assert.rejects(
      gradeWorktree(f.wt, f.unit, f.unitDir, f.log, f.scratch),
      /inside the git repository/,
    );
    assert.equal(existsSync(join(f.wt, 'ran')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('verify grades only unrecorded rows and only the named one under --id, so others skip the cache walk (t-zk8cmrz)', () => {
  const recorded = row(1, good);
  const open = row(2, undefined);
  const other = row(3, undefined);
  assert.equal(toGrade(recorded, undefined), false);
  assert.equal(toGrade(open, undefined), true);
  assert.equal(toGrade(open, open.id), true);
  assert.equal(toGrade(other, open.id), false);
});

test('a regrade keeps the recorded gold the grade does not own (t-g86syt0)', () => {
  const prior: Verification = { ...good, gold: 1 };
  const next: Verification = {
    installBase: 0,
    testBase: 1,
    baseFailure: 'compile',
    installFix: -1,
    testFix: -1,
  };
  assert.deepEqual(regraded(prior, next), { ...next, gold: 1 });
  assert.deepEqual(regraded(undefined, next), next);
});
