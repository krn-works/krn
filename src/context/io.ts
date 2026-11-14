// Strict object narrowing for hook payloads and transcript lines; the hook codec lives in src/harness/claude.ts.

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}
