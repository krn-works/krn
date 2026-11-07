// Shared vocabulary of the opt-in review panel: judge roles and verdicts.
import { z } from 'zod';

export const roleSchema = z.enum(['standards', 'spec', 'adversarial']);
export type ReviewRole = z.infer<typeof roleSchema>;
export const reasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReviewReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const findingSchema = z.object({
  severity: z.enum(['BLOCKING', 'NON_BLOCKING']),
  title: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  defect: z.string().min(1),
  fix: z.string().min(1),
  category: z
    .enum(['correctness', 'security', 'contract', 'test', 'style'])
    .optional(),
});
export type Finding = z.infer<typeof findingSchema>;

export const verdictSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(findingSchema),
});

export type JudgeResult =
  | {
      readonly state: 'complete';
      readonly role: ReviewRole;
      readonly verdict: 'PASS' | 'FAIL';
      readonly findings: readonly Finding[];
    }
  | {
      readonly state: 'incomplete';
      readonly role: ReviewRole;
      readonly reason: string;
    };
