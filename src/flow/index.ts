// Compose red-first evidence, independent panel sessions, and their bound record.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type GateAdmissionPolicy,
  gateAdmissionPolicyFromBase,
} from '../deliver/admission-policy.ts';
import {
  GateCheckReadError,
  type GateCheckRunReader,
  latestMatchingGateCheckRun,
  type ReviewGateCheckRun,
  readGateCheckRunsFromGitHub,
} from './gate-admission.ts';
import { judgeRole, ReviewAbortedError } from './panel.ts';
import { loadPriorReview } from './prior.ts';
import { writeReviewRecord } from './record.ts';
import {
  git,
  type RedFirstReport,
  redFirst,
  repoRoot,
  resolveCommit,
  validateSha,
} from './repository.ts';
import {
  checkReviewBudget,
  type PullReader,
  readPullRequest,
  reserveReviewAttempt,
  verifyPullRequest,
} from './series.ts';
import {
  deterministicCauses,
  type NewReviewRecord,
  newReviewRecordSchema,
  panelRoles,
  type ReviewInput,
  type ReviewReasoningEffort,
  type ReviewRecord,
  type ReviewRole,
  reviewInputSchema,
  roleSchema,
  startTiming,
} from './types.ts';

export class ReviewAdmissionError extends Error {
  constructor(
    causes: ReturnType<typeof deterministicCauses>,
    refusal = 'deterministic checks failed',
  ) {
    const sanitize = (value: string) =>
      value
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/gu, ' ')
        .slice(0, 200);
    const lines = causes
      .slice(0, 20)
      .map(({ verdict, path, commit, cause }) => {
        const safePath = sanitize(path);
        const safeCommit = commit === undefined ? undefined : sanitize(commit);
        const safeCause = sanitize(cause);
        return `${verdict} ${safePath}${safeCommit === undefined ? '' : `@${safeCommit}`}: ${safeCause}`;
      });
    if (causes.length > 20) lines.push(`+${causes.length - 20} more`);
    super(
      [`review refused before reserving an attempt: ${refusal}`, ...lines].join(
        '\n',
      ),
    );
    this.name = 'ReviewAdmissionError';
  }
}

export function aggregatePanelVerdict(
  judges: readonly ReviewRecord['judges'][number][],
  panelPartial: boolean,
  evidence?: Pick<RedFirstReport, 'results' | 'contracts'>,
): NonNullable<ReviewRecord['panelVerdict']> {
  const causes = deterministicCauses(
    evidence?.results ?? [],
    evidence?.contracts ?? [],
  );
  if (
    judges.some(
      (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
    ) ||
    causes.some(({ verdict }) => verdict === 'FAIL')
  )
    return 'FAIL';
  if (
    panelPartial ||
    judges.some((judge) => judge.state === 'incomplete') ||
    causes.length > 0
  )
    return 'INCOMPLETE';
  return 'PASS';
}

function recordedPrepass(
  judge: Awaited<ReturnType<typeof judgeRole>>,
): NonNullable<ReviewRecord['prepass']> {
  const metadata = {
    timing: judge.timing,
    usage: judge.usage,
    sessionId: judge.sessionId,
    ...(judge.model === undefined ? {} : { model: judge.model }),
    ...(judge.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: judge.reasoningEffort }),
  };
  if (judge.state === 'complete')
    return { state: 'complete', findings: judge.findings, ...metadata };
  return {
    state: 'incomplete',
    findings: [],
    reason: judge.reason,
    ...metadata,
  };
}

function recordedRejectedJudge(
  role: ReviewRole,
  reasoningEffort: ReviewReasoningEffort,
  error: unknown,
): NewReviewRecord['judges'][number] {
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return {
    timing: startTiming()(),
    usage: {
      state: 'unknown',
      reason: 'Judge failed before host observation was available',
      tokens: {},
      turnsStarted: 0,
      turnsCompleted: 0,
      invalidFields: 0,
      missingRequiredTurns: null,
      complete: false,
      multiTurnSemantics: 'single-turn',
    },
    state: 'incomplete',
    role,
    model: 'gpt-6-luna',
    reasoningEffort,
    reason: 'nonzero_exit',
    reasonKind: 'process_exit',
    sessionId: `startup-failed-${role}`,
    exitCode: null,
    finalMessage: message.slice(0, 12000),
  };
}

export async function runReview(
  request: Omit<ReviewInput, 'panel'> & {
    readonly panel?: readonly ReviewRole[] | undefined;
    readonly signal?: AbortSignal;
    /** Test seam; the CLI always uses CodexHost's installed executable. */
    readonly codexExecutable?: string;
    readonly readPull?: PullReader;
    readonly readGateCheckRuns?: GateCheckRunReader;
  },
): Promise<NewReviewRecord> {
  const input = { ...request, ...reviewInputSchema.parse(request) };
  const finishTiming = startTiming();
  const root = repoRoot(input.repo);
  const sha = validateSha(root, input.head).toLowerCase();
  const lens = readFileSync(resolve(input.lens), 'utf8');
  if (!lens.trim()) throw new Error('--lens file is empty');
  if (Buffer.byteLength(lens) > 32 * 1024)
    throw new Error('--lens file exceeds 32 KB');
  const panel = input.panel ?? panelRoles;
  if (!panel.length || new Set(panel).size !== panel.length)
    throw new Error('--panel must contain unique judge roles');
  for (const role of panel) roleSchema.parse(role);
  const base = resolveCommit(root, input.base);
  const identity =
    input.pr === undefined
      ? undefined
      : verifyPullRequest(
          await (input.readPull ?? readPullRequest)(root, input.pr),
          input.pr,
          base,
          sha,
        );
  if (identity !== undefined)
    checkReviewBudget(root, identity, input.budgetException);
  const prior =
    input.priorRecord === undefined
      ? undefined
      : loadPriorReview(root, sha, input.priorRecord, {
          panel,
          ...(identity ? { identity } : {}),
        });
  const panelPartial =
    panel.length !== panelRoles.length ||
    panelRoles.some((role) => !panel.includes(role));
  const reasoningEffort = input.reasoningEffort ?? 'high';
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const toolSha = git(toolRoot, ['rev-parse', 'HEAD']);
  const lensSha256 = createHash('sha256').update(lens, 'utf8').digest('hex');
  const checklist =
    input.prepassChecklist === undefined
      ? undefined
      : {
          sha256: createHash('sha256')
            .update(input.prepassChecklist, 'utf8')
            .digest('hex'),
        };
  const finishRedTiming = startTiming();
  const red = await redFirst(root, base, sha, input.signal);
  const redFirstTiming = finishRedTiming();
  if (input.signal?.aborted) throw new ReviewAbortedError();
  const causes = deterministicCauses(red.results, red.contracts ?? []);
  if (identity !== undefined && causes.length > 0)
    throw new ReviewAdmissionError(causes);
  if (identity !== undefined) {
    let policy: GateAdmissionPolicy;
    try {
      policy = gateAdmissionPolicyFromBase(base, (args) => git(root, args));
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'base policy could not be read';
      throw new ReviewAdmissionError(
        [
          {
            verdict: 'FAIL',
            path: 'gate check read failed',
            cause: reason.slice(0, 200),
          },
        ],
        'gate check admission failed',
      );
    }
    let gate: ReviewGateCheckRun | undefined;
    try {
      const checkRuns = await (request.readGateCheckRuns
        ? request.readGateCheckRuns(identity.repository, sha)
        : readGateCheckRunsFromGitHub(identity.repository, sha, input.signal));
      gate = latestMatchingGateCheckRun(checkRuns, sha, policy);
    } catch (error) {
      if (input.signal?.aborted) throw new ReviewAbortedError();
      const reason =
        error instanceof GateCheckReadError ? error.message : 'reader failed';
      throw new ReviewAdmissionError(
        [
          {
            verdict: 'FAIL',
            path: 'gate check read failed',
            cause: reason.slice(0, 200),
          },
        ],
        'gate check admission failed',
      );
    }
    if (input.signal?.aborted) throw new ReviewAbortedError();
    if (
      gate &&
      (gate.conclusion === 'failure' ||
        gate.conclusion === 'timed_out' ||
        gate.conclusion === 'startup_failure')
    )
      throw new ReviewAdmissionError(
        [
          {
            verdict: 'FAIL',
            path: gate.name,
            cause: `${gate.conclusion} ${gate.html_url ?? '(no check run URL)'}`,
          },
        ],
        'required gate check failed',
      );
  }
  const attempt =
    identity === undefined
      ? undefined
      : reserveReviewAttempt(
          root,
          identity,
          base,
          sha,
          prior?.recordSha256,
          input.budgetException,
        );
  let prepass: NonNullable<ReviewRecord['prepass']> | undefined;
  if (input.prepassChecklist !== undefined && prior === undefined) {
    const judge = await judgeRole(
      root,
      sha,
      'adversarial',
      lens,
      red,
      input.timeoutMs ?? 600000,
      input.codexExecutable,
      input.signal,
      reasoningEffort,
      input.prepassChecklist,
    );
    prepass = recordedPrepass(judge);
    if (
      prepass.state === 'complete' &&
      prepass.findings.some((finding) => finding.severity === 'BLOCKING')
    ) {
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      if (input.signal?.aborted) throw new ReviewAbortedError();
      const record = newReviewRecordSchema.parse({
        schemaVersion: 2,
        ...(attempt === undefined ? {} : { attempt }),
        round: prior === undefined ? 1 : 2,
        timing: finishTiming(),
        redFirstTiming,
        headSha: sha,
        base,
        createdAt: new Date().toISOString(),
        lensSha256,
        ...(checklist === undefined ? {} : { checklist }),
        toolSha,
        redFirst: red.results,
        contracts: red.contracts ?? [],
        redFirstCauses: causes,
        judges: [],
        prepass,
      });
      writeReviewRecord(root, record);
      return record;
    }
  }
  const judges = await Promise.all(
    panel.map(async (role) => {
      const finishJudgeTiming = startTiming();
      try {
        return await judgeRole(
          root,
          sha,
          role,
          lens,
          red,
          input.timeoutMs ?? 600000,
          input.codexExecutable,
          input.signal,
          reasoningEffort,
          prior === undefined ? undefined : input.prepassChecklist,
          prior,
        );
      } catch (reason) {
        return {
          ...recordedRejectedJudge(role, reasoningEffort, reason),
          timing: finishJudgeTiming(),
        };
      }
    }),
  );
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  if (input.signal?.aborted) throw new ReviewAbortedError();
  const record = newReviewRecordSchema.parse({
    schemaVersion: 2,
    ...(attempt === undefined ? {} : { attempt }),
    round: prior === undefined ? 1 : 2,
    timing: finishTiming(),
    redFirstTiming,
    headSha: sha,
    base,
    createdAt: new Date().toISOString(),
    panelVerdict: aggregatePanelVerdict(judges, panelPartial, red),
    lensSha256,
    ...(checklist === undefined ? {} : { checklist }),
    panel: {
      requestedRoles: [...panel],
      requiredRoles: [...panelRoles],
      partial: panelPartial,
    },
    toolSha,
    redFirst: red.results,
    contracts: red.contracts ?? [],
    redFirstCauses: causes,
    judges,
    ...(prepass === undefined ? {} : { prepass }),
    ...(prior === undefined ? {} : { prior }),
  });
  writeReviewRecord(root, record);
  return record;
}
