import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregatePanelVerdict } from '../../src/flow/index.ts';

const passedJudge = {
  state: 'complete' as const,
  role: 'spec' as const,
  verdict: 'PASS' as const,
  findings: [],
  sessionId: 'passed',
  finalMessage: 'PASS',
};
const passedRun = {
  path: 'test/example.test.mjs',
  side: 'head' as const,
  sha: 'a'.repeat(40),
  classification: 'pass' as const,
  exitCode: 0,
  durationMs: 0,
  outputSha256: 'b'.repeat(64),
  summary: '',
};

test('a red-to-green contract whose red test passes blocks a passing panel', () => {
  const evidence = {
    results: [],
    contracts: [
      {
        commit: 'c'.repeat(40),
        path: passedRun.path,
        kind: 'red->green' as const,
        red: { ...passedRun, side: 'base' as const },
        green: passedRun,
        proven: false,
      },
    ],
  };
  assert.equal(aggregatePanelVerdict([passedJudge], false, evidence), 'FAIL');
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  classifyNodeTestOutput,
  git,
  redFirst,
} from '../../src/flow/repository.ts';
import {
  deterministicCauses,
  newReviewRecordSchema,
  panelRoles,
  reviewRecordSchema,
} from '../../src/flow/types.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import type { execute } from '../../src/verdict/sandbox.ts';

const testPath = 'test/example.test.mjs';
const passingTest =
  "import { test } from 'node:test'; test('works', () => {});\n";
const valueTest =
  "import assert from 'node:assert/strict'; import { test } from 'node:test'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Review test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message = 'fixture') => {
    git(root, ['add', '--all']);
    git(root, ['commit', '--allow-empty', '-qm', message]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  put('.gitignore', '.krn/\n');
  put('package.json', '{"type":"module"}');
  const initial = commit();
  return { root, put, commit, initial };
}

// Exercise the real Node runner, reporter, imports and private worktrees. Only
// the outer systemd/bwrap transport is substituted; host containment has its
// own integration tests in review.test.ts.
const localExecute: typeof execute = async (
  _root,
  copy,
  job,
  id,
  argv,
  _timeout,
  sha,
) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.KRN_ISOLATION_GATE_PRELOAD;
  const child = spawnSync(argv[0] ?? process.execPath, argv.slice(1), {
    cwd: copy,
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const output = child.stdout + child.stderr;
  const diagnostics = join(stateDirectory(job), 'diagnostics');
  mkdirSync(diagnostics, { recursive: true });
  writeFileSync(
    join(diagnostics, `${sha}-${id}-capture.txt`),
    Buffer.from(output).subarray(-2048),
  );
  return {
    id,
    exitCode:
      child.error && 'code' in child.error && child.error.code === 'ETIMEDOUT'
        ? 124
        : (child.status ?? 1),
    durationMs: 0,
    sha256: createHash('sha256').update(output).digest('hex'),
  };
};
const review = (
  f: ReturnType<typeof fixture>,
  base: string,
  head: string,
  run = localExecute,
) => redFirst(f.root, base, head, undefined, run);

function installGate(f: ReturnType<typeof fixture>) {
  f.put(
    'scripts/isolation-gate.mjs',
    readFileSync(
      new URL('../../scripts/isolation-gate.mjs', import.meta.url),
      'utf8',
    ),
  );
  f.put(
    'test/helpers/isolation.ts',
    readFileSync(new URL('../helpers/isolation.ts', import.meta.url), 'utf8'),
  );
  f.put(
    'krn.review.json',
    JSON.stringify({
      version: 1,
      testFile: { import: ['scripts/isolation-gate.mjs'] },
    }),
  );
}

test('base-declared preloader makes a changed Product-shaped test green', async (t) => {
  const f = fixture(t);
  installGate(f);
  f.put('src/value.mjs', 'export const value = 1;');
  const base = f.commit();
  f.put(testPath, `import './helpers/isolation.ts';\n${valueTest}`);
  f.put('src/value.mjs', 'export const value = 2;');
  const head = f.commit(`fix value\n\nChange-contract: ${testPath}:red->green`);
  const report = await review(f, base, head);
  assert.deepEqual(
    report.results.map((run) => run.classification),
    ['assertion', 'pass'],
  );
  assert.equal(report.contracts?.[0]?.proven, true);
  assert.equal(aggregatePanelVerdict([passedJudge], false, report), 'PASS');
  t.diagnostic(
    JSON.stringify({
      base: report.results[0]?.classification,
      head: report.results[1]?.classification,
      proven: report.contracts?.[0]?.proven,
    }),
  );
});

test('contract evaluates an unchanged test at its declaring parent, even when PR base is green', async (t) => {
  const f = fixture(t);
  f.put(testPath, valueTest);
  f.put('src/value.mjs', 'export const value = 2;');
  const base = f.commit();
  f.put('src/value.mjs', 'export const value = 1;');
  const parent = f.commit();
  f.put('src/value.mjs', 'export const value = 2;');
  const head = f.commit(
    `restore value\n\nChange-contract: ${testPath}:red->green`,
  );
  const report = await review(f, base, head);
  assert.deepEqual(report.results, []);
  assert.equal(report.contracts?.[0]?.red?.sha, parent);
  assert.equal(report.contracts?.[0]?.red?.classification, 'assertion');
  assert.equal(report.contracts?.[0]?.green.sha, head);
  assert.equal(report.contracts?.[0]?.proven, true);
});

test('a new test missing a head-added module on base is a genuine red', async (t) => {
  const f = fixture(t);
  const base = f.initial;
  f.put(testPath, valueTest);
  f.put('src/value.mjs', 'export const value = 2;');
  const head = f.commit(`add value\n\nChange-contract: ${testPath}:red->green`);
  const report = await review(f, base, head);
  assert.deepEqual(
    report.results.map((run) => run.classification),
    ['missing-module', 'pass'],
  );
  assert.equal(report.contracts?.[0]?.red?.classification, 'missing-module');
  assert.equal(report.contracts?.[0]?.proven, true);
  // A module missing on both sides is still a setup failure.
  f.put(testPath, "import '../src/absent.mjs';");
  const broken = f.commit();
  const procedural = await review(f, base, broken);
  assert.equal(procedural.results[0]?.classification, 'procedural');
  assert.equal(
    aggregatePanelVerdict([passedJudge], false, procedural),
    'INCOMPLETE',
  );
});

test('a green-to-green contract needs only the head and an uncontracted changed test must pass', async (t) => {
  const f = fixture(t);
  f.put(testPath, passingTest);
  const head = f.commit(
    `add test\n\nChange-contract: ${testPath}:green->green`,
  );
  const report = await review(f, f.initial, head);
  assert.equal(report.contracts?.[0]?.red, undefined);
  assert.equal(report.contracts?.[0]?.proven, true);
  f.put(
    testPath,
    "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('failure', () => assert.fail('broken'));",
  );
  const broken = f.commit();
  const failed = await review(f, head, broken);
  assert.equal(failed.results.at(-1)?.classification, 'assertion');
  assert.equal(aggregatePanelVerdict([passedJudge], false, failed), 'FAIL');
});

test('a passing red side is FAIL', async (t) => {
  const f = fixture(t);
  f.put(testPath, passingTest);
  const base = f.commit();
  const head = f.commit(
    `claim improvement\n\nChange-contract: ${testPath}:red->green`,
  );
  const report = await review(f, base, head);
  assert.equal(report.contracts?.[0]?.proven, false);
  assert.equal(aggregatePanelVerdict([passedJudge], false, report), 'FAIL');
  assert.match(
    deterministicCauses(report.results, report.contracts ?? [])[0]?.cause ?? '',
    /does not fail without the change/u,
  );
});

test('renamed and deleted tests with stale contracts produce data errors', async (t) => {
  for (const operation of ['rename', 'delete']) {
    const f = fixture(t);
    f.put(testPath, passingTest);
    const base = f.commit();
    if (operation === 'rename')
      renameSync(
        join(f.root, testPath),
        join(f.root, 'test/replacement.test.mjs'),
      );
    else rmSync(join(f.root, testPath));
    const head = f.commit(
      `retire test\n\nChange-contract: ${testPath}:green->green`,
    );
    const report = await review(f, base, head);
    assert.equal(report.contracts?.[0]?.green.exitCode, 65);
    assert.equal(report.contracts?.[0]?.proven, false);
    assert.equal(
      aggregatePanelVerdict([passedJudge], false, report),
      'INCOMPLETE',
    );
    if (operation === 'rename')
      assert.equal(report.results.at(-1)?.classification, 'pass');
  }
});

test('non-test, duplicate and malformed contract trailers are recorded as data errors', async (t) => {
  for (const trailer of [
    'src/value.mjs:red->green',
    `${testPath}:red->green\nChange-contract: ${testPath}:red->green`,
    `${testPath}:red-to-green`,
    '../test/outside.test.mjs:red->green',
  ]) {
    const f = fixture(t);
    f.put(testPath, passingTest);
    const head = f.commit(`declare contract\n\nChange-contract: ${trailer}`);
    const report = await review(f, f.initial, head);
    assert.ok(
      report.results.some(
        (run) => run.exitCode === 65 && run.cause === 'contract',
      ),
      trailer,
    );
    assert.notEqual(
      aggregatePanelVerdict([passedJudge], false, report),
      'PASS',
    );
  }
});

test('Change-contract text outside the final trailer paragraph is not a contract', async (t) => {
  const f = fixture(t);
  f.put(testPath, passingTest);
  const head = f.commit(
    `add test\n\nChange-contract: ${testPath}:red->green\n\nThis is explanatory body text.`,
  );
  const report = await review(f, f.initial, head);
  assert.deepEqual(report.contracts, []);
  assert.equal(aggregatePanelVerdict([passedJudge], false, report), 'PASS');
});

test('merge and side-branch commits both declare contracts; merge uses its first parent', async (t) => {
  const f = fixture(t);
  f.put(testPath, valueTest);
  f.put('src/value.mjs', 'export const value = 1;');
  const base = f.commit();
  git(f.root, ['checkout', '-qb', 'feature']);
  f.put('src/value.mjs', 'export const value = 2;');
  const feature = f.commit(
    `fix value\n\nChange-contract: ${testPath}:red->green`,
  );
  git(f.root, ['checkout', '-qb', 'integration', base]);
  f.put('unrelated.txt', 'independent change');
  const parent = f.commit();
  git(f.root, [
    'merge',
    '--no-ff',
    '-qm',
    `merge feature\n\nChange-contract: ${testPath}:red->green`,
    'feature',
  ]);
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const report = await review(f, base, head);
  assert.deepEqual(
    report.contracts?.map(({ commit }) => commit),
    [feature, head],
  );
  assert.equal(report.contracts?.[1]?.red?.sha, parent);
  assert.ok(report.contracts?.every(({ proven }) => proven));
});

test('runner configuration is optional and always comes from base', async (t) => {
  const f = fixture(t);
  f.put('base.mjs', 'globalThis.approved = true;');
  f.put('head.mjs', "throw new Error('head cannot select a runner');");
  f.put(
    'krn.review.json',
    JSON.stringify({ version: 1, testFile: { import: ['base.mjs'] } }),
  );
  const base = f.commit();
  f.put(
    'krn.review.json',
    JSON.stringify({ version: 1, testFile: { import: ['head.mjs'] } }),
  );
  f.put(
    testPath,
    "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('preloaded', () => assert.equal(globalThis.approved, true));",
  );
  const head = f.commit();
  assert.deepEqual(
    (await review(f, base, head)).results.map((run) => run.classification),
    ['pass', 'pass'],
  );
  // A config added by this head is ignored when absent on base.
  f.put(testPath, passingTest);
  f.put('krn.review.json', 'invalid JSON');
  const noBaseConfig = f.commit();
  assert.deepEqual(
    (await review(f, f.initial, noBaseConfig)).results.map(
      (run) => run.classification,
    ),
    ['pass', 'pass'],
  );
});

test('malformed, unknown-key and escaping runner configurations never execute tests', async (t) => {
  const f = fixture(t);
  for (const config of [
    'invalid JSON',
    '{"version":2,"testFile":{"import":[]}}',
    '{"version":1,"unknown":true,"testFile":{"import":[]}}',
    '{"version":1,"testFile":{"import":[],"command":"node"}}',
    ...[
      '../outside.mjs',
      'a/../outside.mjs',
      join(f.root, 'outside.mjs'),
      'C:\\outside.mjs',
      'missing.mjs',
    ].map((path) =>
      JSON.stringify({ version: 1, testFile: { import: [path] } }),
    ),
  ]) {
    f.put('krn.review.json', config);
    const base = f.commit();
    f.put(testPath, passingTest);
    const head = f.commit();
    let calls = 0;
    const report = await review(f, base, head, async (...args) => {
      calls++;
      return localExecute(...args);
    });
    assert.equal(calls, 0, config);
    assert.ok(
      report.results.some(
        (run) => run.exitCode === 65 && run.cause === 'runner-config',
      ),
      config,
    );
    assert.equal(
      aggregatePanelVerdict([passedJudge], false, report),
      'INCOMPLETE',
    );
  }
});

test('symlinked runner config, imports and import parents are data errors on either side', async (t) => {
  for (const target of ['config', 'module', 'parent', 'head-module']) {
    const f = fixture(t);
    f.put('actual/gate.mjs', 'globalThis.approved = true;');
    const config = JSON.stringify({
      version: 1,
      testFile: { import: ['scripts/gate.mjs'] },
    });
    f.put('krn.review.json', config);
    f.put('scripts/gate.mjs', 'globalThis.approved = true;');
    if (target === 'config') {
      f.put('actual/config.json', config);
      rmSync(join(f.root, 'krn.review.json'));
      symlinkSync('actual/config.json', join(f.root, 'krn.review.json'));
    } else if (target === 'module') {
      rmSync(join(f.root, 'scripts/gate.mjs'));
      symlinkSync('../actual/gate.mjs', join(f.root, 'scripts/gate.mjs'));
    } else if (target === 'parent') {
      rmSync(join(f.root, 'scripts'), { recursive: true });
      symlinkSync('actual', join(f.root, 'scripts'));
    }
    const base = f.commit();
    f.put(testPath, passingTest);
    if (target === 'head-module') {
      rmSync(join(f.root, 'scripts/gate.mjs'));
      symlinkSync('../actual/gate.mjs', join(f.root, 'scripts/gate.mjs'));
    }
    const head = f.commit();
    const report = await review(f, base, head);
    assert.ok(
      report.results.some(
        (run) => run.exitCode === 65 && run.cause === 'runner-config',
      ),
      target,
    );
  }
});

test('ordinary skips and isolation summary skips are never passes', async (t) => {
  const f = fixture(t);
  f.put(
    testPath,
    "import { test } from 'node:test'; test('skipped', { skip: true }, () => {});",
  );
  const head = f.commit(
    `skip test\n\nChange-contract: ${testPath}:green->green`,
  );
  const report = await review(f, f.initial, head);
  assert.ok(report.results.every((run) => run.classification === 'skipped'));
  assert.equal(report.contracts?.[0]?.proven, false);
  assert.equal(
    aggregatePanelVerdict([passedJudge], false, report),
    'INCOMPLETE',
  );
  f.put(
    testPath,
    "import { test } from 'node:test'; test('summary', () => console.log('Isolation-dependent tests skipped: 1'));",
  );
  const summaryHead = f.commit();
  assert.equal(
    (await review(f, head, summaryHead)).results.at(-1)?.classification,
    'skipped',
  );
  assert.equal(
    classifyNodeTestOutput(0, 'Isolation-dependent tests skipped: 2'),
    'skipped',
  );
});

test('only unavailable isolation capabilities are a nonblocking unproven contract', async (t) => {
  const f = fixture(t);
  installGate(f);
  f.put(
    testPath,
    "import { test } from 'node:test'; import { requiresIsolation } from './helpers/isolation.ts'; test('requires user bus', (t) => { if (!requiresIsolation(t, 'requires user bus', ['systemdUserScope'])) return; throw new Error('bus should be unavailable'); });",
  );
  const base = f.commit();
  const head = f.commit(
    `verify isolation\n\nChange-contract: ${testPath}:red->green`,
  );
  const report = await review(f, base, head);
  const contract = report.contracts?.[0];
  assert.equal(contract?.red?.classification, 'skipped');
  assert.equal(contract?.green.classification, 'skipped');
  assert.equal(contract?.proven, false);
  assert.equal(contract?.cause, 'capability');
  assert.equal(aggregatePanelVerdict([passedJudge], false, report), 'PASS');
  assert.equal(
    aggregatePanelVerdict([{ ...passedJudge, verdict: 'FAIL' }], false, report),
    'FAIL',
  );
});

test('Node test timeouts and sandbox deadline exits are timeout failures', async (t) => {
  const f = fixture(t);
  f.put(
    testPath,
    "import { test } from 'node:test'; import { watch } from 'node:fs'; test('pending test', { timeout: 30 }, async (t) => { const watcher = watch(import.meta.filename); t.after(() => watcher.close()); await new Promise(() => {}); });",
  );
  const head = f.commit();
  const report = await review(f, f.initial, head);
  assert.equal(
    report.results.at(-1)?.classification,
    'timeout',
    JSON.stringify(report),
  );
  assert.equal(aggregatePanelVerdict([passedJudge], false, report), 'FAIL');
  assert.equal(classifyNodeTestOutput(124, ''), 'timeout');
});

test('parallel reviews of two heads use disjoint worktrees and helper names', async (t) => {
  const f = fixture(t);
  f.put(testPath, passingTest);
  const first = f.commit();
  f.put(testPath, `${passingTest}test('another test', () => {});\n`);
  const second = f.commit();
  const paths: string[][] = [[], []];
  const worktrees: string[][] = [[], []];
  const run =
    (index: number): typeof execute =>
    async (...args) => {
      paths[index]?.push(
        ...args[4].filter((arg) => arg.includes('.krn-redfirst-')),
      );
      worktrees[index]?.push(args[1]);
      return localExecute(...args);
    };
  const reports = await Promise.all([
    review(f, f.initial, first, run(0)),
    review(f, f.initial, second, run(1)),
  ]);
  assert.ok(
    reports.every((report) =>
      report.results.every((result) => result.classification === 'pass'),
    ),
  );
  assert.ok(paths[0]?.every((path) => !paths[1]?.includes(path)));
  assert.ok(worktrees[0]?.every((path) => !worktrees[1]?.includes(path)));
  assert.equal(
    git(f.root, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    1,
  );
});

test('deterministic verdicts survive record validation and prior-review verification', () => {
  const failed = {
    ...passedRun,
    classification: 'assertion' as const,
    exitCode: 1,
  };
  const contracts = [
    {
      commit: 'c'.repeat(40),
      path: failed.path,
      kind: 'green->green' as const,
      green: failed,
      proven: false,
    },
  ];
  const record = {
    schemaVersion: 1,
    headSha: passedRun.sha,
    base: 'd'.repeat(40),
    createdAt: new Date().toISOString(),
    panelVerdict: 'FAIL',
    redFirst: [failed],
    contracts,
    redFirstCauses: deterministicCauses([failed], contracts),
    judges: panelRoles.map((role) => ({
      ...passedJudge,
      role,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
    })),
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    lensSha256: 'a'.repeat(64),
    toolSha: 'b'.repeat(40),
  };
  for (const schema of [reviewRecordSchema, newReviewRecordSchema]) {
    assert.equal(schema.safeParse(record).success, true);
    assert.equal(
      schema.safeParse({ ...record, panelVerdict: 'PASS' }).success,
      false,
    );
    const prior = {
      headSha: 'e'.repeat(40),
      recordSha256: 'f'.repeat(64),
      findings: [],
      changedPaths: [],
    };
    assert.equal(
      schema.safeParse({
        ...record,
        prior,
        judges: record.judges.map((judge) => ({
          ...judge,
          prior: [],
          declaredVerdict: 'PASS',
        })),
      }).success,
      true,
    );
    const {
      contracts: _contracts,
      redFirstCauses: _causes,
      ...legacy
    } = record;
    assert.equal(
      schema.safeParse({ ...legacy, panelVerdict: 'PASS' }).success,
      true,
      'old records without contract evidence stay valid',
    );
  }
});

test('a procedural red side cannot prove a contract even when head passes', async (t) => {
  const f = fixture(t);
  f.put(testPath, valueTest);
  f.put('src/value.mjs', 'export const unrelated = 1;');
  const base = f.commit();
  f.put('src/value.mjs', 'export const value = 2;');
  const head = f.commit(
    `fix export\n\nChange-contract: ${testPath}:red->green`,
  );
  const report = await review(f, base, head);
  assert.equal(report.contracts?.[0]?.red?.classification, 'procedural');
  assert.equal(report.contracts?.[0]?.green.classification, 'pass');
  assert.equal(report.contracts?.[0]?.proven, false);
  assert.equal(
    aggregatePanelVerdict([passedJudge], false, report),
    'INCOMPLETE',
  );
});

test('ordinary skips cannot claim a capability exemption through an isolation-looking label', async (t) => {
  const f = fixture(t);
  f.put('approval.mjs', 'globalThis.approved = true;');
  f.put(
    'krn.review.json',
    JSON.stringify({ version: 1, testFile: { import: ['approval.mjs'] } }),
  );
  const base = f.commit();
  f.put(
    testPath,
    "import { test } from 'node:test'; test('ordinary skip', {skip: 'SKIP(isolation): unrelated reason'}, () => {});",
  );
  const head = f.commit();
  const report = await review(f, base, head);
  assert.equal(report.results.at(-1)?.classification, 'skipped');
  assert.equal(report.results.at(-1)?.cause, undefined);
  assert.equal(
    aggregatePanelVerdict([passedJudge], false, report),
    'INCOMPLETE',
  );
});

test('a corrected head config cannot repair an invalid base runner config', async (t) => {
  const f = fixture(t);
  f.put('krn.review.json', 'invalid JSON');
  const base = f.commit();
  f.put('krn.review.json', '{"version":1,"testFile":{"import":[]}}');
  f.put(testPath, passingTest);
  const head = f.commit();
  const report = await review(f, base, head);
  assert.equal(report.results[0]?.exitCode, 65);
  assert.equal(report.results[0]?.cause, 'runner-config');
});

test('a skip remains skipped on a nonzero run and record schemas reject forged capability evidence', () => {
  assert.equal(
    classifyNodeTestOutput(
      1,
      JSON.stringify({
        testFailure: true,
        errorCodes: ['ERR_ASSERTION'],
        causeCodes: [],
        skipped: 1,
      }),
    ),
    'skipped',
  );
  const record = {
    schemaVersion: 1,
    headSha: passedRun.sha,
    base: 'd'.repeat(40),
    createdAt: new Date().toISOString(),
    panelVerdict: 'PASS',
    contracts: [],
    redFirstCauses: [],
    redFirst: [
      {
        ...passedRun,
        classification: 'other',
        cause: 'capability',
        proven: false,
      },
    ],
    judges: panelRoles.map((role) => ({
      ...passedJudge,
      role,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
    })),
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    lensSha256: 'a'.repeat(64),
    toolSha: 'b'.repeat(40),
  };
  assert.equal(newReviewRecordSchema.safeParse(record).success, false);
});

test('prior records admit a deterministic FAIL and the next round checks its own head', async (t) => {
  const { loadPriorReview } = await import('../../src/flow/prior.ts');
  const f = fixture(t);
  const failingTest =
    "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('broken', () => assert.fail('broken'));";
  f.put(testPath, failingTest);
  const priorHead = f.commit();
  const priorEvidence = await review(f, f.initial, priorHead);
  const priorRecord = newReviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: priorHead,
    base: f.initial,
    createdAt: new Date().toISOString(),
    panelVerdict: aggregatePanelVerdict([passedJudge], false, priorEvidence),
    redFirst: priorEvidence.results,
    contracts: priorEvidence.contracts,
    redFirstCauses: deterministicCauses(
      priorEvidence.results,
      priorEvidence.contracts ?? [],
    ),
    judges: panelRoles.map((role) => ({
      ...passedJudge,
      role,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
    })),
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    lensSha256: 'a'.repeat(64),
    toolSha: f.initial,
  });
  const priorPath = join(f.root, '.krn', 'prior.json');
  writeFileSync(priorPath, JSON.stringify(priorRecord));
  f.put(testPath, passingTest);
  const fixedHead = f.commit();
  const prior = loadPriorReview(f.root, fixedHead, priorPath);
  assert.deepEqual(prior.findings, []);
  const fixed = await review(f, f.initial, fixedHead);
  assert.equal(aggregatePanelVerdict([passedJudge], false, fixed), 'PASS');
  f.put(testPath, `${failingTest}\n`);
  const brokenHead = f.commit();
  const stillPrior = loadPriorReview(f.root, brokenHead, priorPath);
  assert.equal(stillPrior.headSha, priorHead);
  const broken = await review(f, f.initial, brokenHead);
  assert.equal(broken.results.at(-1)?.sha, brokenHead);
  assert.equal(aggregatePanelVerdict([passedJudge], false, broken), 'FAIL');
});
