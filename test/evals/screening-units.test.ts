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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { eligible, type ScreenUnit } from '../../evals/replay/screen.ts';
import { openerPaths } from '../../evals/units/no-browser.ts';
import {
  cacheOverLimit,
  commandsFor,
  dirBytes,
  forceRemove,
  gradeWorktree,
  INSTALL_SECONDS,
  type ManifestRow,
  pruneCache,
  readManifest,
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
    /vitest run "src\/a\.test\.ts"/,
  );
  assert.equal(
    commandsFor('TypeScript', 'a.test.ts', (p) =>
      p === 'package.json' ? '{}' : null,
    ),
    null,
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

test('a grade runs inside bubblewrap: no desktop, no host tokens, host read-only, network for install only', async (t) => {
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
    assert.ok(Number(read('install-ifaces')) > 1, 'install keeps the network');
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
      // No `$?`: the unit command is nested in a double-quoted `sh -c`, which would expand it early.
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
