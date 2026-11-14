// JSON text zod schema.
import { z } from 'zod';

export const jsonText = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});

/** The parsed JSON document, or undefined when the text is not JSON. */
export function readJson(text: string): unknown {
  const result = jsonText.safeParse(text);
  return result.success ? result.data : undefined;
}
