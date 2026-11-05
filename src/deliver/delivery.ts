import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  currentReviewAttempts,
  readReviewJson,
  verifyReviewBinding,
} from '../flow/series.ts';
import { isOverridableFailure, newReviewRecordSchema } from '../flow/types.ts';
import { gateAdmissionPolicyFromBase } from './admission-policy.ts';
import { requireReviewChecklist } from './checklist.ts';
import { GateTimeout, waitForGate } from './gate-wait.ts';
import { removeIdenticalLeftovers } from './identical-leftovers.ts';
import { checkMergeContracts, mergeMessage } from './message.ts';
import {
  CommandFailure,
  checked,
  exitCodes,
  github,
  type Runner,
  run,
  sleep,
} from './transport.ts';

type Stage = keyof typeof exitCodes;
export class DeliveryFailure extends Error {
  readonly exitCode: number;
  readonly stage: Stage;
  override readonly cause: unknown;
  constructor(stage: Stage, cause: unknown) {
    super(
      `${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.exitCode = exitCodes[stage];
    this.stage = stage;
    this.cause = cause;
  }
}
export interface DeliveryOptions {
  repo: string;
  pr: number;
  record: string;
  task?: string | undefined;
  messageFile?: string | undefined;
  dryRun: boolean;
  mergeOnly?: boolean;
  /** @deprecated Accepted for older callers; delivery no longer waits for host load. */
  loadThreshold?: number;
  timeoutMs: number;
  pollMs: number;
}
export interface DeliveryRuntime {
  cwd?: string;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  contracts?: typeof checkMergeContracts;
}
const sha = z.string().regex(/^[a-f\d]{40}$/u);
const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  head: z.object({ sha, ref: z.string() }),
  base: z.object({
    sha,
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
});
const shipSchema = z.object({
  head: sha,
  treeMatch: z.literal(true),
  merge: sha,
});
const stateSchema = z.object({
  repo: z.string(),
  pr: z.number(),
  head: sha,
  base: sha,
  worktree: z.string(),
  branch: z.string(),
  message: z.string(),
  // Old journals may retain this flag; only current GitHub CI admits delivery.
  gate: z.boolean().optional(),
  merge: sha.optional(),
});
const statusesSchema = z.array(
  z.array(
    z.object({
      context: z.string(),
      state: z.string(),
    }),
  ),
);

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

function ensureRealDirectory(path: string, relativePath: string) {
  const current = lstatIfPresent(path);
  if (!current) {
    mkdirSync(path);
    return;
  }
  if (!current.isDirectory())
    throw new Error(`destination is not a real directory: ${relativePath}`);
}

function validateHygieneDirectories(main: string, worktree: string) {
  const mainKrn = join(main, '.krn');
  const mainKrnStat = lstatIfPresent(mainKrn);
  if (mainKrnStat && !mainKrnStat.isDirectory())
    throw new Error('.krn is not a real directory');

  if (mainKrnStat) {
    const mainRuns = join(mainKrn, 'runs');
    const mainRunsStat = lstatIfPresent(mainRuns);
    if (mainRunsStat && !mainRunsStat.isDirectory())
      throw new Error('.krn/runs is not a real directory');

    const archiveStat = lstatIfPresent(join(mainKrn, 'archive'));
    if (archiveStat && !archiveStat.isDirectory())
      throw new Error('.krn/archive is not a real directory');

    if (mainRunsStat) {
      const reviewSeriesStat = lstatIfPresent(join(mainRuns, 'review-series'));
      if (reviewSeriesStat && !reviewSeriesStat.isDirectory())
        throw new Error('.krn/runs/review-series is not a real directory');
    }
  }

  if (!lstatIfPresent(worktree)) return;
  const worktreeKrn = join(worktree, '.krn');
  const worktreeKrnStat = lstatIfPresent(worktreeKrn);
  if (!worktreeKrnStat) return;
  if (!worktreeKrnStat.isDirectory())
    throw new Error('worktree .krn is not a real directory');

  const worktreeRunsStat = lstatIfPresent(join(worktreeKrn, 'runs'));
  if (worktreeRunsStat && !worktreeRunsStat.isDirectory())
    throw new Error('worktree .krn/runs is not a real directory');
}

function relocateWorktreeRuns(
  worktree: string,
  main: string,
  trackedPaths: Set<string>,
) {
  const worktreeKrn = join(worktree, '.krn');
  const worktreeKrnStat = lstatIfPresent(worktreeKrn);
  if (!worktreeKrnStat) return;
  if (!worktreeKrnStat.isDirectory())
    throw new Error('worktree .krn is not a real directory');

  const sourceRoot = join(worktreeKrn, 'runs');
  const sourceRootStat = lstatIfPresent(sourceRoot);
  if (!sourceRootStat) return;
  if (!sourceRootStat.isDirectory())
    throw new Error('worktree .krn/runs is not a real directory');

  const destinationRoot = join(main, '.krn', 'runs');
  ensureRealDirectory(join(main, '.krn'), '.krn');
  ensureRealDirectory(destinationRoot, '.krn/runs');

  const hasTrackedDescendant = (relativePath: string) =>
    [...trackedPaths].some((tracked) => tracked.startsWith(`${relativePath}/`));

  const mergeDirectory = (
    sourceDirectory: string,
    destinationDirectory: string,
    relativeDirectory: string,
  ) => {
    for (const name of readdirSync(sourceDirectory)) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      if (trackedPaths.has(relativePath)) continue;

      const source = join(sourceDirectory, name);
      const destination = join(destinationDirectory, name);
      const sourceStat = lstatSync(source);
      const destinationStat = lstatIfPresent(destination);

      if (
        sourceStat.isDirectory() &&
        (hasTrackedDescendant(relativePath) || destinationStat?.isDirectory())
      ) {
        ensureRealDirectory(destination, `.krn/runs/${relativePath}`);
        mergeDirectory(source, destination, relativePath);
        if (readdirSync(source).length === 0) rmdirSync(source);
        continue;
      }

      if (!destinationStat) {
        renameSync(source, destination);
        continue;
      }

      if (
        sourceStat.isFile() &&
        destinationStat.isFile() &&
        readFileSync(source).equals(readFileSync(destination))
      ) {
        rmSync(source);
        continue;
      }

      throw new Error(`collision at .krn/runs/${relativePath}`);
    }
  };

  mergeDirectory(sourceRoot, destinationRoot, '');
}

export async function deliver(
  options: DeliveryOptions,
  runtime: DeliveryRuntime = {},
) {
  const runner = runtime.run ?? run;
  const wait = runtime.sleep ?? sleep;
  const now = runtime.now ?? Date.now;
  let stage: Stage = 'bind';
  const initial = resolve(runtime.cwd ?? process.cwd());
  const git = (cwd: string, args: string[], input?: string) =>
    checked(runner('git', args, cwd, input));
  const gh = (args: string[], cwd: string) => github(args, cwd, runner, wait);
  try {
    const common = git(initial, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const main = dirname(common);
    const key = createHash('sha256')
      .update(`${options.repo}\0${options.pr}`)
      .digest('hex');
    const directory = join(main, '.krn', 'runs', 'deliver', key);
    const statePath = join(directory, 'state.json');
    let state = existsSync(statePath)
      ? stateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')))
      : undefined;
    if (state && (state.repo !== options.repo || state.pr !== options.pr))
      throw new Error('saved delivery identity mismatch');
    const pull = pullSchema.parse(
      JSON.parse(
        await gh(['api', `repos/${options.repo}/pulls/${options.pr}`], main),
      ),
    );
    if (!pull.merged && pull.state !== 'open')
      throw new Error('PR is closed without merge');
    if (pull.number !== options.pr || pull.base.repo.full_name !== options.repo)
      throw new Error('PR identity mismatch');
    const recordPath = existsSync(options.record)
      ? resolve(options.record)
      : join(directory, 'review.json');
    const decoded = readReviewJson(recordPath);
    const recordBytes = readFileSync(recordPath);
    if (
      JSON.stringify(decoded) !==
      JSON.stringify(JSON.parse(recordBytes.toString('utf8')))
    )
      throw new Error('review record changed while reading');
    const record = newReviewRecordSchema.parse(decoded);
    if (record.headSha !== pull.head.sha)
      throw new Error('record/PR head mismatch');
    // Unmerged state from an earlier head is stale; a recorded merge is not.
    if (state && state.head !== pull.head.sha) {
      if (pull.merged || state.merge)
        throw new Error('record/PR head mismatch');
      state = undefined;
    }
    requireReviewChecklist(record, main, runner);
    if (record.override && !isOverridableFailure(record))
      throw new Error(
        'override cannot bypass deterministic or incomplete evidence',
      );
    if (record.panelVerdict !== 'PASS' && !record.override)
      throw new Error('review requires PASS or recorded override');
    // Merged recovery keeps the recorded producer when the target branch moves.
    const policyBase = pull.merged ? state?.base : pull.base.sha;
    if (policyBase === undefined)
      throw new Error('merged PR requires a saved delivery binding');
    const gatePolicy = gateAdmissionPolicyFromBase(policyBase, (args) =>
      git(main, args),
    );
    if (!pull.merged) {
      const worktree =
        state?.worktree ?? git(initial, ['rev-parse', '--show-toplevel']);
      if (git(worktree, ['rev-parse', 'HEAD']) !== pull.head.sha)
        throw new Error('local HEAD differs from PR head');
      if (worktree === main)
        throw new Error('delivery requires a separate worktree');
      const nodePinPath = join(worktree, '.node-version');
      if (!existsSync(nodePinPath))
        throw new Error('delivery requires a .node-version pin');
      const found = checked(runner('node', ['--version'], worktree)).replace(
        /^v/u,
        '',
      );
      const pin = readFileSync(nodePinPath, 'utf8').trim().replace(/^v/u, '');
      if (found !== pin)
        throw new Error(
          `Node ${found} on PATH differs from .node-version ${pin}`,
        );
      verifyReviewBinding(main, record, {
        schemaVersion: 1,
        repository: options.repo,
        pr: options.pr,
        baseRef: pull.base.ref,
      });
      const latest = currentReviewAttempts(
        main,
        {
          schemaVersion: 1,
          repository: options.repo,
          pr: options.pr,
          baseRef: pull.base.ref,
        },
        pull.head.sha,
      ).at(-1);
      if (!latest || latest.id !== record.attempt?.id)
        throw new Error('record is not the latest exact-head review attempt');
      for (const commit of [pull.base.sha, pull.head.sha])
        git(worktree, ['merge-base', '--is-ancestor', record.base, commit]);
      if (git(worktree, ['status', '--porcelain', '--untracked-files=no']))
        throw new Error('delivery worktree has tracked changes');
      stage = 'message';
      checked(
        runner(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../scripts/head-trailers.mjs', import.meta.url),
            ),
          ],
          worktree,
        ),
      );
      const commits = git(worktree, [
        'rev-list',
        '--reverse',
        '--no-merges',
        `${pull.base.sha}..${pull.head.sha}`,
      ])
        .split('\n')
        .filter(Boolean);
      const parsed = commits
        .map((commit) => {
          const body = git(worktree, ['show', '-s', '--format=%B', commit]);
          return git(worktree, ['interpret-trailers', '--parse'], body);
        })
        .filter(Boolean)
        .join('\n');
      let message = mergeMessage(pull.title, parsed, options.pr, options.task);
      if (options.messageFile) {
        const supplied = readFileSync(options.messageFile, 'utf8');
        const paragraphs = supplied.trimEnd().split(/\r?\n\s*\r?\n/u);
        if (
          paragraphs.length < 3 ||
          paragraphs[0] !== message.split('\n')[0] ||
          paragraphs.at(-1) !== message.trimEnd().split('\n\n').at(-1) ||
          git(worktree, ['interpret-trailers', '--parse'], supplied) !==
            message.trimEnd().split('\n\n').at(-1)
        )
          throw new Error(
            '--message-file must preserve generated subject and trailers from PR commits',
          );
        message = supplied;
      }
      if (state && state.message !== message)
        throw new Error('merge message changed since delivery started');
      state ??= {
        repo: options.repo,
        pr: options.pr,
        head: pull.head.sha,
        base: pull.base.sha,
        worktree,
        branch: git(worktree, ['branch', '--show-current']),
        message,
      };
      if (
        !state.branch ||
        state.branch === 'main' ||
        state.branch !== pull.head.ref
      )
        throw new Error('local branch must match PR head branch');
      await (runtime.contracts ?? checkMergeContracts)(
        worktree,
        pull.base.sha,
        pull.head.sha,
        message,
        runner,
      );
      if (options.dryRun) {
        // Private temp space keeps dry-run free of repository state.
        const tempDir = mkdtempSync(join(tmpdir(), 'krn-deliver-'));
        const messageFile = join(tempDir, 'merge-message.txt');
        try {
          writeFileSync(messageFile, message);
          const result = runner(
            'krn',
            [
              'ship',
              '--repo',
              options.repo,
              '--pr',
              String(options.pr),
              '--message-file',
              messageFile,
              '--dry-run',
              '--json',
            ],
            main,
          );
          if (result.code === 0)
            return {
              status: 'dry-run',
              head: pull.head.sha,
              message,
              ship: 'ready',
            };
          const refusal = (() => {
            try {
              return JSON.parse(result.stdout);
            } catch {
              return undefined;
            }
          })();
          const reason = refusal?.reason;
          if (
            refusal?.ok === false &&
            typeof reason === 'string' &&
            // Only evidence that later stages produce is pending; failures are not.
            (/^required judge krn\/judge-(?:standards|spec) is (?:missing|pending)$/u.test(
              reason,
            ) ||
              /^no check runs on the exact head$|^check runs: \d+; failing run index \d+ is not completed successfully \(status (?!completed\b)/u.test(
                reason,
              ))
          )
            return {
              status: 'dry-run',
              head: pull.head.sha,
              message,
              ship: `pending: ${reason}`,
            };
          throw new CommandFailure(result);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'review.json'), recordBytes);
    } else if (!state)
      throw new Error('merged PR requires a saved delivery binding');
    if (!state) throw new Error('delivery state unavailable');
    const save = () => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${statePath}.next`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${statePath}.next`, statePath);
    };
    if (options.dryRun)
      return { status: 'dry-run', head: state.head, merged: pull.merged };
    save();
    const waitGate = (head: string, onMain = false) =>
      waitForGate({
        repo: options.repo,
        pr: options.pr,
        head,
        onMain,
        policy: gatePolicy,
        gh: (args) => gh(args, main),
        sleep: wait,
        now,
        pollMs: options.pollMs,
        timeoutMs: options.timeoutMs,
      });
    // Re-bind the reviewed head to GitHub and the worktree before every irreversible step.
    const assertBound = async () => {
      const live = pullSchema.parse(
        JSON.parse(
          await gh(['api', `repos/${options.repo}/pulls/${options.pr}`], main),
        ),
      );
      if (live.head.sha !== state.head || live.base.sha !== pull.base.sha)
        throw new Error('PR moved during delivery; rerun against current base');
      if (git(state.worktree, ['rev-parse', 'HEAD']) !== state.head)
        throw new Error('worktree HEAD differs from the reviewed head');
      return live;
    };
    if (!pull.merged) {
      stage = 'bind';
      await assertBound();
      stage = 'statuses';
      const pages = statusesSchema.parse(
        JSON.parse(
          await gh(
            [
              'api',
              '--method',
              'GET',
              `repos/${options.repo}/commits/${state.head}/statuses?per_page=100`,
              '--paginate',
              '--slurp',
            ],
            main,
          ),
        ),
      );
      const digest = createHash('sha256')
        .update(recordBytes)
        .digest('hex')
        .slice(0, 8);
      for (const role of ['standards', 'spec']) {
        const context = `krn/judge-${role}`;
        if (
          pages.flat().find((status) => status.context === context)?.state ===
          'success'
        )
          continue;
        await assertBound();
        await gh(
          [
            'api',
            '--method',
            'POST',
            `repos/${options.repo}/statuses/${state.head}`,
            '-f',
            `context=${context}`,
            '-f',
            'state=success',
            '-f',
            `description=krn review ${record.override ? 'recorded override' : 'PASS'}; record sha256 ${digest}`,
          ],
          main,
        );
      }
      stage = 'ci';
      await waitGate(state.head);
      stage = 'ship';
      const current = await assertBound();
      if (current.draft)
        await gh(
          ['pr', 'ready', String(options.pr), '--repo', options.repo],
          main,
        );
      const messageFile = join(directory, 'merge-message.txt');
      writeFileSync(messageFile, state.message);
      const args = [
        'ship',
        '--repo',
        options.repo,
        '--pr',
        String(options.pr),
        '--message-file',
        messageFile,
      ];
      // ship may retire the calling worktree: change cwd before invoking it.
      if (!runtime.cwd) process.chdir(main);
      const dry = JSON.parse(
        checked(runner('krn', [...args, '--dry-run', '--json'], main)),
      );
      const dryResult = z
        .object({ head: sha, dryRun: z.literal(true), precheckedTree: sha })
        .parse(dry);
      if (dryResult.head !== state.head)
        throw new Error('ship dry-run head mismatch');
      const result = shipSchema.parse(
        JSON.parse(checked(runner('krn', [...args, '--json'], main))),
      );
      if (result.head !== state.head)
        throw new Error('ship result head mismatch');
      state.merge = result.merge;
      save();
    } else {
      // A saved merge means this delivery saw the PR head gate pass before ship.
      if (!state.merge) {
        stage = 'ci';
        await waitGate(state.head);
      }
      stage = 'ship';
      if (!state.merge) {
        const recovered = shipSchema.parse(
          JSON.parse(
            readFileSync(
              join(main, '.krn', 'runs', 'ship', `pr-${options.pr}.json`),
              'utf8',
            ),
          ),
        );
        if (
          recovered.head !== state.head ||
          recovered.merge !== pull.merge_commit_sha
        )
          throw new Error('ship recovery does not match merged PR');
        state.merge = recovered.merge;
        save();
      }
      if (state.merge !== pull.merge_commit_sha)
        throw new Error('saved merge differs from GitHub merge');
    }
    if (!state.merge) throw new Error('ship did not provide a merge sha');
    if (options.mergeOnly) return { status: 'merged', head: state.merge };
    stage = 'ci';
    // The merge is final: hygiene runs before a main gate failure or timeout is reported.
    let mainConclusion = 'pending';
    let mainFailure: { error: unknown } | undefined;
    try {
      mainConclusion = await waitGate(state.merge, true);
    } catch (error) {
      mainFailure = { error };
    }
    stage = 'hygiene';
    validateHygieneDirectories(main, state.worktree);
    const archive = join(main, '.krn', 'archive');
    mkdirSync(archive, { recursive: true });
    const series = join(main, '.krn', 'runs', 'review-series', key);
    if (existsSync(series))
      renameSync(series, join(archive, `review-series-${key}`));
    if (existsSync(state.worktree)) {
      const head = git(state.worktree, ['rev-parse', 'HEAD']);
      if (head !== state.head)
        throw new Error('refuse to retire a changed worktree');
      const worktreeRuns = join(state.worktree, '.krn', 'runs');
      const worktreeRunsStat = lstatIfPresent(worktreeRuns);
      if (worktreeRunsStat && !worktreeRunsStat.isDirectory())
        throw new Error('worktree .krn/runs is not a real directory');
      if (worktreeRunsStat) {
        const tracked = git(state.worktree, [
          'ls-files',
          '-z',
          '--',
          '.krn/runs',
        ]);
        relocateWorktreeRuns(
          state.worktree,
          main,
          new Set(
            tracked
              .split('\0')
              .filter(Boolean)
              .map((path) => path.slice('.krn/runs/'.length)),
          ),
        );
      }
      if (!runtime.cwd) process.chdir(main);
      // Normal git removal preserves unknown/untracked content and fails closed.
      git(main, ['worktree', 'remove', state.worktree]);
    }
    if (git(main, ['branch', '--show-current']) !== 'main')
      throw new Error('main checkout must be on main');
    git(main, ['fetch', 'origin', 'main']);
    removeIdenticalLeftovers(main);
    git(main, ['merge', '--ff-only', 'origin/main']);
    const branch = runner(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${state.branch}`],
      main,
    );
    if (branch.code === 0) {
      if (git(main, ['rev-parse', `refs/heads/${state.branch}`]) !== state.head)
        throw new Error('refuse to retire a changed branch');
      git(main, ['branch', '-d', '--', state.branch]);
    } else if (branch.code !== 1) checked(branch);
    if (mainFailure) {
      // Saved state stays so a rerun keeps its binding and rechecks the main gate.
      stage = 'ci';
      throw mainFailure.error;
    }
    rmSync(directory, { recursive: true, force: true });
    return {
      status: 'delivered',
      head: state.head,
      merge: state.merge,
      treeMatch: true,
      mainConclusion,
    };
  } catch (error) {
    throw new DeliveryFailure(
      stage === 'ci' && error instanceof GateTimeout ? 'ci-wait' : stage,
      error,
    );
  }
}
