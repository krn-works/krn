import { z } from 'zod';

/**
 * A failed worker turn as data: what failed, whether a later retry can
 * succeed, and when a usage limit resets. Never carries provider text.
 */
export type TurnFailure = {
  class: string;
  retryable: boolean;
  code?: number;
  exit_status?: number | null;
  signal?: string | null;
  reset_at?: string;
};

// Every CodexErrorInfo variant of codex app-server 0.167.0
// (test/fixtures/codex-app-server/schema/ErrorNotification.json) and whether
// the same request can succeed later without a change by the lead.
export const codexErrorRetryable = {
  contextWindowExceeded: false,
  sessionBudgetExceeded: false,
  usageLimitExceeded: true,
  rateLimitExceeded: true,
  flexUnavailable: true,
  serverOverloaded: true,
  modelNotFound: false,
  policyCapacityUnavailable: true,
  cyberPolicy: false,
  misalignmentPolicyViolation: false,
  tooManyDenials: false,
  internalServerError: true,
  unauthorized: false,
  badRequest: false,
  threadRollbackFailed: false,
  sandboxError: false,
  other: false,
  httpConnectionFailed: true,
  responseStreamConnectionFailed: true,
  responseStreamDisconnected: true,
  responseTooManyFailedAttempts: true,
  activeTurnNotSteerable: true,
} as const satisfies Record<string, boolean>;
type CodexErrorClass = keyof typeof codexErrorRetryable;

function known(name: string): name is CodexErrorClass {
  return Object.hasOwn(codexErrorRetryable, name);
}

/** Classifies turn.error.codexErrorInfo; an unknown or missing variant is `unknown`. */
export function codexTurnFailure(info: unknown): TurnFailure {
  const name =
    typeof info === 'string'
      ? info
      : info && typeof info === 'object' && Object.keys(info).length === 1
        ? Object.keys(info)[0]
        : undefined;
  return name !== undefined && known(name)
    ? { class: name, retryable: codexErrorRetryable[name] }
    : { class: 'unknown', retryable: false };
}

/** Classes whose reset time `account/rateLimits/read` reports. */
export function limitClass(failure: TurnFailure): boolean {
  return (
    failure.class === 'usageLimitExceeded' ||
    failure.class === 'rateLimitExceeded'
  );
}

const window = z
  .object({
    usedPercent: z.number(),
    resetsAt: z.number().int().safe().nullable().optional(),
  })
  .nullable()
  .optional();
const snapshot = z.object({
  primary: window,
  secondary: window,
  individualLimit: z
    .object({ remainingPercent: z.number(), resetsAt: z.number().int().safe() })
    .nullable()
    .optional(),
});
const rateLimitsRead = z.object({
  rateLimits: snapshot,
  rateLimitsByLimitId: z.record(z.string(), snapshot).nullable().optional(),
});

/**
 * The latest reset among exhausted windows of an `account/rateLimits/read`
 * result, as an ISO time; undefined when no window is exhausted or the
 * result does not parse.
 */
export function resetAt(result: unknown): string | undefined {
  const parsed = rateLimitsRead.safeParse(result);
  if (!parsed.success) return undefined;
  const resets = [
    parsed.data.rateLimits,
    ...Object.values(parsed.data.rateLimitsByLimitId ?? {}),
  ].flatMap((limits) => [
    ...[limits.primary, limits.secondary].flatMap((w) =>
      w && w.usedPercent >= 100 && w.resetsAt != null ? [w.resetsAt] : [],
    ),
    ...(limits.individualLimit && limits.individualLimit.remainingPercent <= 0
      ? [limits.individualLimit.resetsAt]
      : []),
  ]);
  if (!resets.length) return undefined;
  const time = new Date(Math.max(...resets) * 1000);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

/** The integer `code` of a JSON-RPC error object, when it has one. */
export function rpcErrorCode(error: unknown): number | undefined {
  const parsed = z.object({ code: z.number().int().safe() }).safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}
