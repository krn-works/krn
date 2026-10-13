import { z } from 'zod';

const unknownMetricSchema = z.object({
  value: z.null(),
  reason: z.string().min(1),
});
const metricSchema = z.union([
  z.number().nonnegative(),
  z.string(),
  unknownMetricSchema,
]);
const counterSchema = z.union([
  z.number().int().nonnegative(),
  unknownMetricSchema,
]);

const taskSchema = z.object({
  task: z.string().min(1),
  repo: z.string().min(1),
  label: z.enum(['valid', 'invalid']),
  reason: z.string().min(1).optional(),
  operator_minutes: metricSchema,
  reconstruction_prompts: metricSchema,
  first_useful_action: metricSchema,
  lost_stages: metricSchema,
  tokens: z.object({
    input: metricSchema,
    cached_input: metricSchema,
    output: metricSchema,
  }),
  judge_rounds: metricSchema,
  outcome: z.string().min(1),
  lead_interventions: counterSchema.optional(),
  escaped_defects: counterSchema.optional(),
});

export const journeyBaselineSchema = z
  .object({
    n: z.number().int().nonnegative(),
    tasks: z.array(taskSchema).min(1),
  })
  .superRefine((baseline, context) => {
    const validTasks = baseline.tasks.filter((task) => task.label === 'valid');
    if (baseline.n !== validTasks.length || validTasks.length < 3) {
      context.addIssue({
        code: 'custom',
        message: 'n must match at least three valid task rows',
        path: ['n'],
      });
    }

    baseline.tasks.forEach((task, index) => {
      if (task.label === 'valid' && task.lead_interventions === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'valid task rows require lead_interventions',
          path: ['tasks', index, 'lead_interventions'],
        });
      }
      if (task.label === 'valid' && task.escaped_defects === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'valid task rows require escaped_defects',
          path: ['tasks', index, 'escaped_defects'],
        });
      }
      if (task.label === 'invalid' && !task.reason) {
        context.addIssue({
          code: 'custom',
          message: 'invalid task rows require a reason',
          path: ['tasks', index, 'reason'],
        });
      }
    });
  });

export const journeyLiveSchema = z.object({
  schema: z.literal(2),
  records: z.array(
    z.object({
      issue: z.string().min(1),
      repo: z.string().min(1),
      commit: z.string().min(1),
      job: z.string().min(1),
      interrupted_at_event: z.string().min(1),
      resumed_session_id: z.string().min(1),
      lead_interventions: counterSchema,
      reconstruction_prompts: counterSchema,
      escaped_defects: counterSchema,
      tokens: z.object({
        input: counterSchema,
        output: counterSchema,
      }),
      outcome: z.string().min(1),
      limitations: z.array(z.string()),
      evidence: z.array(z.string()),
    }),
  ),
});

export type JourneyBaseline = z.infer<typeof journeyBaselineSchema>;
