import { join } from 'node:path';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { configHome } from '../harness/claude.ts';
import { collectWindow, renderWindow } from '../outcome/window.ts';
import { inspectState } from '../state/check.ts';
import { applyTidy, planTidy } from '../state/layout.ts';
import { resumeBrief } from '../state/resume.ts';
import { renderRetro } from '../state/retro.ts';
import { renderRetroCauses } from '../state/retro-causes.ts';
import { resolveRepositoryRoot } from '../state/runs.ts';
import {
  acceptCriterion,
  addCleanup,
  capsuleDirectory,
  setFields,
  writeHandoff,
  writeRunIndex,
} from '../state/write.ts';
import { releaseClosedClaims } from '../task/claims.ts';
import { readReviewComments } from './retro-review.ts';

const usage =
  'krn state check|resume [--root DIR] [--json]  capsule check (one verdict line) and resume\n' +
  'krn state set <field> <value> [<field> <value>...] [--replace] [--capsule ID] [--root DIR]  write capsule fields; a cleanup value that drops existing entries needs --replace\n' +
  'krn state add-cleanup <pointer; workflow; consumer; trigger; STATE> [--capsule ID] [--root DIR]  append one cleanup entry\n' +
  'krn state index [--capsule ID] [--root DIR]  write the run index file listing every run and point the capsule at it\n' +
  'krn state accept <criterion> todo|pass|drop:<why> [--capsule ID] [--root DIR]  upsert an acceptance ledger entry\n' +
  'krn state handoff [--task ID] [--sha TEXT] [--verify CMD] [--request TEXT]... [--priority TEXT]... [--capsule ID] [--root DIR]  regenerate handoff.md (Resume, Merged since the previous SHA)\n' +
  'krn state tidy [--dry-run] [--root DIR]  move entries outside the .krn/ layout to .krn/tmp/stray, delete data past retention, regenerate .krn/INDEX.md; --dry-run only prints\n' +
  'krn state retro [--task ID] [--sessions N] [--root DIR]  print the retro skeleton (commits, wall time and PRs naming the task, one line per candidate category) and, with --sessions, the ranked recurring causes from the last N session transcripts and krn-review comments';

const VALUE_FLAGS = [
  '--capsule',
  '--task',
  '--sha',
  '--verify',
  '--request',
  '--priority',
];

function writeCommand(command: string, args: string[]): void {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--replace') flags.set(arg, ['true']);
    else if (arg === '--root' || VALUE_FLAGS.includes(arg)) {
      const value = flagValue(
        args,
        index,
        () => new CliUsageError(`${arg} requires a value`),
      );
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
      index += 1;
    } else if (arg.startsWith('--')) throw new CliUsageError(usage);
    else positional.push(arg);
  }
  const one = (name: string) => flags.get(name)?.at(-1);
  try {
    const directory = capsuleDirectory(
      one('--root') ?? process.cwd(),
      one('--capsule'),
    );
    if (command === 'set') {
      if (positional.length === 0 || positional.length % 2 !== 0)
        throw new CliUsageError(usage);
      const pairs: [string, string][] = [];
      for (let at = 0; at < positional.length; at += 2)
        pairs.push([positional[at] as string, positional[at + 1] as string]);
      const labels = setFields(directory, pairs, {
        replace: flags.has('--replace'),
      });
      process.stdout.write(
        `set ${labels.length} field(s): ${labels.join('; ')}\n`,
      );
    } else if (command === 'add-cleanup') {
      if (positional.length !== 1) throw new CliUsageError(usage);
      process.stdout.write(
        `added cleanup entry: ${addCleanup(directory, positional[0] as string)}\n`,
      );
    } else if (command === 'index') {
      if (positional.length > 0) throw new CliUsageError(usage);
      process.stdout.write(
        `wrote run index: ${writeRunIndex(one('--root') ?? process.cwd(), directory)}\n`,
      );
    } else if (command === 'accept') {
      if (positional.length !== 2) throw new CliUsageError(usage);
      const items = acceptCriterion(
        directory,
        positional[0] as string,
        positional[1] as string,
      );
      process.stdout.write(
        `acceptance ledger: ${items.length} entr${items.length === 1 ? 'y' : 'ies'}\n`,
      );
    } else {
      if (positional.length > 0) throw new CliUsageError(usage);
      const file = writeHandoff(one('--root') ?? process.cwd(), directory, {
        task: one('--task'),
        sha: one('--sha'),
        verify: one('--verify'),
        requests: flags.get('--request') ?? [],
        priorities: flags.get('--priority') ?? [],
      });
      process.stdout.write(`wrote ${file}\n`);
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function line(value: { rule: string; detail: string }): string {
  return [value.rule, value.detail].filter(Boolean).join(': ');
}

function checkVerdict(report: ReturnType<typeof inspectState>): string {
  const ids = report.capsules.map((capsule) => capsule.id).join(', ');
  return `state ${report.status}: ${report.capsules.length} capsule(s)${ids ? ` (${ids})` : ''}, ${report.errors.length} error(s), ${report.warnings.length} warning(s)`;
}

export async function stateCommand(args: string[]): Promise<void> {
  const verb = args[0];
  if (verb === 'tidy') {
    let dryRun = false;
    let root: string | undefined;
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg === '--dry-run') dryRun = true;
      else if (arg === '--root') {
        root = flagValue(
          rest,
          index,
          () => new CliUsageError('--root requires a value'),
        );
        index += 1;
      } else throw new CliUsageError(usage);
    }
    const directory = join(
      resolveRepositoryRoot(root ?? process.cwd()).root,
      '.krn',
    );
    const plan = dryRun ? planTidy(directory) : applyTidy(directory);
    const past = dryRun ? 'would move' : 'moved';
    for (const move of plan.moves)
      process.stdout.write(`${past} .krn/${move.from} -> .krn/${move.to}\n`);
    for (const item of plan.deletes)
      process.stdout.write(
        `${dryRun ? 'would delete' : 'deleted'} .krn/${item.path} (${item.reason})\n`,
      );
    process.stdout.write(
      `tidy${dryRun ? ' --dry-run' : ''}: ${plan.moves.length} stray(s), ${plan.deletes.length} expired, ${plan.bytes} bytes\n`,
    );
    return;
  }
  if (verb === 'retro') {
    let task: string | undefined;
    let root: string | undefined;
    let sessions: string | undefined;
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg !== '--task' && arg !== '--root' && arg !== '--sessions')
        throw new CliUsageError(usage);
      const value = flagValue(
        rest,
        index,
        () => new CliUsageError(`${arg} requires a value`),
      );
      if (arg === '--task') task = value;
      else if (arg === '--sessions') sessions = value;
      else root = value;
      index += 1;
    }
    if (!task && !sessions) throw new CliUsageError(usage);
    if (sessions !== undefined && !/^[1-9]\d*$/.test(sessions))
      throw new CliUsageError('--sessions requires a positive integer');
    try {
      const skeleton = task
        ? await renderRetro(
            root ?? process.cwd(),
            task,
            async (from, to, main) =>
              renderWindow(await collectWindow({ from, to, root: main })),
          )
        : undefined;
      const causes =
        sessions === undefined
          ? undefined
          : renderRetroCauses(
              resolveRepositoryRoot(root ?? process.cwd()).root,
              Number(sessions),
              join(configHome(), 'projects'),
              readReviewComments(
                resolveRepositoryRoot(root ?? process.cwd()).root,
                30,
              ),
            );
      process.stdout.write(
        `${[causes, skeleton].filter(Boolean).join('\n\n')}\n`,
      );
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (
    verb === 'set' ||
    verb === 'add-cleanup' ||
    verb === 'index' ||
    verb === 'accept' ||
    verb === 'handoff'
  ) {
    writeCommand(verb, args.slice(1));
    return;
  }
  let root: string | undefined;
  let json = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--json') json = true;
    else if (arg === '--root') {
      const value = flagValue(
        args,
        index,
        () => new CliUsageError('--root requires a value'),
      );
      if (root !== undefined) throw new CliUsageError('--root given twice');
      root = value;
      index += 1;
    } else if (arg.startsWith('--')) throw new CliUsageError(usage);
    else positional.push(arg);
  }
  const [command, target] = positional;
  if (
    (command !== 'check' && command !== 'resume') ||
    positional.length > 2 ||
    (root !== undefined && target !== undefined)
  )
    throw new CliUsageError(usage);
  const repo = root ?? target ?? process.cwd();
  let report: ReturnType<typeof inspectState> | ReturnType<typeof resumeBrief>;
  try {
    report =
      command === 'check'
        ? inspectState(repo, releaseClosedClaims)
        : resumeBrief(repo);
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (command === 'resume' && !json && 'text' in report)
    process.stdout.write(`${report.text}\n`);
  else if (!json && !('text' in report))
    // One verdict line; errors and warnings follow on stderr, --json keeps the full report.
    process.stdout.write(`${checkVerdict(report)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const warning of report.warnings)
    process.stderr.write(`warning: ${line(warning)}\n`);
  for (const error of report.errors)
    process.stderr.write(`error: ${line(error)}\n`);
  if (report.errors.length > 0 || report.status === 'divergent')
    process.exitCode = 1;
}
