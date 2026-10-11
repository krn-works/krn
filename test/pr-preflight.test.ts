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
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('preflight CLI exposes its supported invocation through a subprocess', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/pr-preflight.mjs', '--help'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--repo <path> --base <ref> --head <ref>/u);
  assert.match(result.stdout, /--pr <number> --output <path>/u);
});

test('preflight writes a fail verdict with exact-head evidence when checks fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'krn-preflight-'));
  const executable = join(directory, 'gh');
  const output = join(directory, 'verdict.json');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  const srcTree = spawnSync('git', ['rev-parse', 'HEAD:src'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  const testTree = spawnSync('git', ['rev-parse', 'HEAD:test'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nconst [command, ...args] = process.argv.slice(2);\nif (command === 'pr') process.stdout.write(JSON.stringify({title: 'not conventional', headRefOid: ${JSON.stringify(head)}}));\nelse if (command === 'api') process.stdout.write(JSON.stringify([]));\nelse process.exitCode = 2;\n`,
  );
  chmodSync(executable, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/pr-preflight.mjs',
        '--repo',
        root,
        '--base',
        'HEAD',
        '--head',
        'HEAD',
        '--pr',
        '225',
        '--output',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
      },
    );
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const verdict = JSON.parse(readFileSync(output, 'utf8')) as {
      verdict: string;
      head: string;
      trees: { src: string; test: string };
      status: { context: string; state: string | null; creator: string | null };
      reasons: string[];
    };
    assert.equal(verdict.verdict, 'fail');
    assert.equal(verdict.head, head);
    assert.deepEqual(verdict.trees, { src: srcTree, test: testTree });
    assert.deepEqual(verdict.status, {
      context: 'krn/gate-local',
      state: null,
      creator: null,
    });
    assert.ok(
      verdict.reasons.some((reason) => reason.includes('Conventional')),
    );
    assert.ok(verdict.reasons.some((reason) => reason.includes('status')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
