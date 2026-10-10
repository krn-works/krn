// Paperclip's external issue boundary. ADR 0001.
import { z } from 'zod';

import type { Result } from './index.ts';

export const paperclipIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  status: z.string().min(1),
  assignee: z.unknown().optional(),
  assigneeAgentId: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
});

export type PaperclipIssue = z.infer<typeof paperclipIssueSchema>;

export function parsePaperclipIssue(
  payload: unknown,
): Result<PaperclipIssue, z.ZodError> {
  const parsed = paperclipIssueSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error };
}
