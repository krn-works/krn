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
    assert.ok(existsSync(join(out, '7.task.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
