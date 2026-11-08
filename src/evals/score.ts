import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { flagValue } from '../cli/flag-value.ts';
import { CliUsageError } from '../cli/usage-error.ts';
import { EvalDataError, fr40Manifest, loadManifest } from './manifest.ts';
import { planExperiment } from './plan.ts';

const usage =
  'usage: krn eval score --experiment <dir> --root <dir> --run <runId> --slot <dir> [--draft] [--json]';

export type ScoreRecord = {
  readonly runId: string;
  readonly task: string;
  readonly arm: string;
  readonly replica: number;
  /** pass/fail from the scorer's exit 0/1; error for any other exit or a launch failure. */
  readonly status: 'pass' | 'fail' | 'error';
  readonly exitCode: number | null;
  readonly reason: string;
};

/** Where `krn eval session` writes a run's evidence; the score lands beside session.json. */
export function runDirectory(root: string, experiment: string, runId: string) {
  return join(root, experiment, 'runs', runId);
}

function parse(args: readonly string[]) {
  const values = new Map<string, string>();
  let draft = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index] ?? '';
    if (option === '--draft') draft = true;
    else if (option === '--json') json = true;
    else if (['--experiment', '--root', '--run', '--slot'].includes(option)) {
      if (values.has(option))
        throw new CliUsageError(`${option} may be supplied once`);
      values.set(
        option,
        flagValue(
          [...args],
          index++,
          () => new CliUsageError(`missing value for ${option}; ${usage}`),
        ),
      );
    } else
      throw new CliUsageError(
        `unknown eval score option "${option}"; ${usage}`,
      );
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new CliUsageError(usage);
    return value;
  };
  return {
    experiment: required('--experiment'),
    root: required('--root'),
    run: required('--run'),
    slot: required('--slot'),
    draft,
    json,
  };
}

/** Run the manifest's scorer against the slot's repository after the session and record the verdict. */
export async function scoreCommand(args: string[]): Promise<void> {
  const options = parse(args);
  const manifest = fr40Manifest(await loadManifest(options.experiment));
  const run = planExperiment(manifest, options).runs.find(
    (candidate) => candidate.runId === options.run,
  );
  if (!run) throw new EvalDataError(`unknown run id: ${options.run}`);
  const fields: Record<string, string> = {
    experiment: resolve(options.experiment),
    repo: resolve(options.slot, 'repo'),
    task: run.task,
  };
  const [command = '', ...rest] = manifest.check.map((part) =>
    part.replace(/\{(experiment|repo|task)\}/gu, (_, key: string) => {
      return fields[key] ?? '';
    }),
  );
  const result = spawnSync(
    command === 'node' ? process.execPath : command,
    rest,
    { encoding: 'utf8', maxBuffer: 1 << 20 },
  );
  const exitCode = result.status;
  const status =
    result.error === undefined && exitCode === 0
      ? 'pass'
      : result.error === undefined && exitCode === 1
        ? 'fail'
        : 'error';
  const reason = (
    result.error?.message ?? `${result.stdout}${result.stderr}`
  ).trim();
  const record: ScoreRecord = {
    runId: run.runId,
    task: run.task,
    arm: run.arm,
    replica: run.replica,
    status,
    exitCode,
    reason,
  };
  const output = runDirectory(options.root, manifest.id, run.runId);
  await mkdir(output, { recursive: true });
  try {
    await writeFile(
      join(output, 'score.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: 'wx' },
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new EvalDataError(`${run.runId}: already scored`);
    throw error;
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ ok: status !== 'error', ...record }, null, 2)}\n`
      : `${run.runId}: ${status} ${run.task} ${run.arm}\n`,
  );
  if (status === 'error') process.exitCode = 70;
}
