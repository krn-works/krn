import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);

test('the retired preflight script stays gone and gate owns the rendered rules', async () => {
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
  assert.ok(!('preflight' in scripts));
  assert.match(String(scripts.gate), /npm run rules/u);
  const leadRules = await readFile(
    new URL('../docs/program/lead-rules.md', import.meta.url),
    'utf8',
  );
  assert.match(leadRules, /npm run fast/u);
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

test('CI workflow runs lint, typecheck and twelve test shards on hosted runners behind one aggregate Check', async () => {
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
  assert.match(
    test,
    /^ {8}shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13\]$/mu,
  );
  assert.match(test, /^ {10}KRN_TEST_STRICT: '1'$/mu);
  assert.match(test, /^ {6}KRN_TEST_SHARD_INDEX: \$\{\{ matrix\.shard \}\}$/mu);
  assert.match(test, /^ {6}KRN_TEST_SHARD_TOTAL: '13'$/mu);
  assert.match(test, /^ {8}run: npm test$/mu);
  const lint = jobs.get('lint') ?? '';
  assert.match(lint, /run: npm run lint$/mu);
  // Rendered rules belong to the local gate.
  assert.doesNotMatch(lint, /npm run rules/u);
  // A pull request may not carry `Ticket: <id>` while that task stays open.
  assert.match(lint, /^ {10}fetch-depth: 0$/mu);
  assert.match(
    lint,
    /^ {10}BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/mu,
  );
  assert.match(
    lint,
    /^ {10}HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/mu,
  );
  assert.match(
    lint,
    /^ {12}node src\/cli\/main\.ts task check --base "\$BASE" --head "\$HEAD"$/mu,
  );
  assert.match(
    jobs.get('changes') ?? '',
    /node scripts\/ci-changes\.mjs "\$listing" \| tee -a "\$GITHUB_OUTPUT"/u,
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
});

// Extracts the literal `run: |` block of the Check job's aggregator step.
function checkAggregatorScript(check: string): string {
  const lines = check.split('\n');
  const start = lines.findIndex((line) => /^ {8}run: \|$/u.test(line));
  assert.notEqual(start, -1, 'Check job must have a run block');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

type Job = { result: string; outputs?: Record<string, string> };
const ok: Job = { result: 'success', outputs: { test: 'true' } };
const needsCases: ReadonlyArray<{
  name: string;
  needs: Record<string, Job>;
  exit: 0 | 1;
}> = [
  {
    name: 'all success',
    needs: { changes: ok, lint: ok, typecheck: ok, test: ok },
    exit: 0,
  },
  {
    name: 'test skipped by the change filter',
    needs: {
      changes: { result: 'success', outputs: { test: 'false' } },
      lint: ok,
      typecheck: ok,
      test: { result: 'skipped' },
    },
    exit: 0,
  },
  {
    name: 'test skipped while the filter said run',
    needs: {
      changes: ok,
      lint: ok,
      typecheck: ok,
      test: { result: 'skipped' },
    },
    exit: 1,
  },
  {
    name: 'lint failure',
    needs: {
      changes: ok,
      lint: { result: 'failure' },
      typecheck: ok,
      test: ok,
    },
    exit: 1,
  },
  {
    name: 'changes failure',
    needs: {
      changes: { result: 'failure' },
      lint: ok,
      typecheck: ok,
      test: { result: 'skipped' },
    },
    exit: 1,
  },
  {
    name: 'typecheck cancelled',
    needs: {
      changes: ok,
      lint: ok,
      typecheck: { result: 'cancelled' },
      test: ok,
    },
    exit: 1,
  },
  {
    name: 'changes outputs missing while test skipped',
    needs: {
      changes: { result: 'success' },
      lint: ok,
      typecheck: ok,
      test: { result: 'skipped' },
    },
    exit: 1,
  },
];

function aggregatorMisses(script: string): string[] {
  return needsCases
    .filter(({ needs, exit }) => {
      const run = spawnSync('bash', ['-c', script], {
        env: { ...process.env, RESULTS: JSON.stringify(needs) },
        encoding: 'utf8',
      });
      return run.status !== exit;
    })
    .map(({ name }) => name);
}

test('Check aggregator step passes only green or filter-skipped needs', async () => {
  const check = jobBlocks(await readFile(workflowPath, 'utf8')).get('check');
  const script = checkAggregatorScript(check ?? '');
  assert.deepEqual(aggregatorMisses(script), []);
  for (const [from, to] of [
    ['process.exit(bad ? 1 : 0)', 'process.exit(0)'],
    ['bad += 1', 'bad += 0'],
    ['Object.entries(needs)', 'Object.entries({})'],
  ] as const) {
    const mutant = script.replace(from, to);
    assert.notEqual(mutant, script, from);
    assert.notDeepEqual(aggregatorMisses(mutant), [], `mutant: ${to}`);
  }
});

test('CI test shards enable user namespaces after install and before the shard runs', async () => {
  const action = await readFile(
    new URL('../.github/actions/setup-ci/action.yml', import.meta.url),
    'utf8',
  );
  const installIndex = action.indexOf('run: pnpm install --frozen-lockfile');
  const sysctlIndex = action.indexOf(
    'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  );
  assert.ok(installIndex !== -1 && installIndex < sysctlIndex);
  assert.equal(action.match(/sysctl/gu)?.length, 1);
  assert.doesNotMatch(action, /setup-go|infra\/ci/u);
  assert.match(action, /uses: actions\/cache@/u);
  // setup-node reuses RUNNER_TOOL_CACHE, so the pinned toolchain restores
  // there before setup-node runs instead of downloading on every shard.
  const nodeCacheIndex = action.indexOf(
    'path: ${{ runner.tool_cache }}/node/${{ steps.node-version.outputs.version }}',
  );
  assert.ok(
    nodeCacheIndex !== -1 &&
      nodeCacheIndex < action.indexOf('uses: actions/setup-node@'),
    'the pinned Node.js toolchain is restored before setup-node',
  );

  const source = await readFile(workflowPath, 'utf8');
  const jobs = jobBlocks(source);
  const test = jobs.get('test') ?? '';
  assert.ok(
    test.indexOf('uses: ./.github/actions/setup-ci') <
      test.indexOf('run: npm test'),
    'setup must precede the shard run',
  );
  // A github.com release outage (main run 42468167813) failed every shard in
  // the mise download; the shards take the pnpm store from setup-ci instead.
  assert.doesNotMatch(
    test,
    /mise/u,
    'test shards download nothing from GitHub releases',
  );
  assert.match(
    action,
    /echo "pnpm_config_store_dir=\$store" >> "\$GITHUB_ENV"/u,
    'setup-ci hands the pnpm store to the test suite',
  );
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
  ])
    assert.match(workflow, step);
  const owners = ['README.md', 'docs/program/lead-rules.md'];
  for (const path of [...owners, 'docs/program/repository-workflow.md']) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    if (owners.includes(path)) {
      assert.match(source, /required CI on the exact HEAD/u, path);
      assert.match(source, /`Check`.*App `15368`/u, path);
    } else {
      assert.doesNotMatch(
        source,
        /App `15368`/u,
        `${path} points to the owner`,
      );
    }
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

test('shared project CI pins its actions and ends in one aggregate Check that the self-test proves red and green', async () => {
  const shared = await readFile(
    new URL('../.github/workflows/project-ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(shared, /^ {2}workflow_call:$/mu);
  for (const use of shared.matchAll(/^ +(?:- )?uses: (\S+)/gmu))
    assert.match(use[1] ?? '', /@[0-9a-f]{40}$/u, use[1]);
  const jobs = jobBlocks(shared);
  assert.deepEqual(
    [...jobs.keys()],
    ['plan', 'lint', 'typecheck', 'test', 'check'],
  );
  assert.match(jobs.get('check') ?? '', /^ {4}name: Check$/mu);
  assert.match(jobs.get('check') ?? '', /^ {4}if: \$\{\{ always\(\) \}\}$/mu);

  const selftest = await readFile(
    new URL('../.github/workflows/project-ci-selftest.yml', import.meta.url),
    'utf8',
  );
  assert.match(selftest, /test "\$GREEN" = success && test "\$RED" = failure/u);
});
