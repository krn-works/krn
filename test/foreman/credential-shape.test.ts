import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { credentialShapeKind } from '../../src/foreman/credential-shape.ts';
import {
  b954HasExplicitCredentialMarker,
  b954UrlCredentialKind,
} from '../fixtures/credential-shape-b954.ts';

const markerFixtures: readonly (readonly [string, string])[] = [
  ['private key', '-----BEGIN PRIVATE KEY-----'],
  ['generic sk token', 'sk-' + 'a'.repeat(20)],
  ['sk test', 'sk-test-' + 'a'.repeat(16)],
  ['sk project', 'sk-proj-' + 'a'.repeat(16)],
  ['sk live', 'sk-live-' + 'a'.repeat(16)],
  ['sk ant', 'sk-ant-' + 'a'.repeat(16)],
  ['sk ant API', 'sk-ant-api03-' + 'a'.repeat(16)],
  ['sk underscore live', 'sk_live_' + 'a'.repeat(16)],
  ['rk underscore test', 'rk_test_' + 'a'.repeat(16)],
  ...['p', 'o', 'u', 's', 'r'].map((kind): readonly [string, string] => [
    'GitHub ' + kind,
    'gh' + kind + '_' + 'a'.repeat(20),
  ]),
  ['GitHub fine-grained', 'github_pat_' + 'a'.repeat(16)],
  ['npm', 'npm_' + 'a'.repeat(36)],
  ['AWS access', 'AKIA' + 'A'.repeat(16)],
  ['AWS session', 'ASIA' + 'A'.repeat(16)],
  ['Google', 'AIza' + 'A'.repeat(35)],
  ...['b', 'a', 'p', 'r', 's'].map((kind): readonly [string, string] => [
    'Slack ' + kind,
    'xox' + kind + '-' + 'a'.repeat(10),
  ]),
  ['JWT', 'eyJ' + 'a'.repeat(8) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(8)],
];

function c1Corpus(): string[] {
  const corpus = markerFixtures.flatMap(([, marker]) => [
    marker,
    'noise/' + marker,
    'value=' + marker,
    'noise-' + marker,
    'noise.' + marker,
    'noise:' + marker,
    'noise_' + marker,
    'x' + marker,
    '_' + marker,
    marker + 'x',
    marker + '_tail',
  ]);
  corpus.push(
    'sk-' + 'a'.repeat(19),
    'sk-proj-' + 'a'.repeat(15),
    'sk_test_' + 'a'.repeat(15),
    'ghp_' + 'a'.repeat(19),
    'github_pat_' + 'a'.repeat(15),
    'npm_' + 'a'.repeat(35),
    'AKIA' + 'A'.repeat(15),
    'AIza' + 'A'.repeat(34),
    'xoxb-' + 'a'.repeat(9),
    'eyJ' + 'a'.repeat(7) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(8),
    'eyJ' + 'a'.repeat(8) + '.' + 'b'.repeat(7) + '.' + 'c'.repeat(8),
    'eyJ' + 'a'.repeat(8) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(7),
    '-----BEGIN PRIVATE KEY--',
  );
  let state = 0x277a2026;
  const fragments = [
    'noise',
    'x',
    'a',
    '7',
    '/',
    '=',
    '-',
    '.',
    '_',
    ':',
    ' ',
    '\n',
    'sk-proj',
    'ghp',
    'xoxb',
    'eyJ',
    'npm_',
    'AIza',
  ];
  for (let sample = 0; sample < 128; sample++) {
    let source = '';
    for (let part = 0; part < 5; part++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      source += fragments[(state >>> 0) % fragments.length];
    }
    corpus.push(source);
  }
  return corpus;
}

function c2Corpus(): string[] {
  const token = 'a'.repeat(12);
  const corpus = [
    'https://example.test:8443/v2/models?region=west',
    'https://user:' + token + '@example.test/path',
    'https://' + token + '@example.test/path',
    'https://:password@example.test/path',
    'https://example.test/path?token=' + token,
    'https://example.test/path?refresh_token=' + token,
    'https://example.test/path?%74oken=' + token,
    'https://example.test/path?region=west&api_key=' + token,
    'https://example.test/path?token=',
    'https://example.test/path?region=west',
    'prefixhttps://user:' + token + '@example.test/path',
    '_https://user:' + token + '@example.test/path',
    '/https://example.test:9443/v3/models?region=east',
    'https://example.test/a-b.c_d:e?q=x-y.z',
    'https://example.test/path?client-secret=' + token,
    'https://example.test/path?password=' + token,
    'https://example.test/path?not_a_credential=' + token,
    'https://[malformed/path?token=' + token,
    'http://example.test:8080/path?api-key=' + token,
    'https://example.test/path?token=one&token=two',
  ];
  let state = 0x277a2026;
  const fragments = [
    'noise',
    'http',
    'https',
    '://',
    '/',
    '?',
    '&',
    '=',
    '-',
    '.',
    '_',
    ':',
    'token',
    'api_key',
    'region',
    'x',
    'a',
    '7',
  ];
  for (let sample = 0; sample < 128; sample++) {
    let source = '';
    for (let part = 0; part < 6; part++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      source += fragments[(state >>> 0) % fragments.length];
    }
    corpus.push(source);
  }
  return corpus;
}

test('C1 and C2 retain exact b954 behavior on deterministic short corpora', () => {
  const explicitCases = c1Corpus();
  for (const source of explicitCases) {
    assert.ok(source.length <= 200, 'C1 oracle input must remain short');
    assert.equal(
      credentialShapeKind(source) === 'explicit credential marker',
      b954HasExplicitCredentialMarker(source),
      'C1 mismatch for ' + JSON.stringify(source),
    );
  }

  const uriCases = c2Corpus();
  for (const source of uriCases) {
    assert.ok(source.length <= 200, 'C2 oracle input must remain short');
    const actual = credentialShapeKind(source);
    assert.equal(
      actual === 'URL credentials' || actual === 'URL credential parameter'
        ? actual
        : null,
      b954UrlCredentialKind(source),
      'C2 mismatch for ' + JSON.stringify(source),
    );
  }
});

test('C1 scans embedded and late long valid credential material without clipping', () => {
  const marker = 'sk-proj-' + 'a'.repeat(16);
  assert.equal(
    credentialShapeKind('prefix/' + marker),
    'explicit credential marker',
  );
  assert.equal(
    credentialShapeKind('x=' + marker),
    'explicit credential marker',
  );

  const jwt =
    'eyJ' +
    'a'.repeat(50_000) +
    '.' +
    'b'.repeat(50_000) +
    '.' +
    'c'.repeat(50_000);
  assert.equal(
    credentialShapeKind('prefix/' + 'x'.repeat(100_000) + '/' + jwt),
    'explicit credential marker',
  );
});

const boundedChild = [
  "import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "import { spawnSync } from 'node:child_process';",
  "import { prepareCheckpoint } from './src/foreman/commit.ts';",
  'const testCase = process.argv[1];',
  'const size = 999000;',
  'const tail = "\\nconst password = \'abcdefg\';\\n";',
  'function repeatToLength(value, length) { return value.repeat(Math.ceil(length / value.length)).slice(0, length); }',
  'let unit;',
  'if (testCase === "a-dashes") unit = "a-";',
  'else if (testCase === "jwt-prefixes") unit = "eyJ-";',
  'else if (testCase === "short-sk-project") unit = "sk-proj-" + "a".repeat(15) + "\\n";',
  'else if (testCase === "short-slack") unit = "xoxb-" + "a".repeat(9) + "\\n";',
  'else if (testCase === "password-words") unit = "password ";',
  'else if (testCase === "password-string") unit = "password:string\\n";',
  'else if (testCase === "password-empty") unit = "password=\\n";',
  'else throw new Error("unknown boundedness case");',
  'const source = repeatToLength(unit, size - tail.length) + tail;',
  'const root = mkdtempSync(join(tmpdir(), "krn-lon277-bound-"));',
  'try {',
  '  const initialized = spawnSync("git", ["init", "-q", "--initial-branch=main", root], { encoding: "utf8" });',
  '  if (initialized.status !== 0) throw new Error(initialized.stderr);',
  '  writeFileSync(join(root, "candidate.ts"), source);',
  '  const bytes = statSync(join(root, "candidate.ts")).size;',
  '  if (bytes >= 1000000) throw new Error("boundedness fixture reached file-size guard");',
  '  try {',
  '    prepareCheckpoint({ id: "LON-277", issue: "LON-277", worktree: root }, "test: bounded scanner", "session-bounded");',
  '    throw new Error("terminal sensitive literal was not detected");',
  '  } catch (error) {',
  '    if (!String(error.message).includes("secret pattern in candidate.ts")) throw error;',
  '  }',
  '  process.stdout.write(JSON.stringify({ testCase, bytes }));',
  '} finally { rmSync(root, { recursive: true, force: true }); }',
].join('\n');

test('whole-file credential and binding scans stay within the hard two-second child bound', (t) => {
  const cases = [
    'a-dashes',
    'jwt-prefixes',
    'short-sk-project',
    'short-slack',
    'password-words',
    'password-string',
    'password-empty',
  ];
  const failures: string[] = [];
  for (const testCase of cases) {
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', boundedChild, testCase],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
    );
    const elapsedMs = performance.now() - start;
    t.diagnostic(
      JSON.stringify({
        testCase,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        status: result.status,
        signal: result.signal,
      }),
    );
    if (result.error || result.status !== 0 || elapsedMs >= 2000) {
      failures.push(
        testCase +
          ' failed at ' +
          elapsedMs.toFixed(1) +
          'ms: ' +
          (result.error?.message ?? result.stderr + result.stdout),
      );
      continue;
    }
    try {
      assert.deepEqual(JSON.parse(result.stdout), { testCase, bytes: 999000 });
    } catch (error) {
      failures.push(testCase + ': ' + String(error));
    }
  }
  assert.deepEqual(failures, []);
});
