import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyArgs,
  MERGE_SETTINGS,
  mergeSettingGaps,
} from '../../src/repo/merge-settings.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
// KRN-12: a verbatim `gh api repos/{owner}/{repo}` reply for krn-works/krn (2026-11-18).
const captured = readFileSync(
  new URL(
    '../fixtures/gh/repo-settings-krn-works-krn.stdout.json',
    import.meta.url,
  ),
  'utf8',
);
const withMergeCommits = JSON.stringify({
  ...JSON.parse(captured),
  allow_merge_commit: true,
});

test('the captured KRN settings lack only the PR_BODY squash body', () => {
  assert.deepEqual(mergeSettingGaps(captured), [
    {
      key: 'squash_merge_commit_message',
      want: 'PR_BODY',
      have: 'COMMIT_MESSAGES',
    },
  ]);
});

test('apply sends one typed PATCH field per gap', () => {
  assert.deepEqual(applyArgs('repos/o/r', mergeSettingGaps(withMergeCommits)), [
    'api',
    '-X',
    'PATCH',
    'repos/o/r',
    '-F',
    'allow_merge_commit=false',
    '-f',
    'squash_merge_commit_message=PR_BODY',
  ]);
});

/** A gh on PATH that answers `api repos/...` with `reply`, and a PATCH with `reply` patched by its fields; it logs every call. */
function fakeGh(reply: string) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-repo-settings-'));
  writeFileSync(join(dir, 'reply.json'), reply);
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, args.join(' ') + '\\n');
const repo = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'reply.json'))}, 'utf8'));
for (let i = 0; i < args.length; i++)
  if (args[i] === '-F' || args[i] === '-f') {
    const [key, value] = args[i + 1].split('=');
    repo[key] = args[i] === '-F' ? JSON.parse(value) : value;
  }
process.stdout.write(JSON.stringify(repo));
`;
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [cli, 'repo', 'settings', '--repo', 'o/r', ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      },
    );
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8');
  return {
    run,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('krn repo settings reports a merge-commit-enabled repository as non-conforming', () => {
  const gh = fakeGh(withMergeCommits);
  try {
    const result = gh.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^gap allow_merge_commit: true, want false$/mu);
    assert.match(
      result.stdout,
      /^gap squash_merge_commit_message: "COMMIT_MESSAGES", want "PR_BODY"$/mu,
    );
    assert.match(
      result.stdout,
      /FAIL repo settings: 2 gaps; --apply sets them/u,
    );
    assert.equal(gh.calls(), 'api repos/o/r\n');
  } finally {
    gh.cleanup();
  }
});

test('krn repo settings --apply patches the gaps and passes', () => {
  const gh = fakeGh(withMergeCommits);
  try {
    const result = gh.run('--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /applied 2 settings\nPASS repo settings/u);
    assert.equal(
      gh.calls(),
      'api repos/o/r\napi -X PATCH repos/o/r -F allow_merge_commit=false -f squash_merge_commit_message=PR_BODY\n',
    );
  } finally {
    gh.cleanup();
  }
});

test('a conforming repository passes with no PATCH', () => {
  const gh = fakeGh(
    JSON.stringify({ ...JSON.parse(captured), ...MERGE_SETTINGS }),
  );
  try {
    const result = gh.run('--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PASS repo settings\n');
    assert.equal(gh.calls(), 'api repos/o/r\n');
  } finally {
    gh.cleanup();
  }
});
