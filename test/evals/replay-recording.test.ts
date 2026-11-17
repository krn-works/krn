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
import { replayVerdict } from '../../evals/replay/recording.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Two eligible units over one local clone; the hidden test passes once fixed.txt exists. */
function fixture(root: string) {
  const clone = join(root, 'sources', 'o__r');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'n');
  writeFileSync(join(clone, 'a.txt'), '1\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const base = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'fixed.txt'), 'x\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const units = join(root, 'units');
  for (const [id, word] of [
    ['t-aaaaaaa', 'alpha'],
    ['t-bbbbbbb', 'beta'],
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
        test: 'test -f fixed.txt',
        committed: '2026-08-01',
        issue: `https://github.com/o/r/issues/${id.charCodeAt(2)}`,
      }),
    );
  }
  // The alpha session fixes the unit and commits its fix, so the recording must diff against base, not HEAD.
  const stub = join(root, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprompt="$*"\nif echo "$prompt" | grep -q alpha; then printf 'x\\n' > fixed.txt; git add fixed.txt; git -c user.email=a@b.c -c user.name=n commit -qm fix; fi\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.25}'\n`,
  );
  chmodSync(stub, 0o755);
  // Any model call during a replay leaves this marker.
  const marker = join(root, 'called');
  const forbidden = join(root, 'forbidden-claude');
  writeFileSync(forbidden, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(forbidden, 0o755);
  return { units, stub, forbidden, marker, base };
}

function screen(root: string, units: string, extra: string[], claude: string) {
  return spawnSync(
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
      ...extra,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        KRN_EVAL_CLAUDE: claude,
        KRN_EVAL_SLOT_DIR: join(root, 'slots'),
      },
    },
  );
}

test('the live screen path records each session patch and grade; replay regrades them equal with no model call', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-recording-'));
  try {
    const { units, stub, forbidden, marker, base } = fixture(root);
    const rec = join(root, 'recordings');
    const live = screen(root, units, ['--record', rec], stub);
    assert.equal(live.status, 0, live.stderr);
    const alpha = readFileSync(join(rec, 't-aaaaaaa-1.patch'), 'utf8');
    assert.match(alpha, /\+\+\+ b\/fixed\.txt/);
    assert.doesNotMatch(
      alpha,
      /hidden\.check/,
      'the hidden test is no part of the change',
    );
    assert.equal(readFileSync(join(rec, 't-bbbbbbb-1.patch'), 'utf8'), '');
    const graded = JSON.parse(
      readFileSync(join(rec, 't-aaaaaaa-1.json'), 'utf8'),
    ) as { pass: boolean; base: string };
    assert.equal(graded.pass, true);
    assert.equal(graded.base, base);
    assert.equal(
      JSON.parse(readFileSync(join(rec, 't-bbbbbbb-1.json'), 'utf8')).pass,
      false,
    );
    const replay = screen(root, units, ['--replay', rec], forbidden);
    assert.equal(replay.status, 0, replay.stdout + replay.stderr);
    assert.match(
      replay.stdout,
      /^replay t-aaaaaaa\/1: recorded pass, replayed pass, equal$/m,
    );
    assert.match(
      replay.stdout,
      /^replay t-bbbbbbb\/1: recorded fail, replayed fail, equal$/m,
    );
    assert.match(replay.stdout, /verdict: 2 of 2 replayed grades equal/);
    assert.equal(existsSync(marker), false, 'replay started a model session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replay exits 1 when a replayed grade differs from the recorded grade', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-recording-'));
  try {
    const { units, stub, forbidden } = fixture(root);
    const rec = join(root, 'recordings');
    assert.equal(screen(root, units, ['--record', rec], stub).status, 0);
    const file = join(rec, 't-bbbbbbb-1.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"pass":false', '"pass":true'),
    );
    const replay = screen(root, units, ['--replay', rec], forbidden);
    assert.equal(replay.status, 1, replay.stdout + replay.stderr);
    assert.match(
      replay.stdout,
      /replay t-bbbbbbb\/1: recorded pass, replayed fail, DIFFERENT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replay grades a hand-written plain unified diff and refuses one that does not apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-recording-'));
  try {
    const { units, forbidden, marker, base } = fixture(root);
    const rec = join(root, 'recordings');
    mkdirSync(rec);
    writeFileSync(
      join(rec, 't-aaaaaaa-1.patch'),
      '--- /dev/null\n+++ b/fixed.txt\n@@ -0,0 +1 @@\n+x\n',
    );
    const recording = {
      unit: 't-aaaaaaa',
      rep: 1,
      base,
      pass: true,
      install: 0,
      test: 0,
      harness: 'h',
    };
    writeFileSync(join(rec, 't-aaaaaaa-1.json'), JSON.stringify(recording));
    const ok = screen(root, units, ['--replay', rec], forbidden);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /recorded pass, replayed pass, equal/);
    writeFileSync(
      join(rec, 't-aaaaaaa-1.patch'),
      '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-not there\n+2\n',
    );
    const bad = screen(root, units, ['--replay', rec], forbidden);
    assert.equal(bad.status, 65, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /replay t-aaaaaaa\/1: no grade \(apply:/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a replay with no recording exits 65', () => {
  assert.equal(replayVerdict([]).code, 65);
});
