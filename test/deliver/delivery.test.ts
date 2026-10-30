import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
const messageApi = await import('../../src/deliver/message.ts').catch(
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
   let checks = raw('checks');
   if (resource.includes(config.merge)) checks = checks.replaceAll(config.head, config.merge);
   if (config.ciFailure) checks = checks.replaceAll('"success"','"failure"');
   process.stdout.write(checks);
 } else process.exit(64);
} else {
 if (args[0] === 'host-lock') {
   if (JSON.stringify(args) !== JSON.stringify(['host-lock','run','--name','gate','--','npm','run','gate:local'])) process.exit(64);
   if (config.gateFailure) {process.stderr.write('local gate failed\\n'); process.exit(19);}
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

function fixture(t: { after(fn: () => void): void }) {
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
  git(main, ['add', '.gitignore', '.node-version']);
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
    loadThreshold: 6,
    timeoutMs: 100,
    pollMs: 10,
  };
  const runtime = {
    cwd: worktree,
    run: runner,
    load: () => 0,
    ciBusy: () => false,
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
  let probes = 0;
  f.runtime.ciBusy = () => ++probes < 3;
  const result = await f.api.deliver(f.options, f.runtime);
  assert.equal(result.status, 'delivered');
  assert.equal(result.mainConclusion, 'success');
  assert.ok(probes >= 3);
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

test('dry-run validates without publishing, ready, gate, ship or persistent state', async (t) => {
  const f = fixture(t);
  const result = await f.api.deliver({ ...f.options, dryRun: true }, f.runtime);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.ship, 'ready');
  const ship = f.calls().find((call) => call.args[0] === 'ship');
  assert.ok(ship);
  const messageFile = ship.args[ship.args.indexOf('--message-file') + 1];
  assert.ok(messageFile);
  assert.equal(existsSync(messageFile), false);
  assert.equal(existsSync(dirname(messageFile)), false);
  assert.equal(existsSync(join(f.main, '.krn/tmp')), false);
  assert.equal(existsSync(join(f.main, '.krn/runs/deliver')), false);
});

test('dry-run reports pending judge refusal and cleans message file', async (t) => {
  const f = fixture(t);
  f.change({ dryRefusal: 'ship-pending-judges.stdout' });
  const result = await f.api.deliver({ ...f.options, dryRun: true }, f.runtime);
  assert.equal(
    result.ship,
    'pending: required judge krn/judge-standards is missing',
  );
  const ship = f.calls().find((call) => call.args[0] === 'ship');
  assert.ok(ship);
  const messageFile = ship.args[ship.args.indexOf('--message-file') + 1];
  assert.ok(messageFile);
  assert.equal(existsSync(messageFile), false);
  assert.equal(existsSync(dirname(messageFile)), false);
  assert.equal(existsSync(join(f.main, '.krn/tmp')), false);
  assert.equal(existsSync(join(f.main, '.krn/runs/deliver')), false);
});

test('dry-run fails a ship subject refusal at message and cleans message file', async (t) => {
  const f = fixture(t);
  assert.ok(transport);
  f.change({ dryRefusal: 'ship-subject-refusal.stdout' });
  await assert.rejects(
    f.api.deliver({ ...f.options, dryRun: true }, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'message');
      assert.match(error.message, /subject must be a Conventional Commit/u);
      assert.ok(error.cause instanceof transport.CommandFailure);
      assert.match(error.cause.stdoutTail ?? '', /"ok": false/u);
      return true;
    },
  );
  const ship = f.calls().find((call) => call.args[0] === 'ship');
  assert.ok(ship);
  const messageFile = ship.args[ship.args.indexOf('--message-file') + 1];
  assert.ok(messageFile);
  assert.equal(existsSync(messageFile), false);
  assert.equal(existsSync(dirname(messageFile)), false);
  assert.equal(existsSync(join(f.main, '.krn/tmp')), false);
  assert.equal(existsSync(join(f.main, '.krn/runs/deliver')), false);
});

// Reason text follows the receiver's checkRunsPassed format (ship.mjs) for a finished, failed run.
test('dry-run fails a completed failing check run instead of reporting it pending', async (t) => {
  const f = fixture(t);
  f.change({ dryRefusal: 'ship-failed-checks.stdout' });
  await assert.rejects(
    f.api.deliver({ ...f.options, dryRun: true }, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'message');
      assert.match(error.message, /conclusion failure/u);
      return true;
    },
  );
});

test('message file accepts only the generated PR subject and matching trailers', async (t) => {
  const f = fixture(t);
  assert.equal(typeof messageApi?.mergeMessage, 'function');
  assert.ok(messageApi);
  const commitMessage = spawnSync(
    'git',
    ['show', '-s', '--format=%B', 'HEAD'],
    {
      cwd: f.worktree,
      encoding: 'utf8',
    },
  );
  assert.equal(commitMessage.status, 0, commitMessage.stderr);
  const commits = f
    .git(f.worktree, [
      'rev-list',
      '--reverse',
      '--no-merges',
      `${f.config.base}..${f.config.head}`,
    ])
    .split('\n');
  const parsedTrailers = commits
    .map((commit) => {
      const body = spawnSync('git', ['show', '-s', '--format=%B', commit], {
        cwd: f.worktree,
        encoding: 'utf8',
      });
      assert.equal(body.status, 0, body.stderr);
      const parsed = spawnSync('git', ['interpret-trailers', '--parse'], {
        cwd: f.worktree,
        input: body.stdout,
        encoding: 'utf8',
      });
      assert.equal(parsed.status, 0, parsed.stderr);
      return parsed.stdout;
    })
    .join('\n');
  const generated = messageApi.mergeMessage(
    'feat(skills): encode the KRN lead loop as project skills (t-sbyye51)',
    parsedTrailers,
    138,
    't-sbyye51',
  );
  const supplied = join(f.root, 'message.txt');
  writeFileSync(supplied, generated.replace(' (#138)', ' (t-sbyye51)'));
  await assert.rejects(
    f.api.deliver(
      { ...f.options, messageFile: supplied, dryRun: true },
      f.runtime,
    ),
    /generated subject/u,
  );
  writeFileSync(supplied, generated);
  const result = await f.api.deliver(
    { ...f.options, messageFile: supplied, dryRun: true },
    f.runtime,
  );
  assert.equal(result.ship, 'ready');
  const headOnly = generated.replace(
    /\nChange-contract: test\/value\.test\.ts:red->green/u,
    '',
  );
  writeFileSync(supplied, headOnly);
  await assert.rejects(
    f.api.deliver(
      { ...f.options, messageFile: supplied, dryRun: true },
      f.runtime,
    ),
    /trailers from PR commits/u,
  );
});

test('delivery accepts contracts from an implementation commit before tracker close', async (t) => {
  const f = fixture(t);
  let result: Awaited<ReturnType<typeof f.api.deliver>> | undefined;
  await assert.doesNotReject(async () => {
    result = await f.api.deliver({ ...f.options, dryRun: true }, f.runtime);
  });
  assert.ok(result);
  assert.equal(result.status, 'dry-run');
  const ship = f.calls().find((call) => call.args[0] === 'ship');
  assert.ok(ship);
  assert.ok(ship.args.includes('--message-file'));
});

test('publishing honors exact status receiver fields and preserves permanent receiver failure', async (t) => {
  const f = fixture(t);
  f.change({ publish: true, statusFailure: true });
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.exitCode, 72);
      assert.ok(
        error.cause instanceof Error && 'commandExitCode' in error.cause,
      );
      assert.equal(error.cause.commandExitCode, 23);
      assert.equal(error.cause.message, 'HTTP 403: denied\n');
      return true;
    },
  );
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    1,
  );
  f.change({ statusFailure: false });
  assert.equal((await f.api.deliver(f.options, f.runtime)).status, 'delivered');
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    3,
  );
});

test('command failures retain receiver stdout reason and the first gate failure', () => {
  assert.equal(typeof transport?.CommandFailure, 'function');
  assert.ok(transport);
  const refusal = new transport.CommandFailure({
    code: 1,
    stdout: readFileSync(
      join(fixtures, 'ship-subject-refusal.stdout.fixture'),
      'utf8',
    ),
    stderr: '',
  });
  assert.match(refusal.message, /subject must be a Conventional Commit/u);
  assert.match(refusal.stdoutTail ?? '', /"ok": false/u);
  const gate = new transport.CommandFailure({
    code: 1,
    stdout: readFileSync(join(fixtures, 'gate-failure.fixture'), 'utf8'),
    stderr: '',
  });
  assert.equal(
    gate.firstFailingTest,
    'receiver fixture identifies the first failing test',
  );
});

for (const [patch, stage] of [
  [{ moved: true }, 'bind'],
  [{ ciFailure: true }, 'ci'],
  [{ ciPending: true }, 'ci'],
  [{ gateFailure: true }, 'gate'],
  [{ shipFailure: true }, 'ship'],
  [{ treeMismatch: true }, 'ship'],
] as const) {
  test(`delivery fails closed at ${stage} for ${Object.keys(patch)[0]}`, async (t) => {
    const f = fixture(t);
    f.change(patch);
    await assert.rejects(
      f.api.deliver(f.options, f.runtime),
      (error: unknown) => {
        assert.ok(error instanceof f.api.DeliveryFailure);
        assert.equal(error.stage, stage);
        return true;
      },
    );
    assert.equal(existsSync(f.worktree), true);
    if (stage === 'bind') assert.equal(f.calls().length, 1);
    if (stage === 'ci')
      assert.equal(f.calls().filter((call) => call.role === 'krn').length, 0);
  });
}

test('delivery recovers a merge interrupted before saving its result without shipping twice', async (t) => {
  const f = fixture(t);
  f.change({ crashAfterMerge: true });
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    /ship: interrupted after merge/u,
  );
  const result = await f.api.deliver(f.options, { ...f.runtime, cwd: f.main });
  assert.equal(result.status, 'delivered');
  assert.equal(f.calls().filter((call) => call.args[0] === 'ship').length, 2);
});

test('delivery refuses invalid review and merge contracts before publication', async (t) => {
  const f = fixture(t);
  writeFileSync(
    f.recordPath,
    JSON.stringify({ ...f.record, headSha: 'f'.repeat(40) }),
  );
  await assert.rejects(f.api.deliver(f.options, f.runtime), /bind:/u);
  assert.equal(f.calls().length, 1);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  await assert.rejects(
    f.api.deliver(f.options, {
      ...f.runtime,
      contracts: async () => {
        throw new Error('contract is green at base');
      },
    }),
    /message: contract/u,
  );
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    0,
  );
});

test('hygiene preserves an untracked file and resumes without a second local gate', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, 'owned.txt'), 'preserve');
  await assert.rejects(f.api.deliver(f.options, f.runtime), /hygiene:/u);
  assert.equal(readFileSync(join(f.worktree, 'owned.txt'), 'utf8'), 'preserve');
  rmSync(join(f.worktree, 'owned.txt'));
  assert.equal(
    (await f.api.deliver(f.options, { ...f.runtime, cwd: f.main })).status,
    'delivered',
  );
  assert.equal(
    f.calls().filter((call) => call.args[0] === 'host-lock').length,
    1,
  );
});

test('delivery publishes no status when the PR head moves after the first read', async (t) => {
  const f = fixture(t);
  f.change({ moveAfter: 1 });
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'bind');
      return true;
    },
  );
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    0,
  );
});

test('delivery rebinds immediately before each status POST', async (t) => {
  const f = fixture(t);
  f.change({ publish: true, moveAfter: 3 });
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'statuses');
      return true;
    },
  );
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    1,
  );
});

test('Node pin mismatch fails binding before status publication', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, '.node-version'), '0.0.0\n');
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'bind');
      assert.match(
        error.message,
        /Node .* on PATH differs from \.node-version 0\.0\.0/u,
      );
      return true;
    },
  );
  assert.equal(
    f.calls().filter((call) => call.args.includes('POST')).length,
    0,
  );
});

test('delivery refuses the local gate when the worktree moved during the wait', async (t) => {
  const f = fixture(t);
  let moved = false;
  f.runtime.ciBusy = () => {
    if (!moved) {
      moved = true;
      f.git(f.worktree, ['commit', '--quiet', '--allow-empty', '-m', 'moved']);
    }
    return false;
  };
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'gate');
      return true;
    },
  );
  assert.equal(
    f.calls().some((call) => call.args[0] === 'host-lock'),
    false,
  );
});

test('delivery does not accept a merged PR whose local gate never passed', async (t) => {
  const f = fixture(t);
  f.change({ gateFailure: true });
  await assert.rejects(f.api.deliver(f.options, f.runtime));
  f.change({ gateFailure: false, merged: true });
  await assert.rejects(
    f.api.deliver(f.options, f.runtime),
    (error: unknown) => {
      assert.ok(error instanceof f.api.DeliveryFailure);
      assert.equal(error.stage, 'ship');
      assert.match(error.message, /without the recorded local gate/u);
      return true;
    },
  );
});
