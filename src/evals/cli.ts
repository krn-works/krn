import { commandErrorExitCode } from '../cli/command-error.ts';
import { CliUsageError } from '../cli/usage-error.ts';
import { EvalDataError, loadManifest } from './manifest.ts';
import { planExperiment } from './plan.ts';

const usage = 'usage: krn eval plan --experiment <dir> [--draft] [--json]';

export async function evalCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const options = parse(args);
    const plan = planExperiment(
      await loadManifest(options.experiment),
      options,
    );
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

function parse(args: string[]): { experiment: string; draft: boolean } {
  if (args[0] !== 'plan') throw new CliUsageError(usage);
  const seen = new Set<string>();
  let experiment: string | undefined;
  let draft = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (
      option !== '--experiment' &&
      option !== '--draft' &&
      option !== '--json'
    )
      throw new CliUsageError(`unknown eval plan option "${option}"; ${usage}`);
    if (seen.has(option))
      throw new CliUsageError(`${option} may be supplied once`);
    seen.add(option);
    if (option === '--draft') draft = true;
    if (option === '--experiment') {
      experiment = args[++index];
      if (!experiment || experiment.startsWith('--'))
        throw new CliUsageError(`missing value for --experiment; ${usage}`);
    }
  }
  if (experiment === undefined) throw new CliUsageError(usage);
  return { experiment, draft };
}
