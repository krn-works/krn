import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { effortSchema } from '../worker/state.ts';
import {
  type Journal,
  journalPath,
  readJournal,
  writeJournal,
} from './journal.ts';
import {
  implementationMessage,
  oneLine,
  parseArgv,
  type Stage,
  stages,
} from './stages.ts';

const optionsSchema = z.object({
  task: z.string().regex(/^t-[a-z\d]+$/u),
  brief: z.string().min(1),
  message: z.string().min(1),
  name: z.string().regex(/^[a-z\d]+(?:-[a-z\d]+)*$/u),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  model: z.string().min(1),
  effort: effortSchema,
  worker: z.enum(['codex', 'none']).optional(),
  stopAfter: z.enum(stages).optional(),
  override: z.boolean().optional(),
  reason: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
  budgetException: z.string().min(1).optional(),
});
export interface SliceOptions {
  readonly task: string;
  readonly brief: string;
  readonly message: string;
  readonly name: string;
  readonly repo: string;
  readonly model: string;
  readonly effort: string;
  readonly worker?: 'codex' | 'none';
  readonly stopAfter?: string;
  /** Accept the recorded review FAIL on the unchanged reviewed head (needs reason and evidence). */
  readonly override?: boolean;
  readonly reason?: string;
  readonly evidence?: string;
  /** Operator budget exception passed to a review attempt beyond the second. */
  readonly budgetException?: string;
}
export interface SliceRuntime {
  readonly root: string;
  readonly krn: string;
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ) => Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly detach: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly log: string },
  ) => Promise<void> | void;
  /** Waits between PR head polls; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}
/** GitHub can report the previous PR head right after a push. */
const HEAD_POLLS = 12;
const HEAD_POLL_MS = 5000;
export interface SliceResult {
  readonly exitCode: number;
  readonly stage: string;
  readonly cause: string;
  /** Lines after the cause: a failed review's record path, then one per BLOCKING finding. */
  readonly details?: readonly string[];
}
class Failure extends Error {
  readonly code: number;
  readonly details: readonly string[];
  constructor(code: number, cause: string, details: readonly string[] = []) {
    super(cause || `command failed exit ${code}`);
    this.code = code;
    this.details = details;
  }
}
// `git worktree list --porcelain` names a registered worktree with its branch.
function registeredWorktree(
  porcelain: string,
  worktree: string,
  branch: string,
): boolean {
  return porcelain.split(/\r?\n\r?\n/u).some((block) => {
    const lines = block.split(/\r?\n/u);
    return (
      lines.includes(`worktree ${worktree}`) &&
      lines.includes(`branch refs/heads/${branch}`)
    );
  });
}

// A live claim by the lead on this worktree, left by a run that stopped
// before it recorded the claim stage.
async function heldClaim(
  root: string,
  task: string,
  worktree: string,
): Promise<boolean> {
  const path = join(root, '.krn', 'task-claims', `${task}.json`);
  try {
    if (!(await lstat(path)).isFile()) return false;
    const claim = z
      .object({ actor: z.string(), worktree: z.string() })
      .safeParse(parseJson(await readFile(path, 'utf8')));
    return (
      claim.success &&
      claim.data.actor === 'lead' &&
      claim.data.worktree === worktree
    );
  } catch {
    return false;
  }
}

async function closedTask(worktree: string, task: string): Promise<boolean> {
  const path = join(worktree, 'tasks', `${task}.json`);
  try {
    if (!(await lstat(path)).isFile()) return false;
    const record = z
      .object({ status: z.string() })
      .safeParse(parseJson(await readFile(path, 'utf8')));
    return record.success && record.data.status === 'closed';
  } catch {
    return false;
  }
}

const PRE_COMMIT_LOG_BYTES = 1024 * 1024;

// Temp file plus rename replaces a symlink at the target instead of following it.
async function writeRunFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.run-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runSlice(
  input: SliceOptions,
  runtime: SliceRuntime,
): Promise<SliceResult> {
  let stage: Stage = 'base';
  let state: Journal | undefined;
  let path: string | undefined;
  let writable = false;
  let lock: string | undefined;
  let gate: ReturnType<SliceRuntime['run']> | undefined;
  let mergedCause = '';
  try {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success) throw new Failure(64, 'invalid slice options');
    const options = parsed.data;
    if (
      options.override === true
        ? !options.reason || !options.evidence
        : options.reason !== undefined || options.evidence !== undefined
    )
      throw new Failure(
        64,
        '--override needs --reason and --evidence, and they need --override',
      );
    const root = resolve(runtime.root);
    const brief = resolve(root, options.brief);
    const message = resolve(root, options.message);
    let body: string;
    try {
      body = await readFile(message, 'utf8');
    } catch {
      throw new Failure(64, `cannot read message: ${message}`);
    }
    const title = body.split(/\r?\n/u)[0] ?? '';
    const type = /^([a-z]+)(?:\([^\r\n]*\))?!?: /u.exec(title)?.[1];
    if (
      !title.endsWith(`(${options.task})`) ||
      !type ||
      /[\p{Cc}\p{Cf}]/u.test(title)
    )
      throw new Failure(
        64,
        'message title must be Conventional Commits with the task suffix',
      );
    const worktree = join(root, '.krn', 'worktrees', options.name);
    path = await journalPath(root, options.task);
    const lockPath = join(dirname(path), 'run.lock');
    try {
      await writeFile(lockPath, `${process.pid}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Failure(
          75,
          `another slice run holds ${lockPath}; remove it only when no run is active`,
        );
      throw error;
    }
    lock = lockPath;
    state = await readJournal(path);
    if (state) {
      stage = state.stage;
      for (const [key, expected] of Object.entries({
        task: options.task,
        name: options.name,
        brief,
        message,
        repo: options.repo,
        model: options.model,
        effort: options.effort,
        worktree,
        branch: `${type}/${options.name}`,
      })) {
        if (state[key as keyof Journal] !== expected)
          throw new Failure(
            65,
            `journal ${key} mismatch: ${state[key as keyof Journal]} != ${expected}`,
          );
      }
    } else {
      state = {
        task: options.task,
        name: options.name,
        branch: `${type}/${options.name}`,
        brief,
        message,
        repo: options.repo,
        model: options.model,
        effort: options.effort,
        worktree,
        base: '',
        pr: null,
        stage: 'base',
        completed: false,
        reviewAttempts: 0,
        reviewRecord: null,
        argv: [],
        exitCode: 0,
        cause: '',
      };
    }
    writable = true;
    const journal = state;
    const journalFile = path;
    const save = () => writeJournal(journalFile, journal);
    const exec = async (
      command: string,
      args: readonly string[],
      cwd = worktree,
    ) => {
      const result = await runtime.run(command, args, { cwd });
      if (result.code !== 0)
        throw new Failure(
          result.code,
          result.stderr || result.stdout || `${command} exit ${result.code}`,
        );
      return result.stdout;
    };
    const krn = (args: string[], cwd = worktree) =>
      exec(runtime.krn, args, cwd);
    // The detached landing deliver: from the PR worktree until hygiene retires it.
    const landing = async () => {
      let cwd = root;
      try {
        if ((await lstat(worktree)).isDirectory()) cwd = worktree;
      } catch {
        /* Retired by delivery. */
      }
      const version = (
        await readFile(join(root, '.node-version'), 'utf8')
      ).trim();
      const args = [
        'exec',
        `node@${version}`,
        '--',
        join(cwd, 'bin', 'krn'),
        'deliver',
        '--repo',
        options.repo,
        '--pr',
        String(journal.pr),
        '--record',
        journal.reviewRecord ?? '',
        '--task',
        options.task,
      ];
      return { cwd, args };
    };
    if (
      journal.stage === 'worker' &&
      !journal.completed &&
      journal.exitCode &&
      options.worker !== 'none'
    )
      return {
        exitCode: journal.exitCode,
        stage: 'worker',
        cause: journal.cause,
      };
    // A review FAIL on the unchanged head on the same base: the lead fixes or overrides.
    const failed =
      journal.stage === 'review' &&
      !journal.completed &&
      journal.reviewAttempts >= 1 &&
      journal.reviewPending !== true &&
      journal.reviewRecord !== null &&
      (journal.reviewFailed ?? journal.exitCode !== 0);
    const reviewed = failed ? await reviewedHead(journal) : undefined;
    const head =
      reviewed === undefined
        ? undefined
        : (await exec('git', ['rev-parse', 'HEAD'])).trim();
    const unchanged =
      head !== undefined &&
      head === reviewed &&
      (await exec('git', ['ls-remote', 'origin', 'main'], root))
        .trim()
        .split(/\s/u)[0] === journal.base;
    if (options.override === true && !unchanged) {
      // A refusal changes nothing: a completed stage must not be rerun.
      writable = false;
      throw new Failure(
        64,
        '--override applies only to a review FAIL on the unchanged reviewed head and base',
      );
    }
    if (unchanged && options.override !== true)
      throw new Failure(
        65,
        `review attempt ${journal.reviewAttempts} FAILed on unchanged head ${head}: fix and commit, or rerun with --override --reason <text> --evidence <text>`,
      );
    if (unchanged && options.reason && options.evidence) {
      if (!(await recordOverridden(journal.reviewRecord, head)))
        await krn(
          [
            'review',
            '--repo',
            worktree,
            '--pr',
            String(journal.pr),
            '--base',
            journal.base,
            '--head',
            head,
            '--override',
            '--reason',
            options.reason,
            '--evidence',
            options.evidence,
          ],
          root,
        );
      journal.reviewOverride = true;
      journal.completed = true;
      await save();
    }
    if (journal.stage === 'done' && journal.completed) {
      stage = 'done';
      writable = false;
      const log = join(dirname(path), 'landing.log').replace(
        /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
        ' ',
      );
      const exit = join(dirname(path), 'landing.exit');
      if (!journal.landing) return { exitCode: 0, stage: 'done', cause: '' };
      let text: string;
      try {
        const file = await open(
          exit,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          text = await file.readFile('utf8');
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // No exit: running, or crashed between the landing save and the spawn.
        const { cwd, args } = await landing();
        await runtime.detach('mise', args, {
          cwd,
          log: join(dirname(path), 'landing.log'),
        });
        return { exitCode: 0, stage: 'done', cause: 'landing: running' };
      }
      const value = text.trim();
      const code = /^\d+$/u.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(code) || code > 255)
        return {
          exitCode: 74,
          stage: 'done',
          cause: `landing: failed exit unknown, log ${log}`,
        };
      return {
        exitCode: code,
        stage: 'done',
        cause:
          code === 0
            ? 'landing: delivered'
            : `landing: failed exit ${code}, log ${log}`,
      };
    }
    // A review PASS saved before the stage completed resumes at deliver.
    if (
      journal.stage === 'review' &&
      journal.reviewPending !== true &&
      journal.reviewFailed === false
    )
      journal.completed = true;
    // A later review round runs on a fixed head: verify and push it first.
    const start =
      failed && !unchanged && journal.reviewAttempts >= 1
        ? stages.indexOf('verify')
        : stages.indexOf(journal.stage) + (journal.completed ? 1 : 0);
    if (journal.completed && options.stopAfter === journal.stage)
      return { exitCode: 0, stage: journal.stage, cause: '' };
    for (stage of stages.slice(start)) {
      journal.stage = stage;
      journal.completed = false;
      journal.exitCode = 0;
      journal.cause = '';
      await save();
      const observers = journal.argv.flatMap((word, i, all) =>
        word === '--observer' ? [all[i + 1] ?? ''] : [],
      );
      switch (stage) {
        case 'base': {
          const output = await exec(
            'git',
            ['ls-remote', 'origin', 'main'],
            root,
          );
          const sha = output.trim().split(/\s/u)[0] ?? '';
          if (!/^[a-f\d]{40,64}$/u.test(sha))
            throw new Failure(65, 'invalid remote base SHA');
          journal.base = sha;
          break;
        }
        case 'worktree': {
          if (
            !journal.worktreeCreated &&
            !registeredWorktree(
              await exec('git', ['worktree', 'list', '--porcelain'], root),
              worktree,
              journal.branch,
            )
          ) {
            await exec(
              'git',
              ['worktree', 'add', '-b', journal.branch, worktree, journal.base],
              root,
            );
            journal.worktreeCreated = true;
            await save();
          }
          const version = (
            await readFile(join(root, '.node-version'), 'utf8')
          ).trim();
          await exec('mise', [
            'exec',
            `node@${version}`,
            '--',
            'pnpm',
            'install',
            '--frozen-lockfile',
          ]);
          break;
        }
        case 'claim':
          if (await heldClaim(root, options.task, worktree)) break;
          await krn([
            'task',
            'claim',
            options.task,
            '--actor',
            'lead',
            '--worktree',
            worktree,
            '--reason',
            title,
          ]);
          break;
        case 'brief': {
          journal.argv = parseArgv(
            await krn([
              'brief',
              'check',
              brief,
              '--repo',
              worktree,
              '--model',
              options.model,
            ]),
          );
          const lens = await krn(['brief', 'lens', brief]);
          await writeRunFile(join(dirname(path), 'lens.md'), lens);
          break;
        }
        case 'worker':
          if (options.worker === 'none') {
            if (journal.workerOpen === true) {
              await krn([
                'worker',
                'stop',
                '--run',
                join(worktree, '.krn', 'runs', options.name),
              ]);
              journal.workerOpen = false;
              await save();
            }
            // Lead edits face the observers and rule tests before they are committed.
            if (!journal.implementationCommitted) {
              const version = (
                await readFile(join(root, '.node-version'), 'utf8')
              ).trim();
              const result = await runtime.run(
                'mise',
                [
                  'exec',
                  `node@${version}`,
                  '--',
                  'node',
                  '--test',
                  ...observers,
                  'test/rules',
                ],
                { cwd: worktree },
              );
              const output = Buffer.from(`${result.stdout}${result.stderr}`);
              await writeRunFile(
                join(dirname(path), 'pre-commit.log'),
                output.subarray(-PRE_COMMIT_LOG_BYTES).toString(),
              );
              if (result.code !== 0)
                throw new Failure(
                  result.code,
                  `pre-commit observers and test/rules exit ${result.code}; see pre-commit.log`,
                );
            }
          } else {
            const run = join(worktree, '.krn', 'runs', options.name);
            journal.workerOpen = true;
            await save();
            await krn([
              'worker',
              'start',
              '--run',
              run,
              '--repo',
              worktree,
              '--brief',
              brief,
              ...journal.argv,
              '--model',
              options.model,
              '--effort',
              options.effort,
            ]);
            await krn(['worker', 'stop', '--run', run]);
            journal.workerOpen = false;
          }
          break;
        case 'commit': {
          if (!journal.implementationCommitted) {
            const status = await exec('git', [
              'status',
              '--porcelain=v1',
              '-z',
              '--untracked-files=all',
            ]);
            const paths: string[] = [];
            const entries = status.includes('\0')
              ? status.split('\0')
              : status.split(/\r?\n/u);
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              if (!entry) continue;
              paths.push(entry.slice(3));
              if (status.includes('\0') && /^[RC]|^.[RC]/u.test(entry)) i++;
            }
            if (paths.length) {
              await exec('git', ['add', '--', ...paths]);
              const commitFile = join(
                dirname(path),
                'implementation-message.md',
              );
              await writeRunFile(
                commitFile,
                implementationMessage(body, options.task, observers),
              );
              await exec('git', ['commit', '-F', commitFile]);
            }
            journal.implementationCommitted = true;
            await save();
          }
          if (
            !journal.taskClosed &&
            !(await closedTask(worktree, options.task))
          ) {
            await krn([
              'task',
              'close',
              options.task,
              '--as',
              'done',
              '--note',
              title,
            ]);
            journal.taskClosed = true;
            await save();
          }
          const closeSubject = `chore(tasks): close ${options.task} (${options.task})`;
          if (
            !journal.closeCommitted &&
            (await exec('git', ['log', '-1', '--format=%s'])).trim() !==
              closeSubject
          ) {
            await exec('git', ['add', '--', `tasks/${options.task}.json`]);
            await exec('git', [
              'commit',
              '-m',
              closeSubject,
              '-m',
              `Ticket: ${options.task}`,
            ]);
            journal.closeCommitted = true;
            await save();
          }
          break;
        }
        case 'verify': {
          const remote = (
            await exec('git', ['ls-remote', 'origin', 'main'], root)
          )
            .trim()
            .split(/\s/u)[0];
          if (!remote || !/^[a-f\d]{40,64}$/u.test(remote))
            throw new Failure(65, 'invalid remote base SHA');
          if (remote !== journal.base) {
            const ancestor = await runtime.run(
              'git',
              ['merge-base', '--is-ancestor', remote, 'HEAD'],
              { cwd: worktree },
            );
            if (ancestor.code === 1)
              throw new Failure(
                75,
                `main moved to ${remote}: rebase ${journal.branch} onto it, then rerun`,
              );
            if (ancestor.code !== 0)
              throw new Failure(
                ancestor.code,
                ancestor.stderr || 'git merge-base failed',
              );
            // D10 keys the review series by PR and baseRef, not the base SHA:
            // a same-ref rebase continues the series and keeps its count.
            journal.base = remote;
            await save();
          }
          const verified = await runtime.run(
            runtime.krn,
            [
              'verify',
              '--base',
              journal.base,
              ...observers.flatMap((p) => ['--observer', p]),
            ],
            { cwd: worktree },
          );
          if (verified.code !== 0)
            throw new Failure(
              verified.code,
              verifyFailure(verified.stdout) ||
                verified.stderr ||
                verified.stdout ||
                `${runtime.krn} exit ${verified.code}`,
            );
          break;
        }
        case 'pr': {
          await exec('git', [
            'push',
            '--force-with-lease',
            '-u',
            'origin',
            journal.branch,
          ]);
          journal.pushed = true;
          await save();
          if (journal.pr !== null) break;
          const listed = z
            .array(z.object({ number: z.number().int().positive() }))
            .max(1)
            .safeParse(
              parseJson(
                (
                  await exec('gh', [
                    'pr',
                    'list',
                    '--repo',
                    options.repo,
                    '--head',
                    journal.branch,
                    '--state',
                    'open',
                    '--json',
                    'number',
                  ])
                ).trim() || '[]',
              ),
            );
          if (!listed.success)
            throw new Failure(65, 'invalid gh pr list output');
          const existing = listed.data[0]?.number;
          if (existing !== undefined) {
            journal.pr = existing;
            break;
          }
          const output = await exec('gh', [
            'pr',
            'create',
            '--repo',
            options.repo,
            '--draft',
            '--title',
            title,
            '--body',
            body,
            '--base',
            'main',
            '--head',
            journal.branch,
          ]);
          const match = /^https:\/\/[^\s]+\/pull\/([1-9]\d*)$/u.exec(
            output.trim(),
          );
          const number = Number(match?.[1]);
          if (!Number.isSafeInteger(number) || number <= 0)
            throw new Failure(65, 'invalid PR URL');
          journal.pr = number;
          break;
        }
        case 'review': {
          if (journal.reviewAttempts > 0 && !journal.reviewRecord)
            throw new Failure(
              65,
              'review attempt has no prior record; cannot resume review',
            );
          const head = (await exec('git', ['rev-parse', 'HEAD'])).trim();
          const exception =
            journal.reviewAttempts >= 2 && options.budgetException !== undefined
              ? resolve(root, options.budgetException)
              : undefined;
          if (journal.reviewAttempts >= 2 && exception === undefined)
            throw new Failure(
              64,
              `review budget spent: write the operator exception to ${relative(root, join(dirname(path), 'budget-exception.json'))} and rerun with --budget-exception`,
              [
                `exception: ${join(dirname(path), 'budget-exception.json')} for ordinal ${journal.reviewAttempts + 1} on head ${head}`,
              ],
            );
          // Review admission compares the PR head: wait until GitHub reports the push.
          const sleep =
            runtime.sleep ??
            ((ms: number) =>
              new Promise<void>((resolve) => setTimeout(resolve, ms)));
          let remoteHead = '';
          for (let poll = 1; poll <= HEAD_POLLS; poll++) {
            remoteHead = (
              await exec('gh', [
                'pr',
                'view',
                String(journal.pr),
                '--repo',
                options.repo,
                '--json',
                'headRefOid',
                '--jq',
                '.headRefOid',
              ])
            ).trim();
            if (!/^[a-f\d]{40,64}$/u.test(remoteHead))
              throw new Failure(65, 'invalid gh pr view output');
            if (remoteHead === head) break;
            if (poll < HEAD_POLLS) await sleep(HEAD_POLL_MS);
          }
          if (remoteHead !== head)
            throw new Failure(
              75,
              `PR #${journal.pr} head ${remoteHead} has not reached ${head}: rerun`,
            );
          gate = runtime
            .run(
              runtime.krn,
              [
                'ci',
                'wait',
                '--repo',
                options.repo,
                '--pr',
                String(journal.pr),
                '--head',
                head,
                '--base',
                journal.base,
              ],
              { cwd: worktree },
            )
            .catch((error) => ({
              code: 74,
              stdout: '',
              stderr: String(error),
            }));
          // The brief may change after the brief stage: judge against the current one.
          await writeRunFile(
            join(dirname(path), 'lens.md'),
            await krn(['brief', 'lens', brief]),
          );
          const args = [
            'review',
            '--repo',
            worktree,
            '--pr',
            String(journal.pr),
            '--base',
            journal.base,
            '--head',
            head,
            '--lens',
            join(dirname(path), 'lens.md'),
            '--prepass',
            '--risk-tier',
            '--checklist',
            join(worktree, 'docs', 'program', 'hardening-checklist.md'),
          ];
          // An exception attempt takes no prior record (only round two verifies one).
          if (exception !== undefined)
            args.push('--budget-exception', exception);
          // Review refuses a prior record on the head it judged: a moved base
          // under an unchanged head continues the series without one.
          else if (journal.reviewRecord && journal.reviewHead !== head)
            args.push('--prior-record', journal.reviewRecord);
          if (journal.reviewPending === true)
            throw new Failure(
              65,
              'review outcome unknown after an interrupted attempt: read .krn/runs/review-series and decide by hand',
            );
          journal.reviewPending = true;
          await save();
          const result = await runtime.run(runtime.krn, args, { cwd: root });
          // The flag clears only in the write that saves the outcome.
          const last = result.stdout.trimEnd().split(/\r?\n/u).at(-1) ?? '';
          try {
            journal.reviewRecord = z
              .object({ record: z.string().min(1) })
              .parse(JSON.parse(last)).record;
            journal.reviewAttempts++;
            journal.reviewHead = /^[a-f\d]{40,64}$/u.test(head) ? head : null;
            journal.reviewFailed = result.code !== 0;
            journal.reviewPending = false;
          } catch {
            journal.reviewPending = false;
            await save();
            if (result.code)
              throw new Failure(
                result.code,
                result.stderr || `review refused exit ${result.code}`,
              );
            throw new Failure(
              result.code || 65,
              'review did not return a valid record',
            );
          }
          await save();
          if (gate) {
            const waited = await gate;
            if (result.code === 0 && waited.code === 0) {
              journal.gateHead = journal.reviewHead;
              await save();
            }
          }
          if (result.code)
            throw new Failure(result.code, `review FAIL exit ${result.code}`, [
              `record ${journal.reviewRecord}`,
              ...(await blockingFindings(journal.reviewRecord)),
            ]);
          break;
        }
        case 'gate': {
          const head = (await exec('git', ['rev-parse', 'HEAD'])).trim();
          if (head !== journal.reviewHead)
            throw new Failure(
              75,
              'HEAD differs from reviewed head; rerun review',
            );
          if (journal.gateHead !== journal.reviewHead) {
            const result = await (gate ??
              runtime.run(
                runtime.krn,
                [
                  'ci',
                  'wait',
                  '--repo',
                  options.repo,
                  '--pr',
                  String(journal.pr),
                  '--head',
                  head,
                  '--base',
                  journal.base,
                ],
                { cwd: worktree },
              ));
            if (result.code !== 0)
              throw new Failure(
                result.code === 75 ? 75 : 74,
                result.stderr || result.stdout || 'gate failed',
              );
            journal.gateHead = head;
          }
          break;
        }
        case 'deliver': {
          const { cwd, args } = await landing();
          const log = join(dirname(path), 'landing.log');
          const exit = join(dirname(path), 'landing.exit');
          // A landing recorded before a crash may never have spawned; the detached wrapper's lock runs at most one.
          if (journal.landing) {
            await runtime.detach('mise', args, { cwd, log });
            mergedCause = `landing: recorded, log ${log}`;
            break;
          }
          const merged = await exec('mise', [...args, '--merge-only'], cwd);
          for (const file of [log, exit]) {
            const handle = await open(
              file,
              constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
              0o600,
            );
            await handle.close();
          }
          await rm(exit);
          journal.landing = { log, exit };
          await save();
          try {
            await runtime.detach('mise', args, { cwd, log });
          } catch (error) {
            delete journal.landing;
            await save();
            throw new Failure(
              70,
              `cannot start the landing deliver: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          mergedCause =
            `${merged.trim()}; main CI and hygiene running, log ${log}`.replace(
              /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
              ' ',
            );
          break;
        }
        case 'done':
          break;
      }
      journal.completed = true;
      await save();
      if (options.stopAfter === stage) return { exitCode: 0, stage, cause: '' };
    }
    return { exitCode: 0, stage: 'done', cause: mergedCause };
  } catch (error) {
    const exitCode = error instanceof Failure ? error.code : 65;
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      stage === 'gate'
        ? (message.split(/[\n\r\u2028\u2029]/u)[0] ?? '').replace(
            /[\p{Cc}\p{Cf}]/gu,
            '',
          )
        : oneLine(message);
    if (writable && state && path) {
      state.stage = stage;
      state.completed = false;
      state.exitCode = exitCode;
      state.cause = cause;
      try {
        await writeJournal(path, state);
      } catch {
        /* Preserve original refusal. */
      }
    }
    const details = error instanceof Failure ? error.details : [];
    return { exitCode, stage, cause, ...(details.length ? { details } : {}) };
  } finally {
    if (lock) await rm(lock, { force: true });
  }
}

const recordFindings = z.array(
  z.object({
    severity: z.string(),
    path: z.string(),
    line: z.number(),
    title: z.string(),
    demoted: z.boolean().optional(),
  }),
);

/** Names each non-demoted BLOCKING finding of a review record; an unreadable record names none. */
async function blockingFindings(record: string): Promise<string[]> {
  try {
    const parsed = z
      .object({
        prepass: z.object({ findings: recordFindings }).optional(),
        judges: z
          .array(z.object({ findings: recordFindings.default([]) }))
          .default([]),
      })
      .parse(JSON.parse(await readFile(record, 'utf8')));
    return [
      parsed.prepass?.findings ?? [],
      ...parsed.judges.map((j) => j.findings),
    ]
      .flat()
      .filter((f) => f.severity === 'BLOCKING' && f.demoted !== true)
      .map((f) =>
        oneLine(
          `BLOCKING ${f.path}:${f.line} ${f.title.replace(/\s+/gu, ' ')}`,
        ),
      );
  } catch {
    return [];
  }
}

const recordHeadSchema = z.object({
  headSha: z.string().regex(/^[a-f\d]{40,64}$/u),
  override: z.unknown().optional(),
});

async function readRecordHead(
  record: string | null,
): Promise<z.infer<typeof recordHeadSchema> | undefined> {
  if (!record) return undefined;
  try {
    return recordHeadSchema.parse(JSON.parse(await readFile(record, 'utf8')));
  } catch {
    return undefined;
  }
}

/** The head the last review judged: the journal's, else the record's; unknown keeps the old resume. */
async function reviewedHead(journal: Journal): Promise<string | undefined> {
  return (
    journal.reviewHead ?? (await readRecordHead(journal.reviewRecord))?.headSha
  );
}

/** True when the FAIL record already carries an override for this head (a crash after the override). */
async function recordOverridden(
  record: string | null,
  head: string,
): Promise<boolean> {
  const parsed = await readRecordHead(record);
  return parsed?.headSha === head && parsed.override !== undefined;
}

/** The first failing step line of `krn verify` stdout (`<step> FAIL <detail>`), else its overall line. */
function verifyFailure(stdout: string): string {
  const lines = stdout.split(/\r?\n/u);
  return (
    lines.find((line) => /^(?!overall )\S+ FAIL /u.test(line)) ??
    lines.find((line) => line.startsWith('overall FAIL')) ??
    ''
  );
}
