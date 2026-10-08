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
      if (task.label === 'invalid' && !task.reason) {
        context.addIssue({
          code: 'custom',
          message: 'invalid task rows require a reason',
          path: ['tasks', index, 'reason'],
        });
      }
    });
  });

export type JourneyBaseline = z.infer<typeof journeyBaselineSchema>;
