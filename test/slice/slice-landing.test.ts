import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

type Run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

interface SliceOptions {
  readonly task: string;
  readonly brief: string;
  readonly message: string;
  readonly name: string;
  readonly repo: string;
  readonly model: string;
  readonly effort: string;
  readonly worker?: 'codex' | 'none';
  readonly stopAfter?: string;
  readonly override?: boolean;
  readonly reason?: string;
  readonly evidence?: string;
}

type RunSlice = (
  options: SliceOptions,
  runtime: {
    readonly root: string;
    readonly krn: string;
    readonly run: Run;
    readonly detach?: (
      command: string,
      args: readonly string[],
      options: { cwd: string; log: string },
    ) => Promise<void> | void;
    readonly sleep?: (ms: number) => Promise<void>;
  },
) => Promise<{
  readonly exitCode: number;
  readonly stage: string;
  readonly cause: string;
  readonly details?: readonly string[];
}>;

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TASK = 't-test123';

interface Call {
  readonly line: string;
  readonly words: readonly string[];
  readonly cwd: string;
  readonly message?: string;
}

async function loadRunSlice(): Promise<RunSlice> {
  let imported: unknown;
  try {
    imported = await import('../../src/slice/run.ts');
  } catch {
    imported = undefined;
  }
  const runSlice =
    typeof imported === 'object' && imported !== null
      ? (imported as { runSlice?: unknown }).runSlice
      : undefined;
  assert.equal(
    typeof runSlice,
    'function',
    'src/slice/run.ts must export runSlice',
  );
  return runSlice as RunSlice;
}

// Strips `mise exec node@<v> --` and names any bin/krn launcher `krn`.
function normalize(command: string, args: readonly string[]): string[] {
  let words = [command, ...args];
  if (basename(command) === 'mise') {
    const separator = args.indexOf('--');
    words = args.slice(separator + 1);
  }
  const [first = '', ...rest] = words;
  const name =
    first.endsWith('/bin/krn') || first === 'krn' ? 'krn' : basename(first);
  return [name, ...rest];
}

function valueAfter(
  words: readonly string[],
  flag: string,
): string | undefined {
  const index = words.indexOf(flag);
  return index < 0 ? undefined : words[index + 1];
}

function recordPath(root: string, attempt: number): string {
  return join(
    root,
    '.krn',
    'runs',
    'review-series',
    'f'.repeat(64),
    'records',
    `${attempt}.json`,
  );
}

// Output shapes are verbatim captures of the real commands on 2026-11-04:
// `krn brief check` (PASS line + shell-quoted argv line), `krn review`
// (last stdout line is a JSON object with `record`), `krn deliver`.
function stub(
  root: string,
  script: {
    readonly worker?: number;
    readonly reviews?: readonly number[];
    readonly reviewRefusal?: boolean;
    readonly recordBody?: string;
    readonly prs?: string;
    readonly crashAt?: string;
    readonly base?: string;
    readonly rebased?: boolean;
    readonly head?: string;
    /** `gh pr view` answers the base SHA for this many polls before the head. */
    readonly headLag?: number;
  },
): { readonly run: Run; readonly calls: Call[] } {
  const calls: Call[] = [];
  let reviews = 0;
  let views = 0;
  const worktree = join(root, '.krn', 'worktrees', 'slice-run');
  const subject = join(root, '.stub-last-subject');
  const run: Run = async (command, args, options) => {
    const result = await perform(command, args, options);
    const line = normalize(command, args).join(' ');
    if (script.crashAt !== undefined && line.startsWith(script.crashAt)) {
      throw new Error('simulated crash after the side effect');
    }
    return result;
  };
  const perform: Run = async (command, args, options) => {
    const words = normalize(command, args);
    const line = words.join(' ');
    let message: string | undefined;
    if (line.startsWith('git commit')) {
      const file = valueAfter(words, '-F') ?? valueAfter(words, '--file');
      message =
        file === undefined
          ? words
              .flatMap((word, index) =>
                words[index - 1] === '-m' ? [word] : [],
              )
              .join('\n\n')
          : await readFile(join(options.cwd, file), 'utf8').catch(() =>
              readFile(file, 'utf8'),
            );
    }
    if (message !== undefined) {
      await writeFile(subject, `${message.split('\n')[0] ?? ''}\n`);
    }
    calls.push({
      line,
      words,
      cwd: options.cwd,
      ...(message === undefined ? {} : { message }),
    });
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (line.startsWith('git ls-remote'))
      return ok(`${script.base ?? BASE}\trefs/heads/main\n`);
    if (line.startsWith('git merge-base --is-ancestor')) {
      return { code: script.rebased === false ? 1 : 0, stdout: '', stderr: '' };
    }
    if (line.startsWith('git worktree add')) {
      for (const word of words) {
        if (word.startsWith(join(root, '.krn', 'worktrees')))
          await mkdir(word, { recursive: true });
      }
      return ok('');
    }
    if (line.startsWith('git rev-parse')) return ok(`${script.head ?? HEAD}\n`);
    if (line.startsWith('git worktree list')) {
      const exists = await stat(worktree).then(
        () => true,
        () => false,
      );
      return ok(
        exists
          ? `worktree ${root}\nHEAD ${BASE}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD ${BASE}\nbranch refs/heads/feat/slice-run\n\n`
          : `worktree ${root}\nHEAD ${BASE}\nbranch refs/heads/main\n\n`,
      );
    }
    if (line.startsWith('git log')) {
      return ok(await readFile(subject, 'utf8').catch(() => ''));
    }
    if (line.startsWith('krn task claim')) {
      await mkdir(join(root, '.krn', 'task-claims'), { recursive: true });
      await writeFile(
        join(root, '.krn', 'task-claims', `${TASK}.json`),
        `${JSON.stringify({ id: TASK, actor: 'lead', worktree, branch: 'feat/slice-run' })}\n`,
      );
      return ok(`${TASK}\n`);
    }
    if (line.startsWith('krn task close')) {
      await mkdir(join(worktree, 'tasks'), { recursive: true });
      await writeFile(
        join(worktree, 'tasks', `${TASK}.json`),
        `${JSON.stringify({ id: TASK, status: 'closed' })}\n`,
      );
      return ok(`${TASK}\n`);
    }
    if (line.startsWith('git status'))
      return ok(' M src/a.ts\n?? test/a.test.ts\n');
    if (line.startsWith('krn brief check')) {
      return ok(
        `PASS ${valueAfter(words, 'check') ?? ''}\nargv: --allow 'src/a.ts' --allow 'test/a.test.ts' --observer 'test/a.test.ts'\n`,
      );
    }
    if (line.startsWith('krn brief lens')) return ok('# Lens\n\nSettled.\n');
    if (line.startsWith('krn worker start')) {
      const code = script.worker ?? 0;
      return {
        code,
        stdout:
          code === 0
            ? 'status: done\n'
            : 'status: partial\nblocker: step 2 unfinished\n',
        stderr: '',
      };
    }
    if (line.startsWith('krn verify')) return ok(`overall PASS head=${HEAD}\n`);
    if (line.startsWith('gh pr list')) return ok(script.prs ?? '[]\n');
    if (line.startsWith('gh pr view')) {
      views += 1;
      return ok(
        `${views <= (script.headLag ?? 0) ? BASE : (script.head ?? HEAD)}\n`,
      );
    }
    if (line.startsWith('gh pr create'))
      return ok('https://github.com/o/r/pull/7\n');
    if (line.startsWith('krn review') && words.includes('--override')) {
      // Verbatim shape of `krn review --override` stdout (src/flow/cli.ts): no record path.
      return ok(
        `${JSON.stringify({ headSha: valueAfter(words, '--head'), override: { reason: valueAfter(words, '--reason'), evidence: valueAfter(words, '--evidence'), appendedAt: '2026-11-04T00:00:00.000Z' } })}\n`,
      );
    }
    if (line.startsWith('krn review')) {
      if (script.reviewRefusal === true) {
        return { code: 64, stdout: '', stderr: 'review: missing --lens\n' };
      }
      reviews += 1;
      const code = script.reviews?.[reviews - 1] ?? 0;
      const prior = valueAfter(words, '--prior-record');
      const attempt = prior ? Number(basename(prior, '.json')) + 1 : reviews;
      const record = recordPath(root, attempt);
      const verdict = code === 0 ? 'PASS' : 'FAIL';
      if (script.recordBody !== undefined) {
        await mkdir(join(record, '..'), { recursive: true });
        await writeFile(record, script.recordBody);
      }
      return {
        code,
        stdout: `${JSON.stringify({ headSha: HEAD, panelVerdict: verdict, record })}\n`,
        stderr: '',
      };
    }
    if (line.startsWith('krn deliver')) return ok(`delivered: ${HEAD}\n`);
    return ok('');
  };
  return { run, calls };
}

async function fixture(
  t: test.TestContext,
): Promise<{ root: string; options: SliceOptions; krn: string }> {
  const root = await mkdtemp(join(tmpdir(), 'krn-slice-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.node-version'), '24.11.0\n');
  await mkdir(join(root, '.krn', 'runs', 'lead', 'slice-run'), {
    recursive: true,
  });
  const brief = join(root, '.krn', 'runs', 'lead', 'slice-run', 'brief.md');
  const message = join(root, '.krn', 'runs', 'lead', 'slice-run', 'message.md');
  await writeFile(brief, '# Brief\n');
  await writeFile(
    message,
    `feat(slice): drive one slice end to end (${TASK})\n\nThe runner chains the stages.\n`,
  );
  return {
    root,
    krn: join(root, 'bin', 'krn'),
    options: {
      task: TASK,
      brief,
      message,
      name: 'slice-run',
      repo: 'o/r',
      model: 'gpt-6.1-sol',
      effort: 'high',
    },
  };
}

async function journal(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      join(root, '.krn', 'runs', 'slice', TASK, 'journal.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

function count(calls: readonly Call[], prefix: string): number {
  return calls.filter((call) => call.line.startsWith(prefix)).length;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('gate and review overlap; merge waits for both and landing detaches', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const receiver = stub(root, {});
  const review = deferred(),
    gate = deferred(),
    entered = deferred();
  const calls: string[][] = [];
  let detached = false;
  const pending = runSlice(options, {
    root,
    krn,
    run: async (command, args, opts) => {
      const words = normalize(command, args);
      calls.push(words);
      if (words[1] === 'ci' && words[2] === 'wait') {
        assert.equal(valueAfter(words, '--head'), HEAD);
        assert.equal(valueAfter(words, '--base'), BASE);
        await gate.promise;
        return { code: 0, stdout: `gate: success ${HEAD}\n`, stderr: '' };
      }
      if (words[1] === 'review') {
        entered.resolve();
        await review.promise;
      }
      if (words[1] === 'deliver')
        return { code: 0, stdout: `merged: ${HEAD}\n`, stderr: '' };
      return receiver.run(command, args, opts);
    },
    detach: (command, args, opts) => {
      const words = normalize(command, args);
      assert.equal(words[1], 'deliver');
      assert.ok(!words.includes('--merge-only'));
      assert.equal(valueAfter(words, '--record'), recordPath(root, 1));
      assert.equal(
        opts.log,
        join(root, '.krn/runs/slice', TASK, 'landing.log'),
      );
      detached = true;
      // Resolves once the process started; the detached deliver never completes here.
      return Promise.resolve();
    },
  });
  await entered.promise;
  assert.ok(
    calls.some((w) => w[1] === 'ci'),
    'gate started while review is open',
  );
  assert.ok(!calls.some((w) => w[1] === 'deliver'));
  review.resolve();
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(!calls.some((w) => w[1] === 'deliver'));
  gate.resolve();
  const result = await pending;
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(result.stage, 'done');
  assert.ok(detached);
  const deliver = calls.find((w) => w[1] === 'deliver') ?? [];
  assert.ok(deliver.includes('--merge-only'));
  assert.equal(valueAfter(deliver, '--pr'), '7');
  assert.equal(valueAfter(deliver, '--record'), recordPath(root, 1));
  assert.match(result.cause, /^merged:/);
  const runtime = { root, krn, run: receiver.run };
  assert.equal((await runSlice(options, runtime)).cause, 'landing: running');
  await writeFile(join(root, '.krn/runs/slice', TASK, 'landing.exit'), '74\n');
  const failed = await runSlice(options, runtime);
  assert.equal(failed.exitCode, 74);
  assert.match(failed.cause, /^landing: failed exit 74, log /);
  await writeFile(join(root, '.krn/runs/slice', TASK, 'landing.exit'), 'oops');
  assert.match((await runSlice(options, runtime)).cause, /failed exit unknown/);
});

test('gate failure preserves PASS and resumes without another review', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const receiver = stub(root, {});
  let code = 74;
  const gateLine = `gate concluded failure; ${'cause '.repeat(45)}rerun: krn ci rerun --pr 7 --head ${HEAD}`;
  const runtime = {
    root,
    krn,
    detach: () => {},
    run: async (
      command: string,
      args: readonly string[],
      opts: { cwd: string },
    ) => {
      if (normalize(command, args).slice(0, 3).join(' ') === 'krn ci wait')
        return {
          code,
          stdout: '',
          stderr: `${gateLine}\n`,
        };
      return receiver.run(command, args, opts);
    },
  };
  const failed = await runSlice(options, runtime);
  assert.equal(failed.exitCode, 74);
  assert.equal(failed.stage, 'gate');
  assert.equal(failed.cause, gateLine);
  const cli = await import('../../src/slice/cli.ts');
  assert.ok(cli.failureText(failed).includes(gateLine));
  assert.equal(count(receiver.calls, 'krn deliver'), 0);
  assert.equal((await journal(root)).reviewHead, HEAD);
  code = 0;
  const result = await runSlice(options, runtime);
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(count(receiver.calls, 'krn review'), 1);
  assert.equal(count(receiver.calls, 'krn deliver'), 1);
});

test('landing files refuse symlinks without touching their target', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const runSlice = await loadRunSlice();
  for (const filename of ['landing.log', 'landing.exit']) {
    const { root, options, krn } = await fixture(t);
    const receiver = stub(root, {});
    const runtime = {
      root,
      krn,
      run: receiver.run,
      detach: () => assert.fail('unsafe detach'),
    };
    assert.equal(
      (await runSlice({ ...options, stopAfter: 'review' }, runtime)).exitCode,
      0,
    );
    const target = join(root, 'target');
    await writeFile(target, 'untouched');
    await symlink(target, join(root, '.krn/runs/slice', TASK, filename));
    const failed = await runSlice(options, runtime);
    assert.notEqual(failed.exitCode, 0);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  }
});

test('default detach captures real receiver output and publishes its exit after completion', async (t) => {
  const api = await import('../../src/slice/cli.ts');
  assert.equal(typeof api.detach, 'function');
  const { root } = await fixture(t);
  const log = join(root, 'landing.log');
  api.detach('/bin/sh', ['-c', 'printf receiver-output; exit 74'], {
    cwd: root,
    log,
  });
  const deadline = Date.now() + 5000;
  let exit: string | undefined;
  while (exit === undefined && Date.now() < deadline) {
    exit = await readFile(join(root, 'landing.exit'), 'utf8').catch(
      () => undefined,
    );
    if (exit === undefined)
      await new Promise<void>((done) => setTimeout(done, 10));
  }
  assert.equal(exit, '74\n');
  assert.equal(await readFile(log, 'utf8'), 'receiver-output');
});

test('crash before detach resumes merge-only and preserves the reviewed record', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const receiver = stub(root, {});
  const crashed = await runSlice(options, {
    root,
    krn,
    run: receiver.run,
    detach: () => {
      throw new Error('interrupted before detach');
    },
  });
  assert.equal(crashed.stage, 'deliver');
  assert.notEqual(crashed.exitCode, 0);
  const resumed = await runSlice(options, {
    root,
    krn,
    run: receiver.run,
    detach: () => {},
  });
  assert.equal(resumed.exitCode, 0, resumed.cause);
  assert.equal(count(receiver.calls, 'krn review'), 1);
  const deliveries = receiver.calls.filter(
    (call) => call.words[1] === 'deliver',
  );
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every((call) => call.words.includes('--merge-only')));
  assert.ok(
    deliveries.every(
      (call) => valueAfter(call.words, '--record') === recordPath(root, 1),
    ),
  );
  await writeFile(join(root, '.krn/runs/slice', TASK, 'landing.exit'), '0\n');
  assert.equal(
    (await runSlice(options, { root, krn, run: receiver.run })).cause,
    'landing: delivered',
  );
});
// Review of the first landing head: a detached start failure was swallowed,
// and a crash after the detach but before the journal save started a second
// landing deliver on the rerun.

test('a landing start failure fails the deliver stage and a rerun starts it once', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const receiver = stub(root, {});
  const failed = await runSlice(options, {
    root,
    krn,
    run: receiver.run,
    detach: () => Promise.reject(new Error('spawn /bin/sh ENOENT')),
  });
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.stage, 'deliver');
  assert.match(failed.cause, /landing/);
  const state = await journal(root);
  assert.equal(state.completed, false);
  assert.equal(state.landing, undefined);
  let started = 0;
  const resumed = await runSlice(options, {
    root,
    krn,
    run: receiver.run,
    detach: async () => {
      started += 1;
    },
  });
  assert.equal(resumed.exitCode, 0, resumed.cause);
  assert.equal(started, 1);
});

test('a landing recorded before a crash is never started twice', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const receiver = stub(root, {});
  let started = 0;
  const runtime = {
    root,
    krn,
    run: receiver.run,
    detach: async () => {
      started += 1;
    },
  };
  assert.equal((await runSlice(options, runtime)).exitCode, 0);
  assert.equal(started, 1);
  const path = join(root, '.krn', 'runs', 'slice', TASK, 'journal.json');
  const crashed = await journal(root);
  assert.ok(crashed.landing, 'landing is recorded');
  await writeFile(
    path,
    `${JSON.stringify({ ...crashed, stage: 'deliver', completed: false })}\n`,
  );
  const deliveries = count(receiver.calls, 'krn deliver');
  const resumed = await runSlice(options, runtime);
  assert.equal(resumed.exitCode, 0, resumed.cause);
  assert.equal(started, 1);
  assert.equal(count(receiver.calls, 'krn deliver'), deliveries);
  assert.equal((await journal(root)).completed, true);
});

test('default detach rejects when the landing process cannot start', async (t) => {
  const api = await import('../../src/slice/cli.ts');
  assert.equal(typeof api.detach, 'function');
  const { root } = await fixture(t);
  const started = api.detach('/bin/sh', ['-c', 'true'], {
    cwd: join(root, 'missing'),
    log: join(root, 'landing.log'),
  });
  assert.ok(started instanceof Promise, 'detach returns a promise');
  await assert.rejects(started);
});
