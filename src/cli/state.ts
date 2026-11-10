import { collectWindow, renderWindow } from '../outcome/window.ts';
import { inspectState } from '../state/check.ts';
import { resumeBrief } from '../state/resume.ts';
import { renderRetro } from '../state/retro.ts';
import {
  acceptCriterion,
  capsuleDirectory,
  setFields,
  writeHandoff,
} from '../state/write.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

const usage =
  'krn state check|resume [--root DIR] [--json]  capsule check (one verdict line) and resume\n' +
  'krn state set <field> <value> [<field> <value>...] [--capsule ID] [--root DIR]  write capsule fields\n' +
  'krn state accept <criterion> todo|pass|drop:<why> [--capsule ID] [--root DIR]  upsert an acceptance ledger entry\n' +
  'krn state handoff [--task ID] [--sha TEXT] [--verify CMD] [--roadmap TEXT] [--request TEXT]... [--priority TEXT]... [--capsule ID] [--root DIR]  regenerate handoff.md (Resume, Merged since the previous SHA)\n' +
  'krn state retro --task ID [--root DIR]  print the retro skeleton: commits, wall time and PRs naming the task, one line per candidate category';

const VALUE_FLAGS = [
  '--capsule',
  '--task',
  '--sha',
  '--verify',
  '--roadmap',
  '--request',
  '--priority',
];

function writeCommand(command: string, args: string[]): void {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--root' || VALUE_FLAGS.includes(arg)) {
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
      const labels = setFields(directory, pairs);
      process.stdout.write(
        `set ${labels.length} field(s): ${labels.join('; ')}\n`,
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
        roadmap: one('--roadmap'),
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
  if (verb === 'retro') {
    let task: string | undefined;
    let root: string | undefined;
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg !== '--task' && arg !== '--root') throw new CliUsageError(usage);
      const value = flagValue(
        rest,
        index,
        () => new CliUsageError(`${arg} requires a value`),
      );
      if (arg === '--task') task = value;
      else root = value;
      index += 1;
    }
    if (!task) throw new CliUsageError(usage);
    try {
      const text = await renderRetro(
        root ?? process.cwd(),
        task,
        async (from, to, main) =>
          renderWindow(await collectWindow({ from, to, root: main })),
      );
      process.stdout.write(`${text}\n`);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (verb === 'set' || verb === 'accept' || verb === 'handoff') {
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
    report = command === 'check' ? inspectState(repo) : resumeBrief(repo);
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
