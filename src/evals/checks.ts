import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue } from '../cli/flag-value.ts';
import { CliUsageError } from '../cli/usage-error.ts';
import { checkDirectory, checkNode, separate } from './check-paths.ts';
import { writeCheckTools } from './check-shims.ts';
import { EvalDataError, loadManifest, wozManifest } from './manifest.ts';

const usage =
  'usage: krn eval check --experiment <dir> --task <id> --slot <dir> --check focused|suite:<index> [--draft] [--timeout <seconds>] [--json]';
const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

function parse(args: string[]) {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      !option ||
      ![
        '--experiment',
        '--task',
        '--slot',
        '--check',
        '--draft',
        '--timeout',
        '--json',
      ].includes(option)
    )
      throw new CliUsageError(`unknown check option ${option}; ${usage}`);
    if (seen.has(option))
      throw new CliUsageError(`${option} may be supplied once`);
    seen.add(option);
    if (option === '--draft' || option === '--json') continue;
    const value = flagValue(args, index++, () => new CliUsageError(usage));
    if (value === '') throw new CliUsageError(usage);
    values.set(option, value);
  }
  const experiment = values.get('--experiment');
  const task = values.get('--task');
  const slot = values.get('--slot');
  const check = values.get('--check');
  if (!experiment || !task || !slot || !check) throw new CliUsageError(usage);
  const seconds = values.get('--timeout') ?? '900';
  const timeout = Number(seconds);
  // Node timers cap delays at a signed 32-bit number of milliseconds.
  if (
    !/^\d+(?:\.\d+)?$/u.test(seconds) ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout * 1000 > 2_147_483_647
  )
    throw new CliUsageError(
      'timeout must be positive and at most 2147483.647 seconds',
    );
  return {
    experiment,
    task,
    slot,
    check,
    timeout,
    draft: seen.has('--draft'),
    json: seen.has('--json'),
  };
}

async function captureMask(args: string[], timeout: number) {
  return new Promise<{
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'eval', 'mask', ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
    child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            reject(error);
        }
      }
    }, timeout * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 128 + constants.signals[signal] : 70),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
      });
    });
  });
}

function counts(stdout: Buffer) {
  const totals = { tests: 0, pass: 0, fail: 0 };
  const summaries = { tests: 0, pass: 0, fail: 0 };
  const text = stdout.toString('utf8');
  // Node 24 reports a synthetic passing file test after an empty selection's
  // top-level 1..0 plan. Keep the requested raw summary sums, but do not count
  // those wrappers as executed tests when deciding whether GREEN is empty.
  const emptyFiles = [...text.matchAll(/^1\.\.0\r?\n# Subtest: /gmu)].length;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail) (\d+)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === 'tests' || key === 'pass' || key === 'fail') {
      totals[key] += Number(match[2]);
      summaries[key] += 1;
    }
  }
  return {
    totals,
    executed: totals.pass - emptyFiles,
    complete:
      summaries.tests > 0 &&
      summaries.tests === summaries.pass &&
      summaries.pass === summaries.fail &&
      Object.values(totals).every(Number.isSafeInteger),
  };
}

export async function checkCommand(args: string[]): Promise<void> {
  const options = parse(args);
  const manifest = wozManifest(await loadManifest(options.experiment));
  if (!manifest.frozen && !options.draft)
    throw new EvalDataError(
      'experiment must be frozen; use --draft to run draft checks',
    );
  const task = manifest.tasks.find((task) => task.id === options.task);
  if (!task) throw new EvalDataError(`unknown task: ${options.task}`);
  let check: { argv: string[]; tests: boolean } | undefined;
  if (options.check === 'focused')
    check = { argv: task.focusedCheck, tests: true };
  else {
    const match = /^suite:(0|[1-9]\d*)$/u.exec(options.check);
    check = match ? task.suiteChecks[Number(match[1])] : undefined;
    if (!check)
      throw new CliUsageError(`unknown check: ${options.check}; ${usage}`);
  }
  if (!isAbsolute(options.slot))
    throw new EvalDataError('slot must be absolute');
  const slot = await checkDirectory(options.slot);
  const experiment = await checkDirectory(options.experiment);
  separate(slot, experiment);
  await checkDirectory(join(slot, 'repo', task.workingDirectory));
  // Validate these before mask creates either of them. Existing symlinks in
  // any component must never cause writes outside the slot.
  for (const name of ['home', 't']) {
    try {
      await checkDirectory(join(slot, name));
    } catch (error) {
      if (!(error instanceof EvalDataError && error.message.includes('ENOENT')))
        throw error;
    }
  }
  const bin = await checkNode(task.node, [slot, experiment]);
  const root =
    process.env.TMPDIR ??
    fileURLToPath(new URL('../../.krn/tmp', import.meta.url));
  // mkdir only the evaluator's default state area; a caller-provided TMPDIR
  // must already exist and must be separate in both containment directions.
  for (const protectedPath of [
    slot,
    experiment,
    bin,
    '/w',
    '/tmp',
    '/proc',
    '/dev',
    '/usr',
    '/etc',
  ])
    separate(resolve(root), protectedPath);
  const scratch = await checkDirectory(root, !process.env.TMPDIR);
  let tools: string;
  try {
    tools = await mkdtemp(join(scratch, 'check-tools-'));
  } catch (error) {
    throw new EvalDataError(
      `evaluator directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    try {
      await writeCheckTools(tools, join(bin, 'node'), task.scripts);
    } catch (error) {
      throw new EvalDataError(
        `evaluator tools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const marker = `krn-check-start:${randomBytes(24).toString('hex')}\n`;
    const result = await captureMask(
      [
        '--slot',
        slot,
        '--tool',
        tools,
        '--tool',
        bin,
        '--',
        join(bin, 'node'),
        join(tools, 'runner.mjs'),
        marker,
        `/w/repo${task.workingDirectory === '.' ? '' : `/${task.workingDirectory}`}`,
        [tools, bin, '/usr/bin'].join(':'),
        ...check.argv,
      ],
      options.timeout,
    );
    const prefix = Buffer.from(marker);
    const started = result.stderr.subarray(0, prefix.length).equals(prefix);
    if (!started && !result.timedOut)
      throw new Error(
        `check mask failed (exit ${result.exitCode}): ${result.stderr.toString('utf8').trimEnd()}`,
      );
    const stderr = started
      ? result.stderr.subarray(prefix.length)
      : result.stderr;
    const { totals, complete, executed } = counts(result.stdout);
    const reason = result.timedOut
      ? 'timeout'
      : result.exitCode !== 0
        ? `exit ${result.exitCode}`
        : check.tests && totals.fail > 0
          ? `${totals.fail} failed`
          : check.tests && (!complete || totals.tests < 1 || executed < 1)
            ? 'no tests executed'
            : null;
    const hash = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    const output = {
      status: reason === null ? 'PASS' : 'FAIL',
      reason,
      exitCode: result.exitCode,
      ...totals,
      stdoutSha256: hash(result.stdout),
      stderrSha256: hash(stderr),
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ ok: true, ...output }, null, 2)}\n`
        : `${output.status}${reason ? `: ${reason}` : ''}\nexit ${output.exitCode}; tests ${output.tests}; pass ${output.pass}; fail ${output.fail}\nstdout sha256 ${output.stdoutSha256}\nstderr sha256 ${output.stderrSha256}\n`,
    );
  } finally {
    await rm(tools, { recursive: true, force: true });
  }
}
