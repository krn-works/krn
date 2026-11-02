// Read and select the required gate run for an exact PR head.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  type GateAdmissionPolicy,
  matchesGateCheckRun,
} from '../deliver/admission-policy.ts';

const conclusionSchema = z
  .enum([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'success',
    'timed_out',
  ])
  .nullable();

const checkRunSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    head_sha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu),
    status: z.enum([
      'completed',
      'in_progress',
      'pending',
      'queued',
      'requested',
      'waiting',
    ]),
    app: z
      .object({
        id: z.number().int().positive().optional(),
        slug: z.string().min(1).optional(),
      })
      .nullable(),
    conclusion: conclusionSchema,
    started_at: z.string().datetime().nullable(),
    html_url: z.string().url().nullable(),
  })
  .refine(
    ({ status, conclusion }) =>
      status === 'completed' ? conclusion !== null : conclusion === null,
    'status and conclusion do not agree',
  );

// Every run on the commit is read leniently; only the runs the base policy
// selects are held to the strict shape, so an unrelated app cannot block review.
const listedCheckRunSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    head_sha: z.string(),
    app: z
      .object({
        id: z.number().optional(),
        slug: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const checkRunPageSchema = z.object({
  check_runs: z.array(listedCheckRunSchema),
});
const slurpedCheckRunsSchema = z.array(checkRunPageSchema);

export type ReviewGateCheckRun = z.infer<typeof checkRunSchema>;
export type ListedGateCheckRun = z.infer<typeof listedCheckRunSchema>;
export type GateCheckRunReader = (
  repository: string,
  headSha: string,
) => Promise<ListedGateCheckRun[]> | ListedGateCheckRun[];

export class GateCheckReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateCheckReadError';
  }
}

const execFileAsync = promisify(execFile);

function ghSpawnFailure(error: unknown): GateCheckReadError {
  if (error instanceof Error && 'code' in error) {
    const code = error.code;
    if (code === 'ENOENT')
      return new GateCheckReadError('gh executable was not found');
    if (code === 'ETIMEDOUT')
      return new GateCheckReadError('gh command timed out');
    if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return new GateCheckReadError('gh response exceeded its size limit');
    if (typeof code === 'number')
      return new GateCheckReadError(`gh command exited with status ${code}`);
  }
  return new GateCheckReadError('gh command could not be started');
}

/** Parse the exact JSON shape emitted by `gh api --paginate --slurp`. */
export function parseGateCheckRuns(response: string): ListedGateCheckRun[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(response);
  } catch {
    throw new GateCheckReadError('response is not valid JSON');
  }
  const parsed = slurpedCheckRunsSchema.safeParse(decoded);
  if (!parsed.success)
    throw new GateCheckReadError('response has an invalid check-runs shape');
  return parsed.data.flatMap((page) => page.check_runs);
}

export async function readGateCheckRunsFromGitHub(
  repository: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<ListedGateCheckRun[]> {
  let response: string;
  try {
    ({ stdout: response } = await execFileAsync(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100`,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw ghSpawnFailure(error);
  }
  return parseGateCheckRuns(response);
}

export function latestMatchingGateCheckRun(
  checkRuns: readonly ListedGateCheckRun[],
  headSha: string,
  policy: GateAdmissionPolicy,
): ReviewGateCheckRun | undefined {
  return checkRuns
    .filter((check) =>
      matchesGateCheckRun(
        { name: check.name, head_sha: check.head_sha, app: check.app ?? null },
        headSha,
        policy,
      ),
    )
    .map((check) => {
      const strict = checkRunSchema.safeParse(check);
      if (!strict.success)
        throw new GateCheckReadError(
          'matching gate check run has an invalid shape',
        );
      return strict.data;
    })
    .reduce<ReviewGateCheckRun | undefined>((latest, candidate) => {
      if (!latest) return candidate;
      const latestStartedAt =
        latest.started_at === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(latest.started_at);
      const candidateStartedAt =
        candidate.started_at === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(candidate.started_at);
      return candidateStartedAt > latestStartedAt ||
        (candidateStartedAt === latestStartedAt && candidate.id > latest.id)
        ? candidate
        : latest;
    }, undefined);
}
