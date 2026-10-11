// Version one review boundary: compact judge evidence bound to one exact commit.
import { z } from 'zod';

export const roleSchema = z.enum(['standards', 'spec', 'adversarial']);
export const panelRoles = roleSchema.options;
export type ReviewRole = z.infer<typeof roleSchema>;
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);

export const redFirstSchema = z.object({
  path: z.string().min(1),
  side: z.enum(['base', 'head']),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  classification: z.enum(['pass', 'assertion', 'procedural', 'other']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().max(2000),
});
export type RedFirstResult = z.infer<typeof redFirstSchema>;
const redFirstRecordSchema = redFirstSchema.extend({
  side: z.enum(['base', 'head']).optional(),
  sha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/iu)
    .optional(),
});

export const findingSchema = z.object({
  severity: z.enum(['BLOCKING', 'NON_BLOCKING']),
  title: z.string().min(1).max(300),
  path: z.string().min(1),
  line: z.number().int().positive(),
  defect: z.string().min(1).max(2000),
  fix: z.string().min(1).max(1000),
});
const reapedScopeSchema = z.object({
  unit: z.string().min(1),
  ownerPid: z.number().int().positive(),
  ownerStartTicks: z.string().regex(/^\d+$/u),
});
const completeJudgeSchema = z.object({
  state: z.literal('complete'),
  role: roleSchema,
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(findingSchema),
  sessionId: z.string().min(1),
  finalMessage: z.string().min(1).max(12000),
  reapedScopes: z.array(reapedScopeSchema).optional(),
});
const incompleteJudgeSchema = z.object({
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
  schemaVersion: z.literal(1),
  headSha: commitShaSchema,
  base: z.string().min(1),
  createdAt: z.string().datetime(),
  panelVerdict: z.enum(['PASS', 'FAIL', 'INCOMPLETE']),
  redFirst: z.array(redFirstRecordSchema),
  judges: z.array(judgeSchema).min(1),
});
function reviewRecordInvariants(
  record: z.infer<typeof reviewRecordBaseSchema> & {
    readonly panel?: z.infer<typeof panelCompositionSchema> | undefined;
  },
  context: z.RefinementCtx,
): void {
  const hasFailure = record.judges.some(
    (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
  );
  if (hasFailure && record.panelVerdict !== 'FAIL')
    context.addIssue({
      code: 'custom',
      path: ['panelVerdict'],
      message: 'a complete judge FAIL must make the panel verdict FAIL',
    });
  if (record.panel) {
    const requested = record.panel.requestedRoles;
    const required = record.panel.requiredRoles;
    const expectedPartial =
      requested.length !== required.length ||
      required.some((role) => !requested.includes(role));
    if (record.panel.partial !== expectedPartial)
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
    const hasIncomplete = record.judges.some(
      (judge) => judge.state === 'incomplete',
    );
    const expectedVerdict = hasFailure
      ? 'FAIL'
      : expectedPartial || hasIncomplete
        ? 'INCOMPLETE'
        : 'PASS';
    if (record.panelVerdict !== expectedVerdict)
      context.addIssue({
        code: 'custom',
        path: ['panelVerdict'],
        message: 'panel verdict does not match its judge and role outcomes',
      });
  }
}
const reviewRecordMetadataShape = {
  lensSha256: sha256Schema.optional(),
  panel: panelCompositionSchema.optional(),
  toolSha: commitShaSchema.optional(),
  override: overrideSchema.optional(),
};
export const reviewRecordSchema = reviewRecordBaseSchema
  .extend(reviewRecordMetadataShape)
  .superRefine(reviewRecordInvariants);
export const newReviewRecordSchema = reviewRecordSchema.safeExtend({
  judges: z.array(recordedJudgeSchema).min(1),
  lensSha256: sha256Schema,
  panel: panelCompositionSchema,
  toolSha: commitShaSchema,
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type NewReviewRecord = z.infer<typeof newReviewRecordSchema>;
