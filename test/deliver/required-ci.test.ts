import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reserveReviewAttempt } from '../../src/flow/series.ts';

const api = await import('../../src/deliver/delivery.ts').catch(
  () => undefined,
);
const transport = await import('../../src/deliver/transport.ts').catch(
  () => undefined,
);
const source = fileURLToPath(new URL('../..', import.meta.url));
// Captured output is verbatim except host paths normalized to /repository.
// Git object IDs are rebound to the private repository only when replayed.
const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const receiver = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const configPath = process.argv[2];
const role = process.argv[3];
const args = process.argv.slice(4);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const save = () => fs.writeFileSync(configPath, JSON.stringify(config));
fs.appendFileSync(config.log, JSON.stringify({ role, args, cwd: process.cwd() }) + '\\n');
const raw = name => fs.readFileSync(path.join(config.fixtures, name + '.fixture'), 'utf8').replace(/\\b[a-f0-9]{40}\\b/g, sha => config.shas[sha] ?? sha);
if (role === 'gh') {
 if (args.includes('ready')) { config.draft = false; save(); process.exit(0); }
 const resource = args.find(a => a.startsWith('repos/')) || '';
 if (resource.includes('/pulls/')) {
   const pull = JSON.parse(raw('pull'));
   if (!config.capturePull) Object.assign(pull, {merged: !!config.merged, draft: !!config.draft, state: config.merged ? 'closed' : 'open', merge_commit_sha: config.merged ? pull.merge_commit_sha : null});
   if (config.currentBase) pull.base.sha = config.currentBase;
   config.pullReads = (config.pullReads || 0) + 1; save();
 if (config.moved || (config.moveAfter !== undefined && config.pullReads > config.moveAfter)) pull.head.sha = 'e'.repeat(40);
   process.stdout.write(config.capturePull ? raw('pull') : JSON.stringify(pull));
 } else if (resource.includes('/statuses?')) process.stdout.write(config.publish ? '[[]]' : raw('statuses'));
 else if (resource.includes('/statuses/')) {
   const fields = Object.fromEntries(args.filter((a, i) => args[i - 1] === '-f').map(a => [a.slice(0,a.indexOf('=')),a.slice(a.indexOf('=')+1)]));
   if (!/^krn\\/judge-(standards|spec)$/.test(fields.context) || fields.state !== 'success' || !/sha256 [a-f0-9]{8}/.test(fields.description) || fields.description.length > 140 || /[\\r\\n]/.test(fields.description)) process.exit(64);
   if (config.statusFailure) { process.stderr.write('HTTP 403: denied\\n'); process.exit(23); }
   process.stdout.write('{}');
 } else if (resource.includes('/check-runs?')) {
   if (config.ciPending) { process.stdout.write('[{"check_runs":[]}]'); process.exit(0); }
   let checks = config.checkRuns ? JSON.stringify([{check_runs: config.checkRuns}]) : raw('checks');
   if (resource.includes(config.merge)) checks = checks.replaceAll(config.head, config.merge);
   if (config.ciFailure || (config.mainCiFailure && resource.includes(config.merge))) checks = checks.replaceAll('"success"','"failure"');
   process.stdout.write(checks);
 } else process.exit(64);
} else {
 if (args[0] === 'host-lock') {
   process.stderr.write('obsolete local gate call'); process.exit(64);
 } else if (args[0] === 'ship') {
   if (process.cwd() !== config.main) { process.stderr.write('deleted cwd hazard\\n'); process.exit(64); }
   if (args.includes('--dry-run') && config.dryRefusal) { process.stdout.write(raw(config.dryRefusal)); process.exit(1); }
   if (config.shipFailure) {process.stderr.write('ship refused\\n'); process.exit(29);}
   if (args.includes('--dry-run')) process.stdout.write(raw('ship-dry-run'));
   else {
     config.merged = true; save();
     const output = raw('ship-result');
     const dir = path.join(config.main, '.krn/runs/ship'); fs.mkdirSync(dir,{recursive:true});
     fs.writeFileSync(path.join(dir,'pr-138.json'), output);
     if (config.crashAfterMerge) { process.stderr.write('interrupted after merge\\n'); process.exit(31); }
     process.stdout.write(config.treeMismatch ? output.replace('"treeMatch": true','"treeMatch": false') : output);
   }
 } else process.exit(64);
}
`;

function fixture(t: { after(fn: () => void): void }, pinnedApp = false) {
  assert.equal(typeof api?.deliver, 'function');
  assert.equal(typeof transport?.run, 'function');
  assert.ok(api && transport);
  const root = mkdtempSync(join(tmpdir(), 'krn-delivery-receiver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const worktree = join(root, 'delivery');
  const rawPull = JSON.parse(
    readFileSync(join(fixtures, 'pull.fixture'), 'utf8'),
  );
  const shipped = JSON.parse(
    readFileSync(join(fixtures, 'ship-result.fixture'), 'utf8'),
  );
  const dryRun = JSON.parse(
    readFileSync(join(fixtures, 'ship-dry-run.fixture'), 'utf8'),
  );
  const reviewBytes = readFileSync(
    join(source, 'test/flow/fixtures/review-record-v1.fixture'),
    'utf8',
  );
  const review = JSON.parse(reviewBytes);
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(root, ['init', '--quiet', '--initial-branch=main', main]);
  git(main, ['config', 'user.name', 'Fixture']);
  git(main, ['config', 'user.email', 'fixture@example.com']);
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  // Pin the Node that delivery will find on PATH, as a real repository does.
  const pathNode = spawnSync('node', ['--version'], { encoding: 'utf8' });
  writeFileSync(join(main, '.node-version'), pathNode.stdout);
  if (pinnedApp) {
    mkdirSync(join(main, 'spec'));
    writeFileSync(
      join(main, 'spec/ci-admission.json'),
      JSON.stringify({
        schemaVersion: 1,
        checkRunName: 'krn/gate',
        appId: 5548482,
      }),
    );
  }
  git(main, ['add', '.']);
  git(main, ['commit', '--quiet', '-m', 'chore: fixture base']);
  const base = git(main, ['rev-parse', 'HEAD']);
  git(main, ['checkout', '--quiet', '-b', rawPull.head.ref]);
  writeFileSync(join(main, 'value.txt'), 'PR head\n');
  git(main, ['add', 'value.txt']);
  git(main, [
    'commit',
    '--quiet',
    '-m',
    'feat: fixture head\n\nTicket: t-sbyye51\nChange-contract: test/value.test.ts:red->green',
  ]);
  writeFileSync(join(main, 'value.txt'), 'PR head refined\n');
  git(main, ['add', 'value.txt']);
  git(main, [
    'commit',
    '--quiet',
    '-m',
    'fix: refine fixture implementation\n\nTicket: t-sbyye51\nChange-contract: test/value.test.ts:red->green',
  ]);
  git(main, [
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'chore: close tracked task\n\nTicket: t-sbyye51',
  ]);
  const head = git(main, ['rev-parse', 'HEAD']);
  git(main, ['checkout', '--quiet', 'main']);
  git(main, ['merge', '--quiet', '--no-ff', '-m', 'Merge fixture PR', head]);
  const merge = git(main, ['rev-parse', 'HEAD']);
  const tree = git(main, ['rev-parse', 'HEAD^{tree}']);
  git(main, ['update-ref', 'refs/remotes/origin/main', merge]);
  git(main, ['reset', '--quiet', '--hard', base]);
  git(main, ['worktree', 'add', '--quiet', worktree, rawPull.head.ref]);
  const shas: Record<string, string> = {
    [shipped.base]: base,
    [shipped.head]: head,
    [shipped.merge]: merge,
    [shipped.precheckedMerge]: merge,
    [dryRun.precheckedMerge]: merge,
    [shipped.precheckedTree]: tree,
    [review.base]: base,
    [review.headSha]: head,
    [review.toolSha]: base,
  };
  const remap = (bytes: string) =>
    bytes.replace(/\b[a-f0-9]{40}\b/gu, (sha) => shas[sha] ?? sha);
  const attempt = reserveReviewAttempt(
    main,
    {
      schemaVersion: 1,
      repository: rawPull.base.repo.full_name,
      pr: 138,
      baseRef: rawPull.base.ref,
    },
    base,
    head,
  );
  const record = {
    ...JSON.parse(remap(reviewBytes)),
    headSha: head,
    base,
    toolSha: base,
    redFirst: [],
    contracts: [],
    redFirstCauses: [],
    attempt,
  };
  const recordPath = join(root, 'review.json');
  writeFileSync(recordPath, JSON.stringify(record));
  const configPath = join(root, 'receiver.json');
  const script = join(root, 'receiver.cjs');
  writeFileSync(script, receiver);
  const config = {
    log: join(root, 'calls.jsonl'),
    main,
    head,
    base,
    merge,
    fixtures,
    shas,
    merged: false,
    draft: true,
    publish: false,
    ...(pinnedApp
      ? {
          checkRuns: [
            {
              id: 1,
              name: 'krn/gate',
              head_sha: head,
              status: 'completed',
              conclusion: 'success',
              app: { id: 5548482 },
            },
          ],
        }
      : {}),
  };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(config.log, '');
  const change = (patch: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        ...patch,
      }),
    );
  const calls = () =>
    readFileSync(config.log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { role: string; args: string[]; cwd: string },
      );
  const runner: NonNullable<
    import('../../src/deliver/delivery.ts').DeliveryRuntime['run']
  > = (command, args, cwd, input) => {
    if (command === 'gh' || command === 'krn')
      return transport.run(
        process.execPath,
        [script, configPath, command, ...args],
        cwd,
        input,
      );
    if (command === 'git' && args[0] === 'fetch')
      return { code: 0, stdout: '', stderr: '' };
    return transport.run(command, args, cwd, input);
  };
  let clock = 0;
  const options = {
    repo: rawPull.base.repo.full_name as string,
    pr: 138,
    record: recordPath,
    task: 't-sbyye51',
    dryRun: false,
    timeoutMs: 100,
    pollMs: 10,
  };
  const runtime = {
    cwd: worktree,
    run: runner,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    contracts: async () => {},
  };
  return {
    root,
    main,
    worktree,
    record,
    recordPath,
    config,
    change,
    calls,
    options,
    runtime,
    git,
    api,
    key: createHash('sha256')
      .update(`${options.repo}\0${options.pr}`)
      .digest('hex'),
  };
}

test('delivery replays captured statuses and ship output, retires once and resumes from main', async (t) => {
  const f = fixture(t);
  const runtime = {
    ...f.runtime,
    ciBusy: () => {
      assert.fail('delivery must not probe host CI load');
    },
    load: () => {
      assert.fail('delivery must not probe host load');
    },
  };
  let result: Awaited<ReturnType<typeof f.api.deliver>> | undefined;
  await assert.doesNotReject(async () => {
    result = await f.api.deliver(
      { ...f.options, loadThreshold: Number.MIN_VALUE },
      runtime,
    );
  });
  assert.ok(result);
  assert.equal(result.status, 'delivered');
  assert.equal(result.mainConclusion, 'success');
  assert.equal(
    f.calls().some((call) => call.args[0] === 'host-lock'),
    false,
  );
  assert.equal(existsSync(f.worktree), false);
  assert.equal(existsSync(join(f.main, '.krn/runs/deliver', f.key)), false);
  assert.equal(f.git(f.main, ['rev-parse', 'HEAD']), f.config.merge);
  assert.ok(existsSync(join(f.main, '.krn/archive', `review-series-${f.key}`)));
  const calls = f.calls();
  assert.equal(
    calls.filter((call) => call.role === 'gh' && call.args.includes('POST'))
      .length,
    0,
  );
  const ships = calls.filter((call) => call.args[0] === 'ship');
  assert.equal(ships.length, 2);
  assert.equal(ships[0]?.args.includes('--dry-run'), true);
  assert.ok(ships.every((call) => call.cwd === f.main));
  f.change({ capturePull: true });
  await assert.rejects(
    f.api.deliver(f.options, { ...f.runtime, cwd: f.main }),
    /merged PR requires a saved delivery binding/u,
  );
  assert.equal(f.calls().filter((call) => call.args[0] === 'ship').length, 2);
});

for (const merged of [false, true]) {
  for (const producer of ['App', 'Actions'] as const) {
    test(`delivery binds ${merged ? 'merged recovery to recorded' : 'open PR to current'} base policy with ${producer} CI`, async (t) => {
      const f = fixture(t, true);
      f.change(
        merged
          ? { crashAfterMerge: true }
          : { publish: true, statusFailure: true },
      );
      await assert.rejects(
        f.api.deliver(f.options, f.runtime),
        merged ? /ship:/u : /statuses:/u,
      );
      const statePath = join(f.main, '.krn/runs/deliver', f.key, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.base, f.config.base);
      state.gate = false;
      writeFileSync(statePath, JSON.stringify(state));
      if (merged) f.git(f.main, ['merge', '--ff-only', f.config.merge]);
      f.git(f.main, ['rm', 'spec/ci-admission.json']);
      f.git(f.main, [
        'commit',
        '--quiet',
        '-m',
        'chore: retire fixture App policy',
      ]);
      const currentBase = f.git(f.main, ['rev-parse', 'HEAD']);
      assert.notEqual(currentBase, state.base);
      f.git(f.main, ['merge-base', '--is-ancestor', state.base, currentBase]);
      f.change({
        currentBase,
        shipFailure: !merged,
        crashAfterMerge: false,
        publish: false,
        statusFailure: false,
        checkRuns: [
          {
            id: 1,
            name: producer === 'App' ? 'krn/gate' : 'gate',
            head_sha: f.config.head,
            status: 'completed',
            conclusion: 'success',
            app:
              producer === 'App'
                ? { id: 5548482 }
                : { id: 15368, slug: 'github-actions' },
          },
        ],
      });
      const before = f.calls().length;
      if (!merged && producer === 'Actions') {
        await assert.rejects(
          f.api.deliver(f.options, f.runtime),
          /ship: ship refused/u,
        );
        assert.ok(
          f
            .calls()
            .slice(before)
            .some((call) => call.args[0] === 'ship'),
        );
      } else if (merged && producer === 'App') {
        let result: Awaited<ReturnType<typeof f.api.deliver>> | undefined;
        await assert.doesNotReject(async () => {
          result = await f.api.deliver(f.options, f.runtime);
        });
        assert.ok(result);
        assert.equal(result.status, 'delivered');
        assert.equal(result.head, f.config.head);
        assert.equal(result.mainConclusion, 'success');
      } else {
        await assert.rejects(
          f.api.deliver(f.options, f.runtime),
          (error: unknown) => {
            assert.ok(error instanceof f.api.DeliveryFailure);
            assert.equal(error.stage, 'ci');
            assert.equal(error.exitCode, transport?.exitCodes.ci);
            assert.match(
              error.message,
              merged
                ? /bounded wait timed out/u
                : /base selects legacy GitHub Actions/u,
            );
            return true;
          },
        );
        assert.ok(existsSync(statePath));
        assert.ok(existsSync(f.worktree));
        assert.ok(existsSync(join(f.main, '.krn/runs/review-series', f.key)));
        assert.equal(
          f
            .calls()
            .slice(before)
            .some(
              (call) => call.args[0] === 'ship' || call.args.includes('ready'),
            ),
          false,
        );
      }
      assert.ok(
        f
          .calls()
          .slice(before)
          .some((call) =>
            call.args.some((arg) =>
              arg.includes(`/commits/${f.config.head}/check-runs?`),
            ),
          ),
      );
      if (merged)
        assert.equal(
          f.calls().filter((call) => call.args[0] === 'ship').length,
          2,
        );
    });
  }
}
