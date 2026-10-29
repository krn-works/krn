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
    'npm run check && npm run lint && npm run rules && node src/cli/main.ts task check && npm test -- test/workflow.test.ts test/import-boundary.test.ts',
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

test('CI workflow has one guarded gate job on the configured isolated runner', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const jobsIndex = lines.indexOf('jobs:');
  assert.notEqual(jobsIndex, -1, 'workflow must define jobs');

  const jobs: string[] = [];
  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\S/u.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/u);
    if (match) jobs.push(match[1] ?? '');
  }
  assert.deepEqual(jobs, ['gate']);

  const gateIndex = lines.indexOf('  gate:');
  assert.notEqual(gateIndex, -1, 'workflow must define the gate job');
  const gateLines: string[] = [];
  for (const line of lines.slice(gateIndex + 1)) {
    if (/^ {2}\S/u.test(line)) break;
    gateLines.push(line);
  }
  const scalar = (key: string): string | undefined => {
    const line = gateLines.find((candidate) =>
      candidate.startsWith(`    ${key}:`),
    );
    return line?.slice(line.indexOf(':') + 2);
  };

  assert.equal(scalar('name'), 'gate');
  assert.equal(
    scalar('if'),
    `\${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}`,
  );
  assert.equal(
    scalar('runs-on'),
    `\${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}`,
  );
});

test('CI workflow prepares any runner outside the isolated fleet for isolation tests after install and before the gate', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const fleet = `vars.CI_RUNNER || '"ubuntu-latest"'`;
  assert.ok(source.includes(`runs-on: \${{ fromJSON(${fleet}) }}`));
  const outsideFleet = `        if: \${{ !contains(${fleet}, 'krn-ci-isolated') }}`;
  const step = [
    '      - name: Set up mise outside the isolated fleet',
    outsideFleet,
    '        uses: jdx/mise-action@08ae2a091c038e1e05ec6f5115dc5c69d5a2a6b8 # v5.1.2',
    '        with:',
    '          version: 2026.10.17',
    '          install: false',
    '          cache: false',
    '',
    '      - name: Prepare isolation outside the isolated fleet',
    outsideFleet,
    '        env:',
    '          GITHUB_TOKEN: ${{ github.token }}',
    '        run: |',
    '          set -euo pipefail',
    '          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    `          manager="$(node -p "require('./package.json').packageManager")"`,
    '          mise install "$manager"',
  ].join('\n');
  const stepIndex = source.indexOf(step);
  assert.notEqual(
    stepIndex,
    -1,
    'workflow must define the guarded isolation step',
  );
  assert.equal(source.indexOf(step, stepIndex + 1), -1);
  assert.equal(source.match(/sysctl/gu)?.length, 1);
  const installIndex = source.indexOf(
    '        run: pnpm install --frozen-lockfile\n',
  );
  assert.ok(installIndex !== -1 && installIndex < stepIndex);
  const gateIndex = source.indexOf('        run: npm run gate\n');
  assert.ok(gateIndex > stepIndex, 'isolation step must run before the gate');
});

test('Product uses required exact-head CI for the full gate and a host-locked local isolation supplement', async () => {
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
    'npm run check && npm run lint && npm test && node src/cli/main.ts task check && npm run rules',
  );
  assert.match(
    await readFile(workflowPath, 'utf8'),
    /^ {8}run: npm run gate$/mu,
  );
  for (const path of [
    'README.md',
    'docs/program/repository-workflow.md',
    'docs/program/lead-rules.md',
    'docs/program/PLANS.md',
  ]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /required CI on the exact HEAD/u, path);
    assert.match(
      source,
      /krn host-lock run --name gate -- npm run gate:local/u,
      path,
    );
    assert.match(source, /preflight.*isolation/iu, path);
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
