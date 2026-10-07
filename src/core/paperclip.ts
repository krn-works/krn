// Paperclip's external issue boundary. ADR 0001.
import { z } from 'zod';

import type { Result } from './index.ts';

const paperclipIssueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
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
