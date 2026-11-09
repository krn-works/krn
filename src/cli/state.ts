import { inspectState } from '../state/check.ts';
import { resumeBrief } from '../state/resume.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

const usage =
  'krn state check|resume [--root DIR] [--json]  capsule check and resume';

function line(value: { rule: string; detail: string }): string {
  return [value.rule, value.detail].filter(Boolean).join(': ');
}

export function stateCommand(args: string[]): void {
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
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const warning of report.warnings)
    process.stderr.write(`warning: ${line(warning)}\n`);
  for (const error of report.errors)
    process.stderr.write(`error: ${line(error)}\n`);
  if (report.errors.length > 0 || report.status === 'divergent')
    process.exitCode = 1;
}
