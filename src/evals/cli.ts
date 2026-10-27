import { commandErrorExitCode } from '../cli/command-error.ts';
import { CliUsageError } from '../cli/usage-error.ts';
import { EvalDataError, loadManifest } from './manifest.ts';
import { maskCommand } from './mask.ts';
import { planExperiment } from './plan.ts';
import { sessionCommand } from './session.ts';
import { prepareExperiment } from './workspace.ts';

const usages = {
  plan: 'usage: krn eval plan --experiment <dir> [--draft] [--json]',
  prepare:
    'usage: krn eval prepare --experiment <dir> --root <dir> --source <repository>=<path>... [--draft] [--json]',
  mask: 'usage: krn eval mask --slot <dir> [--network] [--tool <dir>]... [--credential <file>=</w/path>]... -- <command> [args…]',
};

export async function evalCommand(args: string[]): Promise<void> {
  // A wrapped command owns every argument after "--", including "--json".
  const json = args[0] !== 'mask' && args.includes('--json');
  try {
    if (args[0] === 'session') {
      await sessionCommand(args.slice(1));
      return;
    }
    if (args[0] === 'mask') {
      process.exitCode = await maskCommand(parseMask(args.slice(1)));
      return;
    }
    const options = parse(args);
    const manifest = await loadManifest(options.experiment);
    if (options.command === 'prepare') {
      const prepared = await prepareExperiment(manifest, options);
      process.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, ...prepared }, null, 2)}\n`
          : [
              prepared.experiment,
              'task\tbase\tobject count\tpath',
              ...prepared.tasks.map(
                (task) =>
                  `${task.id}\t${task.base}\t${task.objectCount}\t${task.path}`,
              ),
              '',
            ].join('\n'),
      );
      return;
    }
    const plan = planExperiment(manifest, options);
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, ...plan }, null, 2)}\n`
        : [
            `${plan.experiment} (${plan.draft ? 'draft' : 'frozen'})`,
            'task\treplica\tarm\trun id',
            ...plan.runs.map(
              (run) => `${run.task}\t${run.replica}\t${run.arm}\t${run.runId}`,
            ),
            '',
          ].join('\n'),
    );
  } catch (error) {
    const code =
      error instanceof CliUsageError || error instanceof EvalDataError
        ? commandErrorExitCode(error)
        : 70;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (json)
      process.stdout.write(
        `${JSON.stringify({ ok: false, code, error: message }, null, 2)}\n`,
      );
    process.exitCode = code;
  }
}

function value(args: string[], index: number, usage: string): string {
  const result = args[index + 1];
  if (!result || result.startsWith('--'))
    throw new CliUsageError(`missing value for ${args[index]}; ${usage}`);
  return result;
}

type ExperimentOptions = { experiment: string; draft: boolean };
type SourceOption = { label: string; path: string };
type EvalOptions = ExperimentOptions &
  (
    | { command: 'plan' }
    | { command: 'prepare'; root: string; sources: SourceOption[] }
  );

function sourceOption(value: string, usage: string): SourceOption {
  const delimiter = value.indexOf('=');
  const label = value.slice(0, delimiter);
  const path = value.slice(delimiter + 1);
  if (delimiter < 1 || path === '')
    throw new CliUsageError(`--source requires <repository>=<path>; ${usage}`);
  return { label, path };
}

function parse(args: string[]): EvalOptions {
  const command = args[0];
  if (command !== 'plan' && command !== 'prepare')
    throw new CliUsageError(Object.values(usages).join('\n'));
  const usage = usages[command];
  const seen = new Set<string>();
  let experiment: string | undefined;
  let root: string | undefined;
  const sources: SourceOption[] = [];
  let draft = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (
      option !== '--experiment' &&
      option !== '--draft' &&
      option !== '--json' &&
      !(command === 'prepare' && (option === '--root' || option === '--source'))
    )
      throw new CliUsageError(
        `unknown eval ${command} option "${option}"; ${usage}`,
      );
    if (option !== '--source' && seen.has(option))
      throw new CliUsageError(`${option} may be supplied once`);
    seen.add(option);
    if (option === '--draft') draft = true;
    if (option === '--experiment') experiment = value(args, index++, usage);
    if (option === '--root') root = value(args, index++, usage);
    if (option === '--source')
      sources.push(sourceOption(value(args, index++, usage), usage));
  }
  if (experiment === undefined) throw new CliUsageError(usage);
  if (command === 'prepare') {
    if (root === undefined) throw new CliUsageError(usage);
    return { command, experiment, root, sources, draft };
  }
  return { command, experiment, draft };
}

function parseMask(args: string[]) {
  const usage = usages.mask;
  let slot: string | undefined;
  let network = false;
  const tools: string[] = [];
  const credentials: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--') {
      const command = args.slice(index + 1);
      if (slot === undefined || !command[0]) throw new CliUsageError(usage);
      return { slot, network, tools, credentials, command };
    }
    if (
      option !== '--slot' &&
      option !== '--network' &&
      option !== '--tool' &&
      option !== '--credential'
    )
      throw new CliUsageError(`unknown eval mask option "${option}"; ${usage}`);
    if (option !== '--tool' && option !== '--credential' && seen.has(option))
      throw new CliUsageError(`${option} may be supplied once`);
    seen.add(option);
    if (option === '--slot') slot = value(args, index++, usage);
    if (option === '--network') network = true;
    if (option === '--tool') tools.push(value(args, index++, usage));
    if (option === '--credential')
      credentials.push(value(args, index++, usage));
  }
  throw new CliUsageError(usage);
}
