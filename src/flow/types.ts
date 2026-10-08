// Version one review boundary: compact judge evidence bound to one exact commit.
import { z } from 'zod';

export const roleSchema = z.enum(['standards', 'spec', 'adversarial']);
export const panelRoles = roleSchema.options;
export type ReviewRole = z.infer<typeof roleSchema>;

export const redFirstSchema = z.object({
  path: z.string().min(1),
  classification: z.enum(['pass', 'assertion', 'procedural', 'other']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().max(2000),
});
export type RedFirstResult = z.infer<typeof redFirstSchema>;

export const findingSchema = z.object({
  severity: z.enum(['BLOCKING', 'NON_BLOCKING']),
  title: z.string().min(1).max(300),
  path: z.string().min(1),
  line: z.number().int().positive(),
  defect: z.string().min(1).max(2000),
  fix: z.string().min(1).max(1000),
});
const completeJudgeSchema = z.object({
  state: z.literal('complete'),
  role: roleSchema,
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(findingSchema),
  sessionId: z.string().min(1),
  finalMessage: z.string().min(1).max(12000),
});
const incompleteJudgeSchema = z.object({
  state: z.literal('incomplete'),
  role: roleSchema,
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
});
export const judgeSchema = z.discriminatedUnion('state', [
  completeJudgeSchema,
  incompleteJudgeSchema,
]);
const overrideSchema = z.object({
  reason: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(4000),
  appendedAt: z.string().datetime(),
});
export const reviewRecordSchema = z.object({
  schemaVersion: z.literal(1),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  base: z.string().min(1),
  createdAt: z.string().datetime(),
  panelVerdict: z.enum(['PASS', 'FAIL', 'INCOMPLETE']),
  redFirst: z.array(redFirstSchema),
  judges: z.array(judgeSchema).min(1),
  override: overrideSchema.optional(),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
