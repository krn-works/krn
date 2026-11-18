import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { plan, subscriptionEnv } from '../../scripts/claude/astra-critique.ts';

const script = fileURLToPath(
  new URL('../../scripts/claude/astra-critique.ts', import.meta.url),
);
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'astra-'));
  mkdirSync(join(root, '.krn/tmp'), { recursive: true });
  writeFileSync(
    join(root, '.krn/tmp/friction.md'),
    '- workaround: egress socket path (evidence: .krn/runs/x/log.txt)\n',
  );
  return root;
};
const run = (root: string, args: string[], env = process.env) =>
  spawnSync('node', [script, ...args], { cwd: root, encoding: 'utf8', env });

test('--dry-run prints the read-only astra command and the friction log, exit 0', () => {
  const root = repo();
  const result = run(root, ['--dry-run', '--date', '2026-01-02']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^codex exec -m gpt-6\.2-astra -c model_reasoning_effort=high -s read-only -C \S+ -o \S+\/\.krn\/runs\/research\/gpt-6-2\/critique-2026-01-02\.md - < prompt$/mu,
  );
  assert.match(result.stdout, /egress socket path/u);
});

test('--dry-run without a friction log still exits 0 and says it is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'astra-'));
  const result = run(root, ['--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /friction log .* is missing/u);
});

test('an unknown argument exits 64 naming it; a real run without a log exits 66', () => {
  const root = repo();
  const bad = run(root, ['--nope']);
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /unknown argument --nope/u);
  assert.equal(run(mkdtempSync(join(tmpdir(), 'astra-')), []).status, 66);
});

test('a real run pipes the prompt to codex without API keys and reports the critique path', () => {
  const root = repo();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'codex');
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, 'args.txt')}'\nenv > '${join(root, 'env.txt')}'\ncat > '${join(root, 'stdin.txt')}'\nwhile [ "$1" != -o ]; do shift; done\nprintf 'finding 1\\n' > "$2"\n`,
  );
  chmodSync(fake, 0o755);
  const result = run(root, ['--date', '2026-01-02'], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OPENAI_API_KEY: 'sk-secret',
    CODEX_API_KEY: 'sk-secret',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /critique-2026-01-02\.md$/mu);
  assert.doesNotMatch(readFileSync(join(root, 'env.txt'), 'utf8'), /API_KEY/u);
  assert.match(readFileSync(join(root, 'stdin.txt'), 'utf8'), /egress socket/u);
  assert.match(readFileSync(join(root, 'args.txt'), 'utf8'), /^read-only$/mu);
});

test('plan and subscriptionEnv are pure', () => {
  const p = plan('/r', { log: 'a.md', out: 'o.md' });
  assert.equal(p.out, '/r/o.md');
  assert.equal(p.missing, true);
  assert.deepEqual(subscriptionEnv({ A: '1', OPENAI_API_KEY: 'x' }), {
    A: '1',
  });
});
