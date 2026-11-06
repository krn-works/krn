import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);

test('cheap preflight reuses local observers and documents manual impact and PR budget boundaries', async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    typeof manifest === 'object' && manifest !== null && 'scripts' in manifest,
  );
  const scripts = manifest.scripts;
  assert.ok(
    typeof scripts === 'object' && scripts !== null && 'preflight' in scripts,
  );
  assert.equal(
    scripts.preflight,
    'npm run check && npm run lint && npm run rules && node scripts/head-trailers.mjs && node src/cli/main.ts task check && npm test -- test/workflow.test.ts test/import-boundary.test.ts test/rules',
  );
  for (const path of [
    'README.md',
    'docs/program/repository-workflow.md',
    'docs/program/lead-rules.md',
  ]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    for (const expected of [
      /npm run preflight/u,
      /[Mm]anually review test impact/u,
      /--pr/u,
      /--budget-exception/u,
      /[Dd]eterministic checks always block/u,
      /scripts\/pr-preflight\.mjs/u,
    ])
      assert.match(source, expected, path);
  }
});

function jobBlocks(source: string): Map<string, string> {
  const lines = source.split(/\r?\n/u);
  const jobsIndex = lines.indexOf('jobs:');
  assert.notEqual(jobsIndex, -1, 'workflow must define jobs');
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\S/u.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/u);
    if (match) {
      current = [];
      blocks.set(match[1] ?? '', current);
    } else current?.push(line);
  }
  return new Map([...blocks].map(([name, body]) => [name, body.join('\n')]));
}

test('CI workflow runs lint, typecheck and six test shards on hosted runners behind one aggregate Check', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const jobs = jobBlocks(source);
  assert.deepEqual(
    [...jobs.keys()],
    ['changes', 'lint', 'typecheck', 'test', 'check'],
  );
  for (const [name, body] of jobs) {
    assert.match(body, /^ {4}runs-on: ubuntu-24\.04$/mu, name);
    assert.match(body, /^ {4}timeout-minutes: \d+$/mu, name);
  }
  assert.doesNotMatch(source, /krn-ci-isolated|vars\.CI_RUNNER/u);

  const test = jobs.get('test') ?? '';
  assert.match(test, /^ {8}shard: \[1, 2, 3, 4, 5, 6\]$/mu);
  assert.match(test, /^ {10}KRN_REQUIRE_ZERO_ISOLATION_SKIPS: '1'$/mu);
  assert.match(test, /^ {6}KRN_TEST_SHARD_INDEX: \$\{\{ matrix\.shard \}\}$/mu);
  assert.match(test, /^ {6}KRN_TEST_SHARD_TOTAL: '6'$/mu);
  assert.match(test, /^ {8}run: npm test$/mu);
  assert.match(test, /^ {10}go: 'true'$/mu);
  assert.match(jobs.get('lint') ?? '', /run: npm run lint$/mu);
  assert.match(jobs.get('lint') ?? '', /run: npm run rules$/mu);
  assert.match(
    jobs.get('lint') ?? '',
    /run: node src\/cli\/main\.ts task check$/mu,
  );
  assert.match(jobs.get('typecheck') ?? '', /run: npm run check$/mu);

  // A rename must not hide its deleted source path from the task-only filter.
  assert.match(
    jobs.get('changes') ?? '',
    /git diff --name-only --no-renames "\$BASE\.\.\.\$HEAD"/u,
  );
  const check = jobs.get('check') ?? '';
  assert.match(check, /^ {4}name: Check$/mu);
  assert.match(check, /^ {4}if: \$\{\{ always\(\) \}\}$/mu);
  for (const need of ['changes', 'lint', 'typecheck', 'test'])
    assert.match(check, new RegExp(`^ {6}- ${need}$`, 'mu'), need);
  assert.match(
    check,
    /name === "test" && result === "skipped" && needs\.changes\?\.outputs\?\.test === "false"/u,
  );
  assert.match(check, /result !== "success" && !skipOk/u);
});

test('CI test shards pin Go and enable user namespaces after install and before the shard runs', async () => {
  const action = await readFile(
    new URL('../.github/actions/setup-ci/action.yml', import.meta.url),
    'utf8',
  );
  const goIndex = action.indexOf('uses: actions/setup-go@');
  const installIndex = action.indexOf('run: pnpm install --frozen-lockfile');
  const sysctlIndex = action.indexOf(
    'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  );
  assert.ok(installIndex !== -1 && installIndex < goIndex);
  assert.ok(goIndex < sysctlIndex);
  assert.equal(action.match(/sysctl/gu)?.length, 1);
  assert.match(action, /infra\/ci\/mise\.toml/u);
  assert.match(action, /uses: actions\/cache@/u);
  const toml = await readFile(
    new URL('../infra/ci/mise.toml', import.meta.url),
    'utf8',
  );
  assert.match(toml, /^go = "\d+\.\d+\.\d+"$/mu);

  const source = await readFile(workflowPath, 'utf8');
  const jobs = jobBlocks(source);
  const test = jobs.get('test') ?? '';
  assert.ok(
    test.indexOf('uses: ./.github/actions/setup-ci') <
      test.indexOf('run: npm test'),
    'setup must precede the shard run',
  );
  assert.match(test, /mise install "\$manager"/u);
  const adr = await readFile(
    new URL(
      '../docs/adr/0014-operator-decisions-2026-10-23.md',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    adr,
    /^\*\*D21 amendment \(operator 2026-10-29\):\*\*.*GitHub-hosted.*`CI_RUNNER`.*fallback/mu,
  );
});

test('Product uses required exact-head Actions Check and optional local diagnostics', async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    typeof manifest === 'object' && manifest !== null && 'scripts' in manifest,
  );
  const scripts = manifest.scripts;
  assert.ok(
    typeof scripts === 'object' && scripts !== null && 'gate' in scripts,
  );
  assert.equal(
    scripts.gate,
    'npm run check && npm run lint && KRN_TEST_OUTPUT=failures npm test && node src/cli/main.ts task check && npm run rules',
  );
  const workflow = await readFile(workflowPath, 'utf8');
  for (const step of [
    /run: npm run lint$/mu,
    /run: npm run check$/mu,
    /run: npm test$/mu,
    /run: node src\/cli\/main\.ts task check$/mu,
    /run: npm run rules$/mu,
  ])
    assert.match(workflow, step);
  for (const path of [
    'README.md',
    'docs/program/repository-workflow.md',
    'docs/program/lead-rules.md',
    'docs/program/PLANS.md',
    '.agents/skills/krn-lead/SKILL.md',
  ]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /required CI on the exact HEAD/u, path);
    assert.match(source, /optional local diagnostics/u, path);
    assert.match(source, /`Check` \(App `15368`/u, path);
    assert.match(source, /npm run preflight/u, path);
    assert.doesNotMatch(
      source,
      /after review the lead runs .*gate:local/iu,
      path,
    );
    assert.doesNotMatch(
      source,
      /CI runs the same steps|runs the full local gate/u,
      path,
    );
  }
  const adr = await readFile(
    new URL(
      '../docs/adr/0014-operator-decisions-2026-10-23.md',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    adr,
    /^\*\*D30 amendment.*Tak, opcja 1 — zmiana D30.*optional local diagnostics/mu,
  );
  assert.match(adr, /Tak, zgoda na ten zakres rulesetu/u);
  assert.match(
    adr,
    /^\*\*D30 Actions amendment.*`Check`.*App ID `15368`.*t-sdcdxb2/mu,
  );
  const agents = await readFile(
    new URL('../AGENTS.md', import.meta.url),
    'utf8',
  );
  assert.match(
    agents,
    /KRN-07.*MUST.*`Check` from GitHub Actions \(App `15368`\).*gate: npm run gate/u,
  );
  assert.doesNotMatch(agents, /KRN-07.*MUST pass `npm run gate:local`/u);
  assert.match(adr, /^\| D30 \|.*D11.*Product/mu);
  assert.match(adr, /Tak, zmień D11 \(Recommended\)/u);
  assert.match(
    adr,
    /pełną bramką jest wymagane CI na dokładnym HEAD, a lokalnie tylko tani preflight \+ testy izolacji systemd pod host-lock \(bez pełnego gate:local po review\)/u,
  );
});

test('CI workflow cancels superseded pull request runs but preserves main runs', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const concurrencyIndexes = lines.flatMap((line, index) =>
    line === 'concurrency:' ? [index] : [],
  );
  const jobsIndex = lines.indexOf('jobs:');

  assert.deepEqual(
    concurrencyIndexes.length,
    1,
    'workflow must define one top-level concurrency block',
  );
  assert.notEqual(jobsIndex, -1, 'workflow must define jobs');
  const concurrencyIndex = concurrencyIndexes[0];
  assert.ok(concurrencyIndex !== undefined && concurrencyIndex < jobsIndex);

  const entries = lines
    .slice(concurrencyIndex + 1, jobsIndex)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^ {2}([a-z-]+): (.+)$/u);
      assert.ok(match, `unexpected top-level concurrency entry: ${line}`);
      return [match[1], match[2]];
    });

  assert.deepEqual(entries, [
    ['group', 'ci-${{ github.ref }}'],
    ['cancel-in-progress', "${{ github.ref != 'refs/heads/main' }}"],
  ]);

  const cancelExpression = entries[1]?.[1];
  const match = cancelExpression?.match(
    /^\$\{\{\s*github\.ref\s*!=\s*'([^']+)'\s*\}\}$/u,
  );
  assert.ok(
    match,
    'cancel-in-progress must compare github.ref with a protected ref',
  );
  const shouldCancel = (ref: string): boolean => ref !== match[1];

  assert.equal(shouldCancel('refs/heads/main'), false);
  assert.equal(shouldCancel('refs/pull/42/merge'), true);
});
