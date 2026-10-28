// Versioned review boundary: compact judge evidence bound to one exact commit.
import { z } from 'zod';

export const roleSchema = z.enum(['standards', 'spec', 'adversarial']);
export const panelRoles = roleSchema.options;
export type ReviewRole = z.infer<typeof roleSchema>;
export const reasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReviewReasoningEffort = z.infer<typeof reasoningEffortSchema>;

const exactShaSchema = z
  .string()
  .regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu)
  .transform((value) => value.toLowerCase());
export const repositoryNameSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/u)
  .transform((value) => value.toLowerCase());
const baseRefSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/[\s~^:?*[\\]/u.test(value) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      ) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.endsWith('.lock') &&
      !value.includes('//'),
    'invalid target base ref',
  );
export const reviewInputSchema = z
  .object({
    repo: z.string().min(1),
    base: z.string().min(1),
    head: exactShaSchema,
    lens: z.string().min(1),
    panel: z
      .array(roleSchema)
      .min(1)
      .refine((roles) => new Set(roles).size === roles.length)
      .optional(),
    prepassChecklist: z
      .string()
      .trim()
      .min(1)
      .max(32768)
      .refine((value) => Buffer.byteLength(value) <= 32 * 1024)
      .refine((value) => !value.includes('\0'))
      .optional(),
    priorRecord: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    pr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    budgetException: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.budgetException === undefined || value.pr !== undefined,
    'budget exception requires --pr',
  );
export type ReviewInput = z.infer<typeof reviewInputSchema>;
// Both the CLI and direct API validate authoritative GitHub JSON here.
export const pullRequestSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  base: z.object({
    ref: baseRefSchema,
    sha: exactShaSchema,
    repo: z.object({ full_name: repositoryNameSchema }),
  }),
  head: z.object({ sha: exactShaSchema }),
});
export const seriesIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: repositoryNameSchema,
    pr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    baseRef: baseRefSchema,
  })
  .strict();
export type SeriesIdentity = z.infer<typeof seriesIdentitySchema>;
export const budgetExceptionSchema = seriesIdentitySchema
  .extend({
    ordinal: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER),
    headSha: exactShaSchema,
    authority: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().min(1).max(4000),
  })
  .strict();
export const reviewAttemptSchema = seriesIdentitySchema
  .extend({
    id: z.string().uuid(),
    ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    baseSha: exactShaSchema,
    headSha: exactShaSchema,
    reservedAt: z.string().datetime(),
    priorRecordSha256: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    exception: budgetExceptionSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const exception = attempt.exception;
    if (
      attempt.ordinal > 2 !== (exception !== undefined) ||
      (exception &&
        (exception.repository !== attempt.repository ||
          exception.pr !== attempt.pr ||
          exception.baseRef !== attempt.baseRef ||
          exception.ordinal !== attempt.ordinal ||
          exception.headSha !== attempt.headSha))
    )
      context.addIssue({
        code: 'custom',
        message:
          'each extra review attempt requires its exact operator budget exception',
      });
  });
export type ReviewAttempt = z.infer<typeof reviewAttemptSchema>;

const redFirstBaseSchema = z.object({
  path: z.string().min(1),
  side: z.enum(['base', 'head']),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  classification: z.enum([
    'pass',
    'assertion',
    'missing-module',
    'procedural',
    'other',
    'skipped',
    'timeout',
  ]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().max(2000),
  cause: z.enum(['capability', 'runner-config', 'contract']).optional(),
  proven: z.literal(false).optional(),
});
function validateCapabilityEvidence(
  run: Pick<
    z.infer<typeof redFirstBaseSchema>,
    'cause' | 'classification' | 'proven'
  >,
  context: z.RefinementCtx,
): void {
  if (
    run.cause === 'capability' &&
    (run.classification !== 'skipped' || run.proven !== false)
  )
    context.addIssue({
      code: 'custom',
      message: 'capability evidence must remain skipped and unproven',
    });
}
export const redFirstSchema = redFirstBaseSchema.superRefine(
  validateCapabilityEvidence,
);
export type RedFirstResult = z.infer<typeof redFirstSchema>;
const redFirstRecordSchema = redFirstBaseSchema
  .extend({
    side: z.enum(['base', 'head']).optional(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/iu)
      .optional(),
  })
  .superRefine(validateCapabilityEvidence);

export const changeContractSchema = z
  .object({
    commit: z.string().regex(/^[a-f0-9]{40,64}$/iu),
    path: z.string().min(1),
    kind: z.enum(['red->green', 'green->green']),
    red: redFirstSchema.optional(),
    green: redFirstSchema,
    proven: z.boolean(),
    cause: z.literal('capability').optional(),
  })
  .superRefine((contract, context) => {
    const red = contract.red;
    const proven =
      contract.green.classification === 'pass' &&
      (contract.kind === 'green->green' ||
        red?.classification === 'assertion' ||
        red?.classification === 'missing-module');
    if (
      contract.proven !== proven ||
      (contract.kind === 'red->green' && red === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'contract proof must match both runner outcomes',
      });
    if (
      contract.green.path !== contract.path ||
      contract.green.side !== 'head' ||
      (red && (red.path !== contract.path || red.side !== 'base'))
    )
      context.addIssue({
        code: 'custom',
        message: 'contract evidence must match its path and sides',
      });
    if (
      contract.cause === 'capability' &&
      (proven ||
        (red?.cause !== 'capability' && contract.green.cause !== 'capability'))
    )
      context.addIssue({
        code: 'custom',
        message: 'capability exemption requires skipped runner evidence',
      });
  });
export type ChangeContract = z.infer<typeof changeContractSchema>;
const redFirstCauseSchema = z.object({
  path: z.string().min(1),
  commit: z.string().optional(),
  verdict: z.enum(['FAIL', 'INCOMPLETE']),
  cause: z.string().min(1),
});

export function deterministicCauses(
  results: readonly z.infer<typeof redFirstRecordSchema>[],
  contracts: readonly ChangeContract[],
): z.infer<typeof redFirstCauseSchema>[] {
  const causes: z.infer<typeof redFirstCauseSchema>[] = [];
  const check = (
    run: z.infer<typeof redFirstRecordSchema>,
    commit?: string,
  ) => {
    if (run.classification === 'pass') return;
    if (run.classification === 'skipped' && run.cause === 'capability') return;
    causes.push({
      path: run.path,
      ...(commit === undefined ? {} : { commit }),
      verdict:
        run.side === 'head' &&
        ['assertion', 'timeout'].includes(run.classification)
          ? 'FAIL'
          : 'INCOMPLETE',
      cause: run.cause ?? `${run.side ?? 'unknown'}: ${run.classification}`,
    });
  };
  for (const run of results) {
    if (
      run.side === 'head' ||
      (run.side === 'base' &&
        !['pass', 'assertion', 'missing-module'].includes(run.classification))
    )
      check(run);
  }
  for (const contract of contracts) {
    check(contract.green, contract.commit);
    if (contract.kind !== 'red->green') continue;
    const red = contract.red;
    if (!red) {
      causes.push({
        path: contract.path,
        commit: contract.commit,
        verdict: 'INCOMPLETE',
        cause: 'missing red evidence',
      });
    } else if (red.classification === 'pass') {
      causes.push({
        path: contract.path,
        commit: contract.commit,
        verdict: 'FAIL',
        cause: 'the test does not fail without the change',
      });
    } else if (!['assertion', 'missing-module'].includes(red.classification)) {
      check(red, contract.commit);
    }
  }
  return causes;
}

export const findingSchema = z.object({
  severity: z.enum(['BLOCKING', 'NON_BLOCKING']),
  title: z.string().min(1).max(300),
  path: z.string().min(1),
  line: z.number().int().positive(),
  defect: z.string().min(1).max(2000),
  fix: z.string().min(1).max(1000),
  regression: z.boolean().optional(),
  demoted: z.literal(true).optional(),
});
export const priorStatusSchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.enum(['RESOLVED', 'UNRESOLVED']),
  evidence: z.string().trim().min(1).max(4000),
});
export const priorReviewSchema = z.object({
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  findings: z.array(
    findingSchema
      .pick({ title: true, path: true, line: true, defect: true })
      .extend({
        role: roleSchema,
      }),
  ),
  changedPaths: z.array(z.string().min(1)),
});
export type PriorReview = z.infer<typeof priorReviewSchema>;
export function coversPriorFindings(
  statuses: readonly z.infer<typeof priorStatusSchema>[],
  count: number,
): boolean {
  return (
    statuses.length === count &&
    new Set(statuses.map(({ index }) => index)).size === count &&
    statuses.every(({ index }) => index < count)
  );
}
export function isCountedRegression(
  finding: z.infer<typeof findingSchema>,
  changedPaths: readonly string[],
): boolean {
  return finding.regression === true && changedPaths.includes(finding.path);
}
export function priorJudgeVerdict(
  statuses: readonly z.infer<typeof priorStatusSchema>[],
  findings: readonly z.infer<typeof findingSchema>[],
): 'PASS' | 'FAIL' {
  return statuses.some(({ status }) => status === 'UNRESOLVED') ||
    findings.some(({ severity }) => severity === 'BLOCKING')
    ? 'FAIL'
    : 'PASS';
}
export const timingSchema = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().finite().nonnegative(),
});
export function startTiming(): () => z.infer<typeof timingSchema> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return () => ({
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - started),
  });
}
const tokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const usageSchema = z
  .object({
    state: z.enum(['observed', 'unknown']),
    reason: z.string().min(1).optional(),
    tokens: z
      .object({
        inputTokens: tokenCountSchema.optional(),
        outputTokens: tokenCountSchema.optional(),
        cachedInputTokens: tokenCountSchema.optional(),
        cacheWriteInputTokens: tokenCountSchema.optional(),
        reasoningOutputTokens: tokenCountSchema.optional(),
      })
      .strict(),
    turnsStarted: tokenCountSchema,
    turnsCompleted: tokenCountSchema,
    invalidFields: tokenCountSchema,
    missingRequiredTurns: tokenCountSchema.nullable().optional(),
    complete: z.boolean(),
    multiTurnSemantics: z.enum(['single-turn', 'unverified']),
  })
  .superRefine((usage, context) => {
    const observed = Object.keys(usage.tokens).length > 0;
    const tokens = usage.tokens;
    const impossibleSubset =
      (tokens.cachedInputTokens !== undefined &&
        tokens.inputTokens !== undefined &&
        tokens.cachedInputTokens > tokens.inputTokens) ||
      (tokens.cacheWriteInputTokens !== undefined &&
        tokens.inputTokens !== undefined &&
        tokens.cacheWriteInputTokens > tokens.inputTokens) ||
      (tokens.reasoningOutputTokens !== undefined &&
        tokens.outputTokens !== undefined &&
        tokens.reasoningOutputTokens > tokens.outputTokens);
    const subsetWithoutParent =
      (tokens.cachedInputTokens !== undefined &&
        tokens.inputTokens === undefined) ||
      (tokens.cacheWriteInputTokens !== undefined &&
        tokens.inputTokens === undefined) ||
      (tokens.reasoningOutputTokens !== undefined &&
        tokens.outputTokens === undefined);
    if (
      impossibleSubset ||
      (subsetWithoutParent && (usage.invalidFields === 0 || usage.complete)) ||
      (usage.state === 'observed') !== observed ||
      (!observed && !usage.reason) ||
      usage.multiTurnSemantics !==
        (usage.turnsCompleted > 1 ? 'unverified' : 'single-turn') ||
      (usage.complete &&
        (!observed ||
          usage.invalidFields > 0 ||
          usage.turnsCompleted === 0 ||
          usage.turnsStarted !== usage.turnsCompleted ||
          usage.tokens.inputTokens === undefined ||
          usage.tokens.outputTokens === undefined))
    )
      context.addIssue({
        code: 'custom',
        message: 'usage observation is inconsistent',
      });
  });

const prepassRecordSchema = z.object({
  state: z.enum(['complete', 'incomplete']),
  findings: z.array(findingSchema),
  sessionId: z.string().min(1),
  timing: timingSchema.optional(),
  usage: usageSchema.optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reason: z
    .enum([
      'turn_incomplete',
      'nonzero_exit',
      'empty_final_message',
      'invalid_verdict',
    ])
    .optional(),
});
const reapedScopeSchema = z.object({
  unit: z.string().min(1),
  ownerPid: z.number().int().positive(),
  ownerStartTicks: z.string().regex(/^\d+$/u),
});
const judgeObservationShape = {
  timing: timingSchema.optional(),
  usage: usageSchema.optional(),
};
const completeJudgeSchema = z.object({
  ...judgeObservationShape,
  state: z.literal('complete'),
  role: roleSchema,
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  verdict: z.enum(['PASS', 'FAIL']),
  declaredVerdict: z.enum(['PASS', 'FAIL']).optional(),
  findings: z.array(findingSchema),
  sessionId: z.string().min(1),
  finalMessage: z.string().min(1).max(12000),
  prior: z.array(priorStatusSchema).optional(),
  reapedScopes: z.array(reapedScopeSchema).optional(),
});
const incompleteJudgeSchema = z.object({
  ...judgeObservationShape,
  state: z.literal('incomplete'),
  role: roleSchema,
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reason: z.enum([
    'turn_incomplete',
    'nonzero_exit',
    'empty_final_message',
    'invalid_verdict',
  ]),
  reasonKind: z.string().min(1),
  sessionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  finalMessage: z.string().max(12000).optional(),
  reapedScopes: z.array(reapedScopeSchema).optional(),
});
export const judgeSchema = z.discriminatedUnion('state', [
  completeJudgeSchema,
  incompleteJudgeSchema,
]);
const recordedCompleteJudgeSchema = completeJudgeSchema.extend({
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});
const recordedIncompleteJudgeSchema = incompleteJudgeSchema.extend({
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});
const recordedJudgeSchema = z.discriminatedUnion('state', [
  recordedCompleteJudgeSchema,
  recordedIncompleteJudgeSchema,
]);
const overrideSchema = z.object({
  reason: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(4000),
  appendedAt: z.string().datetime(),
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/iu);
const panelCompositionSchema = z.object({
  requestedRoles: z.array(roleSchema).min(1),
  requiredRoles: z.array(roleSchema).min(1),
  partial: z.boolean(),
});
const reviewRecordBaseSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  attempt: reviewAttemptSchema.optional(),
  round: z.union([z.literal(1), z.literal(2)]).optional(),
  timing: timingSchema.optional(),
  redFirstTiming: timingSchema.optional(),
  headSha: commitShaSchema,
  base: z.string().min(1),
  createdAt: z.string().datetime(),
  panelVerdict: z.enum(['PASS', 'FAIL', 'INCOMPLETE']).optional(),
  redFirst: z.array(redFirstRecordSchema),
  contracts: z.array(changeContractSchema).optional(),
  redFirstCauses: z.array(redFirstCauseSchema).optional(),
  judges: z.array(judgeSchema),
  prepass: prepassRecordSchema.optional(),
  prior: priorReviewSchema.optional(),
});
function reviewRecordInvariants(
  record: z.infer<typeof reviewRecordBaseSchema> & {
    readonly panel?: z.infer<typeof panelCompositionSchema> | undefined;
  },
  context: z.RefinementCtx,
): void {
  const hasValidV2Usage = (
    usage: z.infer<typeof usageSchema> | undefined,
  ): boolean =>
    usage !== undefined &&
    usage.missingRequiredTurns !== undefined &&
    (!usage.complete || usage.missingRequiredTurns === 0);

  if (
    record.attempt &&
    (record.attempt.headSha !== record.headSha ||
      record.attempt.baseSha !== record.base ||
      record.attempt.priorRecordSha256 !== record.prior?.recordSha256)
  )
    context.addIssue({
      code: 'custom',
      message: 'PR-bound record requires matching attempt provenance',
    });
  if (record.schemaVersion >= 2) {
    if (
      record.round !== (record.prior ? 2 : 1) ||
      !record.timing ||
      !record.redFirstTiming ||
      (record.prepass !== undefined &&
        (!record.prepass.timing || !hasValidV2Usage(record.prepass.usage))) ||
      record.judges.some(
        (judge) =>
          !judge.timing || !hasValidV2Usage(judge.usage) || !judge.model,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'version 2 requires round, review and judge observations',
      });
  }
  for (const [index, contract] of (record.contracts ?? []).entries()) {
    if (contract.green.sha !== record.headSha)
      context.addIssue({
        code: 'custom',
        path: ['contracts', index, 'green', 'sha'],
        message: 'contract green evidence must identify this review head',
      });
  }
  if (
    record.redFirstCauses !== undefined &&
    JSON.stringify(record.redFirstCauses) !==
      JSON.stringify(
        deterministicCauses(record.redFirst, record.contracts ?? []),
      )
  )
    context.addIssue({
      code: 'custom',
      path: ['redFirstCauses'],
      message: 'recorded causes must match deterministic evidence',
    });
  if (record.prior) {
    if (record.prior.headSha.toLowerCase() === record.headSha.toLowerCase())
      context.addIssue({
        code: 'custom',
        path: ['prior', 'headSha'],
        message: 'prior review must have a different head',
      });
    if (record.prepass !== undefined || record.panelVerdict === undefined)
      context.addIssue({
        code: 'custom',
        path: ['prior'],
        message:
          'a prior review requires panel verification without a blocking prepass',
      });
  }
  for (const [index, judge] of record.judges.entries()) {
    if (judge.state !== 'complete') continue;
    if (!record.prior) {
      if (
        judge.prior !== undefined ||
        judge.declaredVerdict !== undefined ||
        judge.findings.some(
          (finding) =>
            finding.regression !== undefined || finding.demoted !== undefined,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['judges', index],
          message:
            'prior statuses and regression metadata require a prior review',
        });
      continue;
    }
    if (
      judge.prior === undefined ||
      !coversPriorFindings(judge.prior, record.prior.findings.length)
    )
      context.addIssue({
        code: 'custom',
        path: ['judges', index, 'prior'],
        message:
          'prior statuses must cover every prior BLOCKING finding exactly once',
      });
    for (const [findingIndex, finding] of judge.findings.entries()) {
      const counted = isCountedRegression(finding, record.prior.changedPaths);
      if (
        (finding.severity === 'BLOCKING' && !counted) ||
        (finding.demoted && (finding.severity !== 'NON_BLOCKING' || counted))
      )
        context.addIssue({
          code: 'custom',
          path: ['judges', index, 'findings', findingIndex],
          message:
            'only regressions in changed files may remain BLOCKING; other new BLOCKING findings must be demoted',
        });
    }
    if (
      judge.prior !== undefined &&
      judge.verdict !== priorJudgeVerdict(judge.prior, judge.findings)
    )
      context.addIssue({
        code: 'custom',
        path: ['judges', index, 'verdict'],
        message:
          'verdict must match unresolved prior findings and counted regressions',
      });
  }
  const prepassHasBlocking =
    record.prepass?.state === 'complete' &&
    record.prepass.findings.some((finding) => finding.severity === 'BLOCKING');
  if (record.panelVerdict === undefined) {
    if (!prepassHasBlocking)
      context.addIssue({
        code: 'custom',
        path: ['panelVerdict'],
        message: 'a missing panel verdict requires a blocking prepass finding',
      });
    if (record.judges.length !== 0 || record.panel !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['judges'],
        message: 'a blocking prepass record cannot contain panel evidence',
      });
    return;
  }
  if (prepassHasBlocking)
    context.addIssue({
      code: 'custom',
      path: ['panelVerdict'],
      message: 'a blocking prepass must stop before a panel verdict',
    });
  if (record.judges.length === 0)
    context.addIssue({
      code: 'custom',
      path: ['judges'],
      message: 'a panel verdict requires recorded panel judges',
    });
  const hasFailure = record.judges.some(
    (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
  );
  if (hasFailure && record.panelVerdict !== 'FAIL')
    context.addIssue({
      code: 'custom',
      path: ['panelVerdict'],
      message: 'a complete judge FAIL must make the panel verdict FAIL',
    });
  const panel = record.panel;
  const expectedPartial =
    panel !== undefined &&
    (panel.requestedRoles.length !== panel.requiredRoles.length ||
      panel.requiredRoles.some((role) => !panel.requestedRoles.includes(role)));
  if (panel) {
    const requested = panel.requestedRoles;
    const required = panel.requiredRoles;
    if (panel.partial !== expectedPartial)
      context.addIssue({
        code: 'custom',
        path: ['panel', 'partial'],
        message: 'panel partial flag does not match its role composition',
      });
    if (
      required.length !== panelRoles.length ||
      panelRoles.some((role) => !required.includes(role))
    )
      context.addIssue({
        code: 'custom',
        path: ['panel', 'requiredRoles'],
        message: 'panel required roles do not match the configured panel',
      });
    if (
      new Set(requested).size !== requested.length ||
      record.judges.length !== requested.length ||
      record.judges.some((judge, index) => judge.role !== requested[index])
    )
      context.addIssue({
        code: 'custom',
        path: ['panel', 'requestedRoles'],
        message: 'panel roles do not match the recorded judges',
      });
  }
  const hasIncomplete = record.judges.some(
    (judge) => judge.state === 'incomplete',
  );
  const causes = deterministicCauses(record.redFirst, record.contracts ?? []);
  const expectedVerdict =
    hasFailure || causes.some(({ verdict }) => verdict === 'FAIL')
      ? 'FAIL'
      : expectedPartial || hasIncomplete || causes.length > 0
        ? 'INCOMPLETE'
        : 'PASS';
  if (record.panelVerdict !== expectedVerdict)
    context.addIssue({
      code: 'custom',
      path: ['panelVerdict'],
      message: 'panel verdict does not match its judge and role outcomes',
    });
}
const reviewRecordMetadataShape = {
  lensSha256: sha256Schema.optional(),
  panel: panelCompositionSchema.optional(),
  toolSha: commitShaSchema.optional(),
  override: overrideSchema.optional(),
};
export const reviewRecordSchema = reviewRecordBaseSchema
  .extend(reviewRecordMetadataShape)
  .strict()
  .superRefine(reviewRecordInvariants);
export const newReviewRecordSchema = reviewRecordSchema
  .safeExtend({
    judges: z.array(recordedJudgeSchema),
    lensSha256: sha256Schema,
    toolSha: commitShaSchema,
  })
  .superRefine((record, context) => {
    if (record.panelVerdict !== undefined && record.panel === undefined)
      context.addIssue({
        code: 'custom',
        path: ['panel'],
        message: 'a new panel record must include its role composition',
      });
  });
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type NewReviewRecord = z.infer<typeof newReviewRecordSchema>;
