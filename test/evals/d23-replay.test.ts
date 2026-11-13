import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

const replay = fileURLToPath(
  new URL('../../evals/d23/replay.sh', import.meta.url),
);

test('an arm that hits the usage limit waits for the reset, retries once and records limit_retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-replay-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    writeFileSync(
      join(repo, 'tasks/t-abc1234.json'),
      JSON.stringify({ id: 't-abc1234', title: 'Fix it', body: ['Do it.'] }),
    );
    git('add', '.');
    git('commit', '-qm', 'fix(x): it is fixed (t-abc1234) (#7)');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const count = join(root, 'count');
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env bash
n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}
if [ "$n" = 0 ]; then echo "You've hit your 5-hour limit - resets 3pm" >&2; exit 1; fi
echo x > made.txt; git add made.txt; git commit -qm "feat: made (t-abc1234)"
echo '{"session_id":"s"}'
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const slept = join(root, 'slept');
    writeFileSync(
      join(bin, 'fakesleep'),
      `#!/usr/bin/env bash\necho "$1" > ${slept}\n`,
    );
    chmodSync(join(bin, 'fakesleep'), 0o755);

    const out = join(root, 'out');
    const r = spawnSync('bash', [replay, '7', 'P'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: repo,
        OUT: out,
        D23_TMP: join(root, 'work'),
        D23_SLEEP: join(bin, 'fakesleep'),
        HOME: join(root, 'home'),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const meas = readFileSync(join(out, '7.P.meas'), 'utf8');
    assert.match(meas, /^claude_exit=0$/m);
    assert.match(meas, /^limit_retry=1$/m);
    assert.match(meas, /^commits=1$/m);
    assert.match(readFileSync(join(out, '7.P.patch'), 'utf8'), /made\.txt/);
    const wait = Number(readFileSync(slept, 'utf8'));
    assert.ok(wait > 0 && wait <= 18000, `wait ${wait}`);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');
    assert.ok(existsSync(join(out, '7.P.task.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an arm that ends on an API auth error waits briefly, retries once and records limit_retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-replay-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    writeFileSync(
      join(repo, 'tasks/t-abc1234.json'),
      JSON.stringify({ id: 't-abc1234', title: 'Fix it', body: ['Do it.'] }),
    );
    git('add', '.');
    git('commit', '-qm', 'fix(x): it is fixed (t-abc1234) (#7)');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const count = join(root, 'count');
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env bash
n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}
if [ "$n" = 0 ]; then echo '{"session_id":"s","is_error":true,"subtype":"success","api_error_status":403,"result":"Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"}'; exit 1; fi
echo x > made.txt; git add made.txt; git commit -qm "feat: made (t-abc1234)"
echo '{"session_id":"s"}'
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const slept = join(root, 'slept');
    writeFileSync(
      join(bin, 'fakesleep'),
      `#!/usr/bin/env bash\necho "$1" > ${slept}\n`,
    );
    chmodSync(join(bin, 'fakesleep'), 0o755);

    const out = join(root, 'out');
    const r = spawnSync('bash', [replay, '7', 'P'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: repo,
        OUT: out,
        D23_TMP: join(root, 'work'),
        D23_SLEEP: join(bin, 'fakesleep'),
        D23_API_WAIT: '7',
        HOME: join(root, 'home'),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const meas = readFileSync(join(out, '7.P.meas'), 'utf8');
    assert.match(meas, /^claude_exit=0$/m);
    assert.match(meas, /^limit_retry=1$/m);
    assert.match(meas, /^commits=1$/m);
    assert.match(readFileSync(join(out, '7.P.patch'), 'utf8'), /made\.txt/);
    const wait = Number(readFileSync(slept, 'utf8'));
    assert.equal(wait, 7);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');
    assert.ok(existsSync(join(out, '7.P.task.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful arm whose output quotes a usage limit is neither delayed nor retried', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-replay-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    writeFileSync(
      join(repo, 'tasks/t-abc1234.json'),
      JSON.stringify({
        id: 't-abc1234',
        title: 'Retry limits',
        body: ['Retry on limits.'],
      }),
    );
    git('add', '.');
    git('commit', '-qm', 'fix(x): it is fixed (t-abc1234) (#7)');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const count = join(root, 'count');
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env bash
n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}
echo x > made.txt; git add made.txt; git commit -qm "feat: made (t-abc1234)"
echo '{"session_id":"s","is_error":false,"result":"Retries when claude says You have hit your 5-hour limit - resets 3pm"}'
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const slept = join(root, 'slept');
    writeFileSync(
      join(bin, 'fakesleep'),
      `#!/usr/bin/env bash\necho "$1" > ${slept}\n`,
    );
    chmodSync(join(bin, 'fakesleep'), 0o755);
    const out = join(root, 'out');
    const r = spawnSync('bash', [replay, '7', 'P'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: repo,
        OUT: out,
        D23_TMP: join(root, 'work'),
        D23_SLEEP: join(bin, 'fakesleep'),
        HOME: join(root, 'home'),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const meas = readFileSync(join(out, '7.P.meas'), 'utf8');
    assert.doesNotMatch(meas, /limit_retry/);
    assert.equal(existsSync(slept), false);
    assert.equal(readFileSync(count, 'utf8').trim(), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('arm K runs the HARNESS_REF lane brief as a worker and both arms clone only history up to the parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-replay-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    mkdirSync(join(repo, 'bin'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    // A stand-in for the harness ref's krn: records how it was called and wraps the brief it reads.
    writeFileSync(
      join(repo, 'bin/krn'),
      '#!/usr/bin/env bash\necho "ARGS: $*"\necho "BRIEF-BEGIN"\ncat\n',
    );
    chmodSync(join(repo, 'bin/krn'), 0o755);
    git('add', '.');
    git('commit', '-qm', 'earlier');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');
    writeFileSync(
      join(repo, 'tasks/t-abc1234.json'),
      JSON.stringify({
        id: 't-abc1234',
        title: 'Fix it',
        body: ['Why: x.\nScope: src/, test/.'],
      }),
    );
    git('add', '.');
    git('commit', '-qm', 'fix(x): it is fixed (t-abc1234) (#7)');
    // A later commit the clone must not see.
    writeFileSync(join(repo, 'later.txt'), 'later');
    git('add', '.');
    git('commit', '-qm', 'later work (#8)');
    const sha7 = git('log', '--format=%H', '--grep', '(#7)');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const seen = join(root, 'seen');
    const out = join(root, 'out');
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env bash
{ echo "MAIN=$(git rev-parse --verify -q refs/heads/main || echo none)"; echo "ROLE=$KRN_ROLE"; echo "SCOPE=$KRN_SCOPE"; echo "TASK=$KRN_TASK"; echo "PROMPT=$*"
  git rev-list --all --invert-grep --grep="^harness at\\|^strip harness" | while read c; do git merge-base --is-ancestor $c ${parent} || echo "NOT-ANCESTOR $c"; done
  echo "COUNT=$(git rev-list --all --invert-grep --grep="^harness at\\|^strip harness" | wc -l)"; } > ${seen}.$KRN_ARM
echo x > made.txt; git add made.txt; git commit -qm "feat: made (t-abc1234)"
echo '{"session_id":"s"}'
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const arm = (name: 'K' | 'P') =>
      spawnSync('bash', [replay, '7', name], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REPO: repo,
          OUT: out,
          D23_TMP: join(root, 'work'),
          HOME: join(root, 'home'),
          KRN_ARM: name,
          HARNESS_REF: name === 'K' ? sha7 : '',
        },
      });
    for (const name of ['K', 'P'] as const) {
      const r = arm(name);
      assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(`${seen}.${name}`, 'utf8');
      assert.doesNotMatch(text, /NOT-ANCESTOR/u, name);
      assert.match(text, /^COUNT=2$/m, name);
      if (name === 'K') {
        assert.match(text, /^ROLE=worker$/m);
        assert.match(text, /^SCOPE=Scope: src\/, test\/\.$/m);
        assert.match(text, /^TASK=t-abc1234$/m);
        assert.match(
          text,
          /json ARGS: lane brief --root \S+ --task t-abc1234 --as-of \d{4}-\d{2}-\d{2}/u,
        );
        assert.match(text, /BRIEF-BEGIN/u);
        assert.match(text, /Task t-abc1234: Fix it/u);
        assert.doesNotMatch(text, /KRN lead/u);
        const base = readFileSync(`${out}/7.K.base`, 'utf8').trim();
        assert.match(text, new RegExp(`^MAIN=${base}$`, 'm'));
      } else {
        assert.match(text, /^MAIN=none$/m);
        assert.match(text, /^ROLE=$/m);
        assert.doesNotMatch(text, /ARGS: lane brief/u);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('arm PB gets the same requirements text as K, P gets the base text, and a repeat writes to its own run directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-replay-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'tasks'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    writeFileSync(
      join(repo, 'tasks/t-abc1234.json'),
      JSON.stringify({ id: 't-abc1234', title: 'Fix it', body: ['Do it.'] }),
    );
    git('add', '.');
    git('commit', '-qm', 'fix(x): it is fixed (t-abc1234) (#7)');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env bash\necho x > made.txt; git add made.txt; git commit -qm "feat: made (t-abc1234)"\necho '{"session_id":"s","is_error":false,"result":"done"}'\n`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const full = join(root, 'full');
    const base = join(root, 'base');
    mkdirSync(full);
    mkdirSync(base);
    writeFileSync(join(full, '7.txt'), 'REQUIREMENTS TEXT\n');
    writeFileSync(join(base, '7.txt'), 'BASE TEXT\n');
    const out = join(root, 'out');
    for (const arm of ['PB', 'P']) {
      const r = spawnSync('bash', [replay, '7', arm], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REPO: repo,
          OUT: out,
          RUN: '2',
          IFACE: full,
          IFACE_BASE: base,
          D23_TMP: join(root, 'work'),
          HOME: join(root, 'home'),
        },
      });
      assert.equal(r.status, 0, r.stderr);
    }
    const pb = readFileSync(join(out, 'run2/7.PB.task.txt'), 'utf8');
    const p = readFileSync(join(out, 'run2/7.P.task.txt'), 'utf8');
    assert.match(pb, /REQUIREMENTS TEXT/);
    assert.doesNotMatch(pb, /BASE TEXT/);
    assert.match(p, /BASE TEXT/);
    assert.doesNotMatch(p, /REQUIREMENTS TEXT/);
    const meas = readFileSync(join(out, 'run2/7.PB.meas'), 'utf8');
    assert.match(meas, /^measured$/m);
    // runs.ts grades the full suite; a serialized npm test per run here halved the run's throughput
    assert.doesNotMatch(meas, /npmtest_exit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
