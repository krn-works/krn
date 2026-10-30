import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { Runner } from '../../src/deliver/transport.ts';
import { classify, decision, triage } from '../../src/triage/index.ts';

const root = new URL('../../', import.meta.url).pathname;
const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/triage/${name}.log`, import.meta.url),
    'utf8',
  );
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function workspace(t: { after: (fn: () => void) => void }) {
  const parent = join(root, '.krn/runs/claude/triage/worker-r3');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('verbatim receiver logs classify in priority order', () => {
  for (const [name, expected] of [
    ['sandbox', 'sandbox-tooling'],
    ['policy', 'policy'],
    ['timeout', 'timeout'],
    ['test-red', 'test-failure'],
    ['runner-annotations', 'runner-lost'],
  ] as const)
    assert.equal(classify(fixture(name)), expected);
  assert.equal(
    classify(fixture('runner-annotations') + fixture('policy')),
    'runner-lost',
  );
  assert.equal(classify('nothing failed'), 'unknown');
  assert.equal(
    decision(
      join(root, 'test/rules', `no-${['paper', 'clip'].join('')}.test.mjs`),
    ),
    'ADR 0011',
  );
});

test('test evidence confirms base passes and recognizes shared base failures', async (t) => {
  const dir = workspace(t);
  for (const [baseName, expected] of [
    ['test-green', 'confirmed'],
    ['test-red', 'failed-at-base'],
  ] as const) {
    const result = await triage(
      {
        head,
        base,
        logText: fixture('test-red'),
        baseText: fixture(baseName),
        out: join(dir, baseName),
      },
      { cwd: root },
    );
    assert.equal(result.verdict, expected);
    assert.equal(result.exitCode, 0);
    assert.equal(result.tests[0]?.name, 'calculation result');
    assert.match(
      result.tests[0]?.location ?? '',
      /calculation\.test\.mjs:3:1/u,
    );
    const brief = readFileSync(result.brief, 'utf8');
    for (const text of [
      'node --test --test-name-pattern',
      head,
      base,
      '.node-version',
      'git',
      'npm',
    ])
      assert.ok(brief.includes(text), text);
    assert.ok(result.excerpt.split('\n').length <= 200);
  }
});

test('partial base failures leave the unmatched head failure insufficient', async (t) => {
  const result = await triage(
    {
      head,
      base,
      logText:
        "not ok 1 - case A\n  location: 'test/a.test.ts:1:1'\nnot ok 2 - case B\n  location: 'test/a.test.ts:2:1'",
      baseText: 'not ok 1 - case A',
      out: workspace(t),
    },
    { cwd: root },
  );
  assert.equal(result.verdict, 'insufficient');
  assert.ok(
    result.missing.some((item) => item.item === 'base evidence: case B'),
  );
});

test('CLI rejects an overlong syntactically valid repository with usage exit', (t) => {
  const dir = workspace(t);
  const cli = join(root, 'src/cli/main.ts');
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'triage',
      '--ci-run',
      '123',
      '--repo',
      `owner/${'r'.repeat(5000)}`,
      '--out',
      join(dir, 'brief'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 64, result.stderr);
});

test('triage rejects an overlong repository before creating artifacts', async (t) => {
  const out = join(workspace(t), 'brief');
  await assert.rejects(
    triage(
      { ciRun: '123', repo: `owner/${'r'.repeat(101)}`, out },
      { cwd: root, run: () => ({ code: 0, stdout: '', stderr: '' }) },
    ),
    /Invalid triage arguments/u,
  );
  assert.equal(existsSync(out), false);
});

test('a CI wrapper location resolves to the test file frame in the worker checkout', async (t) => {
  const result = await triage(
    { head, base, logText: fixture('ci-wrapper'), out: workspace(t) },
    { cwd: root },
  );
  const file = join(root, 'test/hosts/codex-launch.test.ts');
  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0]?.file, file);
  assert.match(
    result.tests[0]?.location ?? '',
    /codex-launch\.test\.ts:74:21/u,
  );
  assert.ok(result.commands.some((command) => command.includes(file)));
  const fixtureRoot = '/home/runner/work/krn/krn';
  assert.ok(
    result.commands
      .filter((command) => command.includes('codex-launch.test.ts'))
      .every((command) => command.includes(file)),
  );
  assert.ok(
    resolve(root) === fixtureRoot ||
      !result.commands.some((command) => command.includes(fixtureRoot)),
  );
});

test('GitHub CI log preserves failures after lint output mentions a key marker', async (t) => {
  const result = await triage(
    { logText: fixture('lint-key-marker'), out: workspace(t) },
    { cwd: root },
  );
  assert.equal(result.class, 'test-failure');
  assert.ok(
    result.tests.some(
      (failure) =>
        failure.name ===
        'a CI wrapper location resolves to the test file frame in the worker checkout',
    ),
  );
});

test('policy and timeout require matching test-level base evidence', async (t) => {
  const dir = workspace(t);
  for (const name of ['policy', 'timeout']) {
    const log = fixture(name);
    const result = await triage(
      { head, base, logText: log, baseText: log, out: join(dir, name) },
      { cwd: root },
    );
    assert.equal(result.verdict, 'failed-at-base');
    if (name === 'policy') {
      assert.equal(result.tests[0]?.adr, 'KRN-13');
      assert.match(readFileSync(result.brief, 'utf8'), /ADR: KRN-13/u);
    }
  }
});

test('a rules hit without a recorded decision is insufficient and names the header', async (t) => {
  const dir = workspace(t);
  mkdirSync(join(dir, 'test/rules'), { recursive: true });
  writeFileSync(join(dir, 'test/rules/unheaded.test.ts'), 'export {};\n');
  const log = fixture('policy').replaceAll(
    'context-budget.test.ts',
    'unheaded.test.ts',
  );
  const result = await triage(
    { head, base, logText: log, baseText: log, out: join(dir, 'out') },
    { cwd: dir },
  );
  assert.equal(result.class, 'policy');
  assert.equal(result.verdict, 'insufficient');
  assert.ok(
    result.missing.some(
      (m) => m.item.startsWith('ADR id') && m.command.includes('Decision'),
    ),
  );
});

test('artifacts redact secrets and stay bounded for hostile logs', async (t) => {
  const dir = workspace(t);
  const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const many = Array.from(
    { length: 80 },
    (_, i) => `not ok ${i + 1} - case ${i}\n  location: 'test/a.test.ts:1:1'`,
  ).join('\n');
  const logText = [
    'PASSWORD=hunter2',
    `${key}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${end}`,
    `${key}\nTRUNCATEDb2R5IG9mIGEga2V5\nUNTERMINATEDa2V5IGJvZHk=`,
    `ETIMEDOUT ${'x'.repeat(50_000)}`,
    ...Array.from({ length: 40 }, (_, i) => `node v24.${i}.0`),
    many,
  ].join('\n');
  const result = await triage(
    { head, base, logText, out: join(dir, 'out') },
    { cwd: root },
  );
  const written = [
    readFileSync(result.brief, 'utf8'),
    readFileSync(join(dir, 'out/triage.json'), 'utf8'),
  ];
  for (const text of written) {
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
    assert.ok(!text.includes('TRUNCATEDb2R5IG9mIGEga2V5'));
    assert.ok(!text.includes('UNTERMINATEDa2V5IGJvZHk='));
    assert.ok(text.length < 200_000, `${text.length}`);
  }
  assert.equal(result.tests.length, 50);
  assert.ok(result.truncated.some((t) => t.startsWith('failing tests')));
  assert.ok(result.truncated.some((t) => t.startsWith('log version lines')));
});

test('long test names match the base log in full and only artifacts are clipped', async (t) => {
  const dir = workspace(t);
  const name = `calculation result ${'n'.repeat(600)}`;
  const file = `test/${'d/'.repeat(300)}calculation.test.mjs`;
  const log = fixture('test-red')
    .replaceAll('calculation result', name)
    .replaceAll('test/calculation.test.mjs', file);
  const result = await triage(
    { head, base, logText: log, baseText: log, out: join(dir, 'out') },
    { cwd: root },
  );
  assert.equal(result.verdict, 'failed-at-base');
  assert.ok((result.tests[0]?.name.length ?? 0) < 600);
  assert.ok((result.tests[0]?.file.length ?? 0) < 600);
  assert.ok(!result.commands.some((command) => command.includes(file)));
  assert.ok(!result.commands.some((command) => command.includes('[truncated')));
});

test('insufficient lists missing inputs and commands without guessing base passes', async (t) => {
  const dir = workspace(t);
  const empty = await triage({ out: join(dir, 'empty') }, { cwd: root });
  assert.equal(empty.exitCode, 66);
  assert.equal(empty.verdict, 'insufficient');
  for (const item of ['head', 'base', 'log', 'class'])
    assert.ok(empty.missing.some((m) => m.item === item));
  assert.ok(empty.missing.every((m) => m.command.length > 0));
  const unknownBase = await triage(
    {
      head,
      base,
      logText: fixture('test-red'),
      baseText: 'ok 1 - unrelated',
      out: join(dir, 'unrelated'),
    },
    { cwd: root },
  );
  assert.equal(unknownBase.verdict, 'insufficient');
  assert.ok(unknownBase.missing.some((m) => m.item.includes('base evidence')));
  const absent = await triage(
    { head, base, logText: 'ETIMEDOUT', out: join(dir, 'absent') },
    { cwd: root },
  );
  assert.ok(absent.missing.some((m) => m.item === 'failing test names'));
  assert.ok(absent.missing.some((m) => m.item === 'base-log'));
});

test('environment signatures confirm without attributing head or needing base log', async (t) => {
  const dir = workspace(t);
  const result = await triage(
    { head, base, logText: fixture('sandbox'), out: dir },
    { cwd: root },
  );
  assert.equal(result.verdict, 'confirmed');
  assert.match(readFileSync(result.brief, 'utf8'), /not head-attributable/u);
});

test('CI adapter uses captured run, jobs and check annotations through Runner', async (t) => {
  const dir = workspace(t);
  const calls: string[][] = [];
  const runner: Runner = (command, args) => {
    calls.push([command, ...args]);
    const text = args.includes('--log-failed')
      ? ''
      : args.includes('headSha,attempt')
        ? fixture('runner-run')
        : args.at(-1)?.endsWith('/annotations')
          ? fixture('runner-annotations')
          : fixture('runner-jobs');
    return { code: 0, stdout: text, stderr: '' };
  };
  const result = await triage(
    { ciRun: '39124131004', repo: 'krn-works/krn', base, out: dir },
    { cwd: root, run: runner },
  );
  assert.equal(result.class, 'runner-lost');
  assert.equal(result.verdict, 'confirmed');
  assert.equal(result.head, JSON.parse(fixture('runner-run')).headSha);
  assert.ok(calls.some((c) => c.includes('--log-failed')));
  assert.ok(calls.some((c) => c.some((a) => a.endsWith('/annotations'))));
});

test('empty CI log with warning annotations reports a log recovery command', async (t) => {
  const runner: Runner = (_command, args) => ({
    code: 0,
    stdout: args.includes('headSha,attempt')
      ? fixture('runner-run')
      : args.at(-1)?.endsWith('/annotations')
        ? JSON.stringify([
            {
              path: '.github/workflows/ci.yml',
              start_line: 1,
              annotation_level: 'warning',
              title: 'Notice',
              message: 'A warning',
            },
          ])
        : args.includes('--log-failed')
          ? ''
          : fixture('runner-jobs').replace(
              '"steps":[]',
              '"steps":[{"status":"completed","started_at":"2026-10-18T11:39:52Z"}]',
            ),
    stderr: '',
  });
  const result = await triage(
    { ciRun: '39124131004', repo: 'krn-works/krn', base, out: workspace(t) },
    { cwd: root, run: runner },
  );
  assert.ok(
    result.missing.some(
      (item) =>
        item.item === 'log' &&
        item.command.includes('--attempt 1 --log-failed'),
    ),
  );
});

test('CLI writes both files, emits one verdict line or JSON, and preserves exit codes', (t) => {
  const dir = workspace(t);
  const log = join(dir, 'red.log');
  writeFileSync(log, fixture('sandbox'));
  const cli = join(root, 'src/cli/main.ts');
  const invoke = (args: string[]) =>
    spawnSync(process.execPath, [cli, 'triage', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  const result = invoke([
    '--head',
    head,
    '--base',
    base,
    '--log',
    log,
    '--out',
    join(dir, 'output'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^triage: confirmed sandbox-tooling [^\n]+\n$/u);
  const json = invoke(['--out', join(dir, 'missing'), '--json']);
  assert.equal(json.status, 66, json.stderr);
  assert.equal(JSON.parse(json.stdout).verdict, 'insufficient');
  assert.equal(invoke(['--wat']).status, 64);
  assert.equal(invoke(['--ci-run', '1']).status, 64);
  assert.equal(invoke(['--help']).status, 0);
});

test('secrets are absent from persisted diagnostics and CLI errors', async (t) => {
  const dir = workspace(t);
  const secret = `ghp_${'x'.repeat(30)}`;
  const bearer = 'Bearer private-value';
  const result = await triage(
    {
      head,
      base,
      logText: `npm: command not found\n${secret}\n${bearer}`,
      out: dir,
    },
    { cwd: root },
  );
  for (const file of ['brief.md', 'triage.json']) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(bearer));
  }
  assert.equal(result.verdict, 'confirmed');
});

test('CI prefixes preserve test names and passing rules do not reclassify a code failure', async (t) => {
  const dir = workspace(t);
  const prefix = 'gate test 2026-10-30T12:00:00Z ';
  const log = `${prefix}test at test/calculation.test.mjs:3:1\n${prefix}✖ calculation result (12.0ms)\n`;
  const result = await triage(
    {
      head,
      base,
      logText: log,
      baseText: `${prefix}✔ calculation result (10ms)`,
      out: dir,
    },
    { cwd: root },
  );
  assert.equal(result.verdict, 'confirmed');
  assert.equal(result.tests[0]?.name, 'calculation result');
  assert.equal(
    classify(`ok 1 - test/rules/example.test.ts\n${fixture('test-red')}`),
    'test-failure',
  );
});

test('malformed CI metadata and mismatched head fail closed with a recovery command', async (t) => {
  const dir = workspace(t);
  for (const [name, text] of [
    ['malformed', '{}'],
    ['mismatch', fixture('runner-run')],
  ]) {
    const runner: Runner = () => ({ code: 0, stdout: text ?? '', stderr: '' });
    const result = await triage(
      {
        head,
        base,
        ciRun: '39124131004',
        repo: 'krn-works/krn',
        out: join(dir, name ?? ''),
      },
      { cwd: root, run: runner },
    );
    assert.equal(result.verdict, 'insufficient');
    assert.ok(
      result.missing.some(
        (m) => m.item === 'CI metadata' && m.command.includes('gh run view'),
      ),
    );
  }
});

test('base matching includes failures beyond the artifact limit', async (t) => {
  const logText = Array.from(
    { length: 51 },
    (_, i) =>
      `not ok ${i + 1} - case ${i + 1}\n  location: 'test/a.test.ts:1:1'`,
  ).join('\n');
  const baseText = Array.from(
    { length: 51 },
    (_, i) => `${i === 50 ? 'not ok' : 'ok'} ${i + 1} - case ${i + 1}`,
  ).join('\n');
  const result = await triage(
    { head, base, logText, baseText, out: workspace(t) },
    { cwd: root },
  );
  assert.equal(result.verdict, 'confirmed');
  assert.equal(result.tests.length, 50);
});

test('missing base evidence beyond the artifact limit is bounded and reported', async (t) => {
  const logText = Array.from(
    { length: 105 },
    (_, i) =>
      `not ok ${i + 1} - case ${i + 1}\n  location: 'test/a.test.ts:1:1'`,
  ).join('\n');
  const result = await triage(
    { head, base, logText, baseText: 'ok 1 - unrelated', out: workspace(t) },
    { cwd: root },
  );
  assert.equal(result.verdict, 'insufficient');
  assert.equal(
    result.missing.filter((m) => m.item.startsWith('base evidence:')).length,
    50,
  );
  assert.ok(result.truncated.some((note) => note.startsWith('base evidence:')));
  const tail = await triage(
    {
      head,
      base,
      logText,
      baseText: Array.from(
        { length: 50 },
        (_, i) => `ok ${i + 1} - case ${i + 1}`,
      ).join('\n'),
      out: join(workspace(t), 'tail'),
    },
    { cwd: root },
  );
  assert.equal(tail.verdict, 'insufficient');
  assert.equal(
    tail.missing.filter((m) => m.item.startsWith('base evidence:')).length,
    50,
  );
  assert.ok(tail.missing.some((m) => m.item === 'base evidence: case 51'));
});

test('version metadata is clipped in both persisted artifacts', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, '.node-version'), 'n'.repeat(50_000));
  const runner: Runner = () => ({
    code: 0,
    stdout: 'v'.repeat(50_000),
    stderr: '',
  });
  const result = await triage(
    {
      head,
      base,
      logText: `npm: command not found\nnode v24 ${'x'.repeat(50_000)}`,
      out: join(dir, 'out'),
    },
    { cwd: dir, run: runner },
  );
  for (const file of ['triage.json', 'brief.md']) {
    const text = readFileSync(join(dir, 'out', file), 'utf8');
    assert.ok(text.length < 200_000, `${file}: ${text.length}`);
    assert.match(text, /truncated/u);
  }
  for (const version of Object.values(result.versions)) {
    assert.ok(version.length < 600, `${version.length}`);
    assert.match(version, /truncated/u);
  }
});

test('CI adapter selects the latest failed attempt from verbatim receivers', async (t) => {
  const calls: string[][] = [];
  const runner: Runner = (command, args) => {
    calls.push([command, ...args]);
    const text =
      command !== 'gh'
        ? 'v1'
        : args.includes('headSha,attempt')
          ? fixture('attempts-run')
          : args.at(-1)?.endsWith('/attempts/2/jobs')
            ? fixture('attempts-jobs-2')
            : args.at(-1)?.endsWith('/attempts/1/jobs')
              ? fixture('attempts-jobs-1')
              : args.includes('--log-failed')
                ? fixture('attempts-failed-1')
                : '[]';
    return { code: 0, stdout: text, stderr: '' };
  };
  const name =
    'independent trace appenders preserve events across a torn-tail repair';
  const dir = workspace(t);
  const result = await triage(
    {
      ciRun: '40562324411',
      repo: 'krn-works/krn',
      base,
      baseText: `ok 1 - ${name}`,
      out: dir,
    },
    { cwd: root, run: runner },
  );
  assert.equal(result.class, 'test-failure');
  assert.equal(result.verdict, 'confirmed');
  assert.equal(result.tests[0]?.name, name);
  assert.equal(result.head, '05c9eb332a7f5b43d3839bfc184696d2f3977255');
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')).attempt,
    1,
  );
  assert.match(readFileSync(result.brief, 'utf8'), /Attempt: 1/u);
  assert.ok(
    calls.some(
      (c) =>
        c.includes('--log-failed') &&
        c.includes('--attempt') &&
        c.includes('1'),
    ),
  );
});

test('CI attempt search is bounded and reports absent failed attempts', async (t) => {
  for (const attempt of [2, 100]) {
    const calls: string[][] = [];
    const runner: Runner = (command, args) => {
      calls.push([command, ...args]);
      return {
        code: 0,
        stdout:
          command !== 'gh'
            ? 'v1'
            : args.includes('headSha,attempt')
              ? JSON.stringify({ headSha: head, attempt })
              : fixture('attempts-jobs-2'),
        stderr: '',
      };
    };
    const result = await triage(
      { ciRun: '40562324411', repo: 'krn-works/krn', base, out: workspace(t) },
      { cwd: root, run: runner },
    );
    assert.equal(result.verdict, 'insufficient');
    assert.ok(result.missing.some((m) => m.item.includes('failed CI attempt')));
    assert.equal(
      calls.filter((c) => c.some((a) => a.endsWith('/jobs'))).length,
      Math.min(attempt, 10),
    );
    assert.ok(!calls.some((c) => c.includes('--log-failed')));
  }
});
