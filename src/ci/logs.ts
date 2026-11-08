import { parseArgs } from 'node:util';
import { z } from 'zod';
import { github, type Runner, run, sleep } from '../deliver/transport.ts';

export const logsUsage =
  'Usage: krn ci logs [--repo <owner/repo>] --run <id> [--lines <n>]; prints the failed steps and log tail of every failed job in every attempt of the run; --repo defaults to the GitHub remote of the current checkout; exits 0 printed, 64 usage, 74 GitHub read failed';

const failed = new Set(['failure', 'timed_out', 'startup_failure']);
const jobsPage = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      conclusion: z.string().nullable(),
      steps: z
        .array(
          z.object({
            name: z.string(),
            number: z.number(),
            conclusion: z.string().nullable(),
          }),
        )
        .default([]),
    }),
  ),
});

export const runAttemptArgs = (repo: string, id: number) => [
  'api',
  `repos/${repo}/actions/runs/${id}`,
  '--jq',
  '.run_attempt',
];
export const attemptJobsArgs = (repo: string, id: number, attempt: number) => [
  'api',
  '--paginate',
  '--slurp',
  `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
];
// A job log carries ANSI colour codes, which gh refuses to print without this flag.
export const jobLogArgs = (repo: string, job: number) => [
  'api',
  '--allow-escape-sequences',
  `repos/${repo}/actions/jobs/${job}/logs`,
];

/**
 * The last `lines` lines of a job log, ending at its last `##[error]` line when
 * one exists, so post-job cleanup does not push the failure out of the tail.
 * Timestamps, the byte-order mark and ANSI escape sequences are dropped.
 */
export function logTail(log: string, lines: number): string[] {
  const text = log
    .replace(/^﻿/u, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes.
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/u, ''));
  while (text.at(-1) === '') text.pop();
  const lastError = text.findLastIndex((line) => line.startsWith('##[error]'));
  const end = lastError === -1 ? text.length : lastError + 1;
  return text.slice(Math.max(0, end - lines), end);
}

export async function logsCommand(
  args: string[],
  runtime: {
    cwd?: string;
    run?: Runner;
    gh?: (args: string[]) => Promise<string>;
  } = {},
): Promise<string> {
  let options: { repo: string; run: number; lines: number };
  try {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        run: { type: 'string' },
        lines: { type: 'string' },
      },
    });
    options = z
      .object({
        // gh api resolves {owner}/{repo} from the current checkout's remote.
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/u)
          .default('{owner}/{repo}'),
        run: z
          .string()
          .regex(/^\d+$/u)
          .transform(Number)
          .pipe(z.number().int().positive().safe()),
        lines: z.coerce.number().int().positive().max(10000),
      })
      .parse({ ...values, lines: values.lines ?? '40' });
  } catch {
    throw Object.assign(new Error(logsUsage), { exitCode: 64 });
  }
  const cwd = runtime.cwd ?? process.cwd();
  const gh =
    runtime.gh ??
    ((args: string[]) => github(args, cwd, runtime.run ?? run, sleep));
  const read = async (request: string[]) => {
    try {
      return await gh(request);
    } catch (error) {
      throw Object.assign(
        new Error(
          `gh ${request.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { exitCode: 74 },
      );
    }
  };
  const { repo, run: id, lines } = options;
  const attempts = z.coerce
    .number()
    .int()
    .positive()
    .parse((await read(runAttemptArgs(repo, id))).trim());
  const out: string[] = [];
  let count = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pages = z
      .array(jobsPage)
      .parse(JSON.parse(await read(attemptJobsArgs(repo, id, attempt))));
    for (const job of pages.flatMap((page) => page.jobs)) {
      if (!failed.has(job.conclusion ?? '')) continue;
      count++;
      const steps = job.steps
        .filter((step) => failed.has(step.conclusion ?? ''))
        .map((step) => `step ${step.number} ${step.name}`);
      out.push(
        `== attempt ${attempt} job ${job.id} ${job.name}: ${job.conclusion}; failed ${steps.length ? steps.join(', ') : 'step unknown'}`,
      );
      try {
        out.push(...logTail(await gh(jobLogArgs(repo, job.id)), lines));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        out.push(`log unavailable: ${reason.split('\n')[0]}`);
      }
    }
  }
  out.unshift(
    `run ${id}: ${attempts} attempt${attempts === 1 ? '' : 's'}, ${count} failed job${count === 1 ? '' : 's'}`,
  );
  return out.join('\n');
}
