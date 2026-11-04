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
}

type RunSlice = (
  options: SliceOptions,
  runtime: { readonly root: string; readonly krn: string; readonly run: Run },
) => Promise<{
  readonly exitCode: number;
  readonly stage: string;
  readonly cause: string;
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
    readonly prs?: string;
    readonly crashAt?: string;
    readonly base?: string;
    readonly rebased?: boolean;
  },
): { readonly run: Run; readonly calls: Call[] } {
  const calls: Call[] = [];
  let reviews = 0;
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
    if (line.startsWith('git rev-parse')) return ok(`${HEAD}\n`);
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
    if (line.startsWith('gh pr create'))
      return ok('https://github.com/o/r/pull/7\n');
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

function index(calls: readonly Call[], prefix: string): number {
  return calls.findIndex((call) => call.line.startsWith(prefix));
}

function only(calls: readonly Call[], prefix: string): Call {
  const found = calls.filter((call) => call.line.startsWith(prefix));
  assert.equal(found.length, 1, `exactly one call starting with ${prefix}`);
  return found[0] as Call;
}

test('a fresh run drives every stage to deliver and writes the journal', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const { run, calls } = stub(root, {});
  const result = await runSlice(options, { root, krn, run });
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(result.stage, 'done');

  const worktree = join(root, '.krn', 'worktrees', 'slice-run');
  const add = only(calls, 'git worktree add');
  assert.ok(
    add.words.includes(worktree),
    'worktree under .krn/worktrees/<name>',
  );
  assert.ok(add.words.includes('feat/slice-run'), 'branch <type>/<name>');
  assert.ok(
    add.words.includes(BASE),
    'worktree starts at the authoritative base',
  );
  assert.equal(
    calls.filter((call) => call.line.includes('pnpm install --frozen-lockfile'))
      .length,
    1,
  );

  const claim = only(calls, 'krn task claim');
  assert.equal(valueAfter(claim.words, '--worktree'), worktree);
  assert.equal(valueAfter(claim.words, '--actor'), 'lead');

  const worker = only(calls, 'krn worker start');
  assert.equal(valueAfter(worker.words, '--repo'), worktree);
  assert.equal(valueAfter(worker.words, '--brief'), options.brief);
  assert.equal(valueAfter(worker.words, '--model'), 'gpt-6.1-sol');
  assert.equal(valueAfter(worker.words, '--effort'), 'high');
  assert.ok(
    worker.line.includes(
      '--allow src/a.ts --allow test/a.test.ts --observer test/a.test.ts',
    ),
    worker.line,
  );

  const commits = calls.filter((call) => call.line.startsWith('git commit'));
  assert.equal(commits.length, 2, 'implementation commit and close commit');
  const [implementation, close] = commits as [Call, Call];
  assert.ok(
    implementation.message?.startsWith(
      `feat(slice): drive one slice end to end (${TASK})\n`,
    ),
  );
  assert.match(
    implementation.message ?? '',
    /\n\nTicket: t-test123\nChange-contract: test\/a\.test\.ts:red->green\n?/,
  );
  assert.match(close.message ?? '', /Ticket: t-test123/);
  assert.doesNotMatch(close.message ?? '', /Change-contract/);
  assert.ok(calls.indexOf(implementation) < index(calls, 'krn task close'));
  assert.ok(index(calls, 'krn task close') < calls.indexOf(close));

  const verify = calls.find((call) =>
    call.line.startsWith('krn verify'),
  ) as Call;
  assert.equal(valueAfter(verify.words, '--base'), BASE);
  assert.equal(valueAfter(verify.words, '--observer'), 'test/a.test.ts');

  const pr = only(calls, 'gh pr create');
  assert.ok(pr.words.includes('--draft'));
  assert.equal(
    valueAfter(pr.words, '--title'),
    `feat(slice): drive one slice end to end (${TASK})`,
  );

  const review = only(calls, 'krn review');
  assert.equal(
    review.cwd,
    root,
    'the trusted base reviewer runs from the main checkout',
  );
  assert.equal(valueAfter(review.words, '--repo'), worktree);
  assert.equal(valueAfter(review.words, '--pr'), '7');
  assert.equal(valueAfter(review.words, '--base'), BASE);
  assert.equal(valueAfter(review.words, '--head'), HEAD);
  assert.ok(review.words.includes('--prepass'));
  assert.equal(
    valueAfter(review.words, '--checklist'),
    join(worktree, 'docs', 'program', 'hardening-checklist.md'),
  );
  assert.ok(valueAfter(review.words, '--lens'), 'lens file passed');
  assert.ok(!review.words.includes('--prior-record'));

  const deliver = only(calls, 'krn deliver');
  assert.equal(valueAfter(deliver.words, '--repo'), 'o/r');
  assert.equal(valueAfter(deliver.words, '--pr'), '7');
  assert.equal(valueAfter(deliver.words, '--record'), recordPath(root, 1));
  assert.equal(valueAfter(deliver.words, '--task'), TASK);

  const order = [
    'git worktree add',
    'krn task claim',
    'krn brief check',
    'krn worker start',
    'krn verify',
    'gh pr create',
    'krn review',
    'krn deliver',
  ];
  const positions = order.map((prefix) => index(calls, prefix));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    `stage order ${positions.join(',')}`,
  );

  const state = await journal(root);
  assert.equal(state.task, TASK);
  assert.equal(state.branch, 'feat/slice-run');
  assert.equal(state.worktree, worktree);
  assert.equal(state.base, BASE);
  assert.equal(state.brief, options.brief);
  assert.equal(state.pr, 7);
  assert.equal(state.stage, 'done');
  assert.equal(state.reviewAttempts, 1);
  assert.equal(state.reviewRecord, recordPath(root, 1));
});

test('a rerun after a review FAIL resumes at review and never starts a third attempt', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);

  const first = stub(root, { reviews: [1] });
  const failed = await runSlice(options, { root, krn, run: first.run });
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.stage, 'review');
  assert.ok(
    failed.cause.length > 0 && !/[\r\n]/.test(failed.cause),
    'one-line cause',
  );
  assert.equal(count(first.calls, 'krn deliver'), 0);
  let state = await journal(root);
  assert.equal(state.stage, 'review');
  assert.equal(state.reviewAttempts, 1);
  assert.equal(state.reviewRecord, recordPath(root, 1));

  const second = stub(root, { reviews: [1] });
  const again = await runSlice(options, { root, krn, run: second.run });
  assert.notEqual(again.exitCode, 0);
  assert.equal(again.stage, 'review');
  for (const prefix of [
    'krn task claim',
    'git worktree add',
    'krn worker start',
    'gh pr create',
    'krn deliver',
  ]) {
    assert.equal(
      count(second.calls, prefix),
      0,
      `rerun must not repeat ${prefix}`,
    );
  }
  const review = only(second.calls, 'krn review');
  assert.equal(valueAfter(review.words, '--prior-record'), recordPath(root, 1));
  state = await journal(root);
  assert.equal(state.reviewAttempts, 2);

  const third = stub(root, {});
  const refused = await runSlice(options, { root, krn, run: third.run });
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.stage, 'review');
  assert.match(refused.cause, /budget|attempt/i);
  assert.equal(count(third.calls, 'krn review'), 0, 'no third review attempt');
  assert.equal(count(third.calls, 'krn deliver'), 0);
});

test('a second review PASS after a FAIL delivers its own record', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(options, { root, krn, run: stub(root, { reviews: [1] }).run });
  const second = stub(root, { reviews: [0] });
  const result = await runSlice(options, { root, krn, run: second.run });
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(result.stage, 'done');
  assert.equal(
    valueAfter(only(second.calls, 'krn deliver').words, '--record'),
    recordPath(root, 2),
  );
});

test('a partial worker stops at the worker stage and a rerun does not start it again', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const first = stub(root, { worker: 4 });
  const result = await runSlice(options, { root, krn, run: first.run });
  assert.equal(result.exitCode, 4);
  assert.equal(result.stage, 'worker');
  assert.ok(
    result.cause.length > 0 && !/[\r\n]/.test(result.cause),
    'one-line cause',
  );
  assert.equal(count(first.calls, 'krn verify'), 0);
  assert.equal((await journal(root)).stage, 'worker');

  const second = stub(root, {});
  const again = await runSlice(options, { root, krn, run: second.run });
  assert.notEqual(again.exitCode, 0);
  assert.equal(again.stage, 'worker');
  assert.equal(count(second.calls, 'krn worker start'), 0);
  assert.equal(count(second.calls, 'krn task claim'), 0);
});

test('stop-after claim, then a rerun without a worker delivers the lead edits', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const first = stub(root, {});
  const stopped = await runSlice(
    { ...options, stopAfter: 'claim' },
    { root, krn, run: first.run },
  );
  assert.equal(stopped.exitCode, 0, stopped.cause);
  assert.equal(stopped.stage, 'claim');
  assert.equal(count(first.calls, 'krn brief check'), 0);

  const second = stub(root, {});
  const result = await runSlice(
    { ...options, worker: 'none' },
    { root, krn, run: second.run },
  );
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(result.stage, 'done');
  assert.equal(count(second.calls, 'krn task claim'), 0);
  assert.equal(count(second.calls, 'git worktree add'), 0);
  assert.equal(count(second.calls, 'krn worker start'), 0);
  assert.equal(count(second.calls, 'krn deliver'), 1);
});

test('a message title without the task suffix is refused before any command', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await writeFile(options.message, 'feat(slice): drive one slice end to end\n');
  const { run, calls } = stub(root, {});
  const result = await runSlice(options, { root, krn, run });
  assert.equal(result.exitCode, 64);
  assert.equal(calls.length, 0);
});

test('journal rejects corrupt data and mismatched identity without commands', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(
    { ...options, stopAfter: 'claim' },
    { root, krn, run: stub(root, {}).run },
  );
  const path = join(root, '.krn', 'runs', 'slice', TASK, 'journal.json');
  const saved = await readFile(path, 'utf8');
  for (const contents of [
    '{',
    '{}',
    saved.replace('"slice-run"', '"other-name"'),
  ]) {
    await writeFile(path, contents);
    const receiver = stub(root, {});
    const result = await runSlice(options, { root, krn, run: receiver.run });
    assert.equal(result.exitCode, 65);
    assert.equal(receiver.calls.length, 0);
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('journal refuses symlink directory and file', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const directory = join(root, '.krn', 'runs', 'slice', TASK);
  await mkdir(join(root, '.krn', 'runs', 'slice'), { recursive: true });
  const target = join(root, 'target');
  await mkdir(target);
  await symlink(target, directory);
  const receiver = stub(root, {});
  assert.equal(
    (await runSlice(options, { root, krn, run: receiver.run })).exitCode,
    65,
  );
  await rm(directory);
  await mkdir(directory);
  const targetFile = join(target, 'journal.json');
  await writeFile(targetFile, '{}');
  await symlink(targetFile, join(directory, 'journal.json'));
  assert.equal(
    (await runSlice(options, { root, krn, run: receiver.run })).exitCode,
    65,
  );
  assert.equal(receiver.calls.length, 0);
  assert.equal(await readFile(targetFile, 'utf8'), '{}');
});

test('argv grammar accepts CRLF and escaped apostrophes and refuses unsafe forms', async () => {
  await loadRunSlice();
  const { parseArgv, oneLine } = await import('../../src/slice/stages.ts');
  assert.deepEqual(
    parseArgv(
      "PASS\r\nargv: --allow 'src/it'\\''s.ts' --observer 'test/a.ts'\r\n",
    ),
    ['--allow', "src/it's.ts", '--observer', 'test/a.ts'],
  );
  for (const words of [
    '--observer "test/a.ts"',
    '--observer $HOME',
    "--observer '$HOME'",
    `--observer 'a"b'`,
    "--observer 'a'\\x",
    "--observer 'unterminated",
    Array.from({ length: 33 }, () => "--observer 'a'").join(' '),
  ])
    assert.throws(() => parseArgv(`argv: ${words}\r\n`));
  assert.equal(oneLine('a\u0000\u200bb\u2028tail'), 'ab');
  assert.equal(oneLine('a'.repeat(250)).length, 200);
});

test('command failures preserve exit codes and bounded one-line causes', async (t) => {
  const runSlice = await loadRunSlice();
  for (const [prefix, code] of [
    ['krn verify', 75],
    ['krn deliver', 77],
    ['krn worker start', 3],
  ] as const) {
    const { root, options, krn } = await fixture(t);
    const receiver = stub(root, {});
    const run: Run = async (command, args, cwd) => {
      if (normalize(command, args).join(' ').startsWith(prefix))
        return {
          code,
          stdout: '',
          stderr: 'cause\u0000\u200b\u2029hidden\nsecond',
        };
      return receiver.run(command, args, cwd);
    };
    const result = await runSlice(options, { root, krn, run });
    assert.equal(result.exitCode, code);
    assert.equal(result.cause, 'cause');
    assert.equal((await journal(root)).exitCode, code);
  }
});

test('failed worker can be completed manually and successful stages are not repeated', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(options, { root, krn, run: stub(root, { worker: 4 }).run });
  const receiver = stub(root, {});
  const result = await runSlice(
    { ...options, worker: 'none' },
    { root, krn, run: receiver.run },
  );
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(count(receiver.calls, 'krn worker start'), 0);
  assert.equal(count(receiver.calls, 'krn task claim'), 0);
  const done = stub(root, {});
  assert.equal(
    (await runSlice(options, { root, krn, run: done.run })).stage,
    'done',
  );
  assert.equal(done.calls.length, 0);
});

test('an effort the worker refuses is refused before any command', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const { run, calls } = stub(root, {});
  const result = await runSlice(
    { ...options, effort: 'max' },
    { root, krn, run },
  );
  assert.equal(result.exitCode, 64);
  assert.equal(calls.length, 0);
});

test('a review refused before an attempt is reserved does not spend the budget', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const refused = await runSlice(options, {
    root,
    krn,
    run: stub(root, { reviewRefusal: true }).run,
  });
  assert.equal(refused.exitCode, 64);
  assert.equal(refused.stage, 'review');
  assert.equal((await journal(root)).reviewAttempts, 0);
  const second = stub(root, {});
  const result = await runSlice(options, { root, krn, run: second.run });
  assert.equal(result.exitCode, 0, result.cause);
  assert.ok(!only(second.calls, 'krn review').words.includes('--prior-record'));
});

test('an existing PR for the branch is adopted instead of created', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const { run, calls } = stub(root, { prs: '[{"number":9}]\n' });
  const result = await runSlice(options, { root, krn, run });
  assert.equal(result.exitCode, 0, result.cause);
  assert.equal(count(calls, 'gh pr create'), 0);
  const list = only(calls, 'gh pr list');
  assert.equal(valueAfter(list.words, '--repo'), 'o/r');
  assert.equal(valueAfter(list.words, '--head'), 'feat/slice-run');
  assert.equal(valueAfter(only(calls, 'krn deliver').words, '--pr'), '9');
  assert.equal((await journal(root)).pr, 9);
});

test('a new PR is created in the named repository', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const { run, calls } = stub(root, {});
  await runSlice(options, { root, krn, run });
  assert.equal(valueAfter(only(calls, 'gh pr create').words, '--repo'), 'o/r');
});

test('a rerun without a worker stops the session the failed worker left open', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const first = stub(root, { worker: 4 });
  await runSlice(options, { root, krn, run: first.run });
  assert.equal(
    count(first.calls, 'krn worker stop'),
    0,
    'session stays open for a continuation',
  );
  const second = stub(root, {});
  const result = await runSlice(
    { ...options, worker: 'none' },
    { root, krn, run: second.run },
  );
  assert.equal(result.exitCode, 0, result.cause);
  const stop = index(second.calls, 'krn worker stop');
  assert.ok(stop >= 0, 'worker stop called');
  assert.ok(
    stop < index(second.calls, 'krn task close'),
    'stop before task close',
  );
});

for (const [crashAt, repeated] of [
  ['git worktree add', 'git worktree add'],
  ['krn task claim', 'krn task claim'],
  ['krn task close', 'krn task close'],
  ['git commit -m chore(tasks): close', 'git commit -m chore(tasks): close'],
] as const) {
  test(`a crash right after ${crashAt} resumes without repeating it`, async (t) => {
    const runSlice = await loadRunSlice();
    const { root, options, krn } = await fixture(t);
    const first = stub(root, { crashAt });
    const crashed = await runSlice(options, { root, krn, run: first.run });
    assert.notEqual(crashed.exitCode, 0);
    assert.equal(count(first.calls, repeated), 1);
    const second = stub(root, {});
    const result = await runSlice(options, { root, krn, run: second.run });
    assert.equal(result.exitCode, 0, result.cause);
    assert.equal(result.stage, 'done');
    assert.equal(
      count(second.calls, repeated),
      0,
      `rerun repeated ${repeated}`,
    );
  });
}

test('a crash during review fails closed instead of spending another attempt', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(options, {
    root,
    krn,
    run: stub(root, { crashAt: 'krn review' }).run,
  });
  const second = stub(root, {});
  const result = await runSlice(options, { root, krn, run: second.run });
  assert.equal(result.exitCode, 65);
  assert.equal(result.stage, 'review');
  assert.match(result.cause, /review/);
  assert.equal(count(second.calls, 'krn review'), 0);
});

test('a crash after review returns a record fails closed on rerun', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  const first = stub(root, {});
  const crashed = await runSlice(options, {
    root,
    krn,
    run: async (command, args, opts) => {
      const result = await first.run(command, args, opts);
      if (!normalize(command, args).join(' ').startsWith('krn review'))
        return result;
      return {
        code: result.code,
        stderr: result.stderr,
        get stdout(): string {
          throw new Error('simulated crash while reading the review record');
        },
      };
    },
  });
  assert.notEqual(crashed.exitCode, 0);
  assert.equal(count(first.calls, 'krn review'), 1);
  const second = stub(root, {});
  const result = await runSlice(options, { root, krn, run: second.run });
  assert.equal(result.exitCode, 65);
  assert.equal(result.stage, 'review');
  assert.equal(count(second.calls, 'krn review'), 0);
});

const MOVED = 'c'.repeat(40);

test('a second review round re-verifies and pushes the fixed head first', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(options, { root, krn, run: stub(root, { reviews: [1] }).run });
  const second = stub(root, {});
  const result = await runSlice(options, { root, krn, run: second.run });
  assert.equal(result.exitCode, 0, result.cause);
  const review = index(second.calls, 'krn review');
  assert.ok(
    index(second.calls, 'krn verify') >= 0 &&
      index(second.calls, 'krn verify') < review,
  );
  const push = second.calls.findIndex((call) =>
    call.line.startsWith('git push'),
  );
  assert.ok(push >= 0 && push < review, 'push before the second round');
  assert.equal(count(second.calls, 'gh pr create'), 0);
});

test('a moved main stops the rerun until the branch contains it, then restarts the review budget', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(options, { root, krn, run: stub(root, { reviews: [1] }).run });
  const stale = stub(root, { base: MOVED, rebased: false });
  const stopped = await runSlice(options, { root, krn, run: stale.run });
  assert.equal(stopped.exitCode, 75);
  assert.match(stopped.cause, /rebase/);
  assert.equal(count(stale.calls, 'krn review'), 0);
  const rebased = stub(root, { base: MOVED });
  const result = await runSlice(options, { root, krn, run: rebased.run });
  assert.equal(result.exitCode, 0, result.cause);
  const review = only(rebased.calls, 'krn review');
  assert.equal(valueAfter(review.words, '--base'), MOVED);
  assert.ok(
    !review.words.includes('--prior-record'),
    'a new base starts a new series',
  );
  assert.equal(
    valueAfter(only(rebased.calls, 'krn verify').words, '--base'),
    MOVED,
  );
  assert.equal((await journal(root)).base, MOVED);
});

test('a second concurrent run is refused while the lock is held', async (t) => {
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(
    { ...options, stopAfter: 'base' },
    { root, krn, run: stub(root, {}).run },
  );
  const lock = join(root, '.krn', 'runs', 'slice', TASK, 'run.lock');
  await writeFile(lock, 'held\n');
  const { run, calls } = stub(root, {});
  const result = await runSlice(options, { root, krn, run });
  assert.equal(result.exitCode, 75);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(lock, 'utf8'), 'held\n');
  await rm(lock);
  const done = await runSlice(options, { root, krn, run: stub(root, {}).run });
  assert.equal(done.exitCode, 0, done.cause);
  await assert.rejects(stat(lock), 'a finished run releases the lock');
});

test('run files never follow a symlink', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const runSlice = await loadRunSlice();
  const { root, options, krn } = await fixture(t);
  await runSlice(
    { ...options, stopAfter: 'claim' },
    { root, krn, run: stub(root, {}).run },
  );
  const target = join(root, 'outside.md');
  await writeFile(target, 'untouched\n');
  const directory = join(root, '.krn', 'runs', 'slice', TASK);
  await symlink(target, join(directory, 'lens.md'));
  await symlink(target, join(directory, 'implementation-message.md'));
  const result = await runSlice(options, {
    root,
    krn,
    run: stub(root, {}).run,
  });
  assert.equal(await readFile(target, 'utf8'), 'untouched\n');
  assert.equal(result.exitCode, 0, result.cause);
});
