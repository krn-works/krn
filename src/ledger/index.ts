// Paperclip owns task status; review writes report post-write conflicts. ADR 0007.
// Residual risk: non-atomic board write; Paperclip exposes no issue-revision precondition.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Job, Result } from '../core/index.ts';
import { paperclipIssueSchema } from '../core/paperclip.ts';
import type { CheckEvidence } from '../verdict/index.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_CONTRACT_DESCRIPTION_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const activitySchema = z.array(
  z
    .object({
      id: z.string().min(1),
      action: z.string().min(1),
      entityId: z.string().min(1),
      createdAt: z.string().datetime({ offset: true }),
      details: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .passthrough(),
);

function commentReceiptSha(body: string): string | null {
  return /^Commit:\s*([a-f0-9]{40,64})\s*$/imu.exec(body)?.[1] ?? null;
}

type CommentSnapshot = Readonly<{
  entries: readonly unknown[];
  complete: boolean;
}>;

function commentsSnapshot(value: unknown): CommentSnapshot | null {
  const wrapper =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(wrapper?.comments)
      ? wrapper.comments
      : null;
  if (!entries) return null;

  const has = (key: string) =>
    wrapper !== undefined && Object.hasOwn(wrapper, key);
  let explicitlyComplete = false;
  let incomplete = false;
  let malformed = false;
  const cursorKeys = ['nextCursor', 'next_cursor'].filter(has);
  if (cursorKeys.length > 1) {
    const [first, second] = cursorKeys.map((key) => wrapper?.[key]);
    if (first !== second) malformed = true;
  }
  for (const key of cursorKeys) {
    const cursor = wrapper?.[key];
    if (cursor === null) explicitlyComplete = true;
    else if (typeof cursor === 'string' && cursor.length > 0) incomplete = true;
    else malformed = true;
  }

  for (const key of ['hasMore', 'has_more']) {
    if (!has(key)) continue;
    const hasMore = wrapper?.[key];
    if (typeof hasMore !== 'boolean') malformed = true;
    else if (hasMore) incomplete = true;
    else explicitlyComplete = true;
  }

  if (has('total')) {
    const total = wrapper?.total;
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < entries.length
    )
      malformed = true;
    else if (total > entries.length) incomplete = true;
    else explicitlyComplete = true;
  }

  incomplete ||= malformed;
  return {
    entries,
    complete: !incomplete && (explicitlyComplete || entries.length < 500),
  };
}

function commentBody(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || !('body' in entry))
    return null;
  return typeof entry.body === 'string' ? entry.body : null;
}

function hasReviewComment(value: unknown, sha: string): boolean {
  const snapshot = commentsSnapshot(value);
  return (
    snapshot?.entries.some((entry) => {
      const body = commentBody(entry);
      return body !== null && commentReceiptSha(body) === sha;
    }) ?? false
  );
}

function hasExactComment(value: unknown, body: string): boolean {
  return (
    commentsSnapshot(value)?.entries.some(
      (entry) => commentBody(entry) === body,
    ) ?? false
  );
}

function reviewCommentTime(value: unknown, sha: string): number | null {
  const snapshot = commentsSnapshot(value);
  if (!snapshot) return null;
  const times = snapshot.entries.flatMap((entry) => {
    const body = commentBody(entry);
    if (body === null || commentReceiptSha(body) !== sha) return [];
    const createdAt =
      typeof entry === 'object' && entry !== null && 'createdAt' in entry
        ? entry.createdAt
        : undefined;
    const time = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
    return Number.isFinite(time) ? [time] : [];
  });
  return times.length ? Math.max(...times) : null;
}
const contractBlockSchema = z
  .object({
    version: z.literal(1),
    targetRepo: z.string().min(1),
    checks: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .min(1)
      .max(16),
  })
  .strict()
  .refine((value) => new Set(value.checks).size === value.checks.length);

export type Contract = Readonly<{
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  revision: string;
  targetRepo: string;
  checks: readonly string[];
}>;
export type BoardView = Readonly<{
  status: string;
  assignee: string | null;
  updatedAt: string;
}>;
export type VerdictEvidence = Readonly<{
  kind: 'verdict_pass';
  sha: string;
  checks: readonly CheckEvidence[];
}>;
export type ReviewSubmission =
  | 'submitted'
  | 'ready_for_review'
  | 'stopped'
  | 'refused'
  | 'board_changed'
  | 'board_conflict';
export type SubmissionReceipt = Readonly<{
  issueId: string;
  status: string;
  updatedAt: string;
}>;
export type ConflictCommentDelivery = Readonly<{
  state: 'pending' | 'delivered';
  body: string;
  sha256: string;
}>;
export type SubmitForReviewOptions = Readonly<{
  signal?: AbortSignal;
  reconcile?: boolean;
  session?: string;
  priorReceipt?: SubmissionReceipt | null;
  priorReconciliation?: ReviewSubmission | null;
  priorWindowEventIds?: readonly string[] | null;
  priorConflictComment?: ConflictCommentDelivery | null;
  onSubmissionWindow?: (eventIds: readonly string[]) => void;
  onReconciliation?: (result: ReviewSubmission) => void;
  onConflictComment?: (delivery: ConflictCommentDelivery) => void;
  onWriteStarted?: (kind: 'review' | 'conflict_comment') => void;
  onSubmitted?: (receipt: SubmissionReceipt) => void;
}>;
export type Ledger = ReturnType<typeof createLedger>;
export type LedgerOptions = {
  apiUrl?: string;
  token?: string;
  session: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  transport?: LedgerTransport;
};

export type LedgerTransport = Readonly<{
  readIssue(issueId: string, signal?: AbortSignal): Promise<unknown>;
  readActivity(issueId: string, signal?: AbortSignal): Promise<unknown>;
  readComments(issueId: string, signal?: AbortSignal): Promise<unknown>;
  createComment?(
    issueId: string,
    comment: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  updateIssue(
    issueId: string,
    status: string,
    comment: string,
  ): Promise<unknown>;
  cancelAll?(): Promise<void>;
}>;

function parseIssue(value: unknown) {
  return paperclipIssueSchema.safeParse(value);
}

function parseContract(
  description: string,
): Result<z.infer<typeof contractBlockSchema>, string> {
  const blocks = [
    ...description.matchAll(/```krn-contract\s*\n([\s\S]*?)\n```/g),
  ];
  if (blocks.length !== 1)
    return { ok: false, error: 'missing or duplicate krn-contract block' };
  let json: unknown;
  try {
    json = JSON.parse(blocks[0]?.[1] ?? '');
  } catch {
    return { ok: false, error: 'invalid krn-contract JSON' };
  }
  const parsed = contractBlockSchema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: 'invalid krn-contract schema' };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function submissionRecoveryKey(job: Job, sha: string): string {
  return JSON.stringify([job.id, job.issue, sha]);
}

function activityCommentHash(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['body', 'comment', 'commentBody']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return hash(candidate);
    const nested = activityCommentHash(candidate);
    if (nested) return nested;
  }
  for (const candidate of Object.values(record)) {
    if (typeof candidate === 'object' && candidate !== null) {
      const nested = activityCommentHash(candidate);
      if (nested) return nested;
    }
  }
  return null;
}

function eventCommentHash(event: z.infer<typeof activitySchema>[number]) {
  return (
    activityCommentHash(event.details) ?? activityCommentHash(event as unknown)
  );
}

function activityStatus(event: z.infer<typeof activitySchema>[number]) {
  if (event.details?.status === 'in_review') return true;
  const changes = event.details?.changes;
  if (typeof changes !== 'object' || changes === null) return false;
  const status = (changes as Record<string, unknown>).status;
  return (
    typeof status === 'object' &&
    status !== null &&
    (status as Record<string, unknown>).to === 'in_review'
  );
}

function withinWriteWindow(
  event: z.infer<typeof activitySchema>[number],
  startedAt: number,
  receiptAt: number,
): boolean {
  const at = Date.parse(event.createdAt);
  return at >= startedAt - 1000 && at <= receiptAt + 1000;
}

function validEvidence(contract: Contract, evidence: VerdictEvidence): boolean {
  return (
    evidence.kind === 'verdict_pass' &&
    /^[a-f0-9]{40,64}$/i.test(evidence.sha) &&
    evidence.checks.length === contract.checks.length &&
    evidence.checks.every(
      (check, index) =>
        check.id === contract.checks[index] &&
        check.exitCode === 0 &&
        /^[a-f0-9]{64}$/i.test(check.sha256),
    )
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Paperclip response body is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Paperclip response exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

async function discardBoundedError(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  let size = 0;
  try {
    while (size <= MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
    if (size > MAX_ERROR_BODY_BYTES) await reader.cancel();
  } catch (error) {
    if (signal?.aborted) throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function withinReceiptWindow(
  event: z.infer<typeof activitySchema>[number],
  receiptAt: number,
): boolean {
  const at = Date.parse(event.createdAt);
  return (
    Number.isFinite(receiptAt) &&
    at >= receiptAt - 1000 &&
    at <= receiptAt + 1000
  );
}

type ActivityEvent = z.infer<typeof activitySchema>[number];

function replayActivityEvents(
  events: readonly ActivityEvent[],
  baselineEventIds: readonly string[] | null,
  receiptAt: number,
  reviewCommentHash: string,
  issueId: string,
): {
  newEvents: ActivityEvent[];
  foreignEvents: ActivityEvent[];
  ownCommentEvents: ActivityEvent[];
  ownReviewEvents: ActivityEvent[];
} {
  const baseline = baselineEventIds === null ? null : new Set(baselineEventIds);
  const newEvents = events.filter((event) =>
    baseline === null
      ? Date.parse(event.createdAt) >= receiptAt - 1000
      : !baseline.has(event.id),
  );
  const ownCommentEvents = newEvents.filter(
    (event) =>
      /comment/iu.test(event.action) &&
      eventCommentHash(event) === reviewCommentHash &&
      withinReceiptWindow(event, receiptAt),
  );
  const ownReviewEvents = newEvents.filter(
    (event) =>
      event.action === 'issue.updated' &&
      event.entityId === issueId &&
      activityStatus(event) &&
      withinReceiptWindow(event, receiptAt) &&
      ownCommentEvents.some(
        (commentEvent) =>
          Math.abs(
            Date.parse(commentEvent.createdAt) - Date.parse(event.createdAt),
          ) <= 1000,
      ),
  );
  const ownEvents = new Set([...ownCommentEvents, ...ownReviewEvents]);
  return {
    newEvents,
    foreignEvents: newEvents.filter((event) => !ownEvents.has(event)),
    ownCommentEvents,
    ownReviewEvents,
  };
}

function boardConflictComment(
  session: string,
  sha: string,
  writtenAt: string,
  writtenCommentHash: string,
  events: readonly ActivityEvent[],
): string {
  const observed = events.length
    ? events.map(
        (event) =>
          `${event.action} at ${event.createdAt}; details=${JSON.stringify(event.details ?? null)}`,
      )
    : [
        'No non-ledger activity was returned for the changed post-write revision.',
      ];
  return [
    `Krn-Session: ${session}`,
    `Board conflict after Krn's single review PATCH.`,
    `Krn wrote status=in_review for candidate SHA=${sha} at Paperclip updatedAt=${writtenAt}; review-comment SHA-256=${writtenCommentHash}.`,
    'Intervening board activity observed:',
    ...observed,
    'Human review is required; the ledger made no status correction.',
  ].join('\n');
}

export function createLedger(options: LedgerOptions) {
  const token = options.token?.trim() ?? '';
  if (!options.transport && !token)
    throw new Error('Paperclip credential is required');
  if (options.session && /[\r\n]/.test(options.session))
    throw new Error('invalid Krn-Session value');
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('invalid Paperclip request timeout');
  const base = options.apiUrl?.replace(/\/$/, '') ?? '';
  const transport = options.transport;
  const fetchRequest = options.fetch ?? fetch;
  const submissionWindows = new Map<string, readonly string[]>();
  const submissionReceipts = new Map<string, SubmissionReceipt>();
  const submissionReconciliations = new Map<string, ReviewSubmission>();
  const conflictCommentDeliveries = new Map<string, ConflictCommentDelivery>();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };

  function rememberWindow(
    key: string,
    eventIds: readonly string[],
    callback?: (eventIds: readonly string[]) => void,
  ): void {
    const frozen = Object.freeze([...eventIds]);
    submissionWindows.set(key, frozen);
    callback?.(frozen);
  }

  function rememberReceipt(
    key: string,
    receipt: SubmissionReceipt,
    callback?: (receipt: SubmissionReceipt) => void,
  ): void {
    submissionReceipts.set(key, receipt);
    callback?.(receipt);
  }

  function rememberReconciliation(
    key: string,
    result: ReviewSubmission,
    callback?: (result: ReviewSubmission) => void,
  ): void {
    submissionReconciliations.set(key, result);
    callback?.(result);
  }

  function rememberConflictComment(
    key: string,
    delivery: ConflictCommentDelivery,
    callback?: (delivery: ConflictCommentDelivery) => void,
  ): void {
    conflictCommentDeliveries.set(key, delivery);
    callback?.(delivery);
  }

  async function requestJson(
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const operation = (async () => {
      const requestSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      const response = await fetchRequest(input, {
        ...init,
        signal: requestSignal,
      });
      if (!response.ok) {
        await discardBoundedError(response, requestSignal);
        return { response, body: undefined };
      }
      return { response, body: await readBoundedJson(response) };
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Paperclip request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (timedOut)
        throw new Error(`Paperclip request timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  async function readIssue(issueId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    if (transport) {
      const parsed = parseIssue(await transport.readIssue(issueId, signal));
      if (!parsed.success || parsed.data.id !== issueId)
        throw new Error('invalid Paperclip issue response');
      return parsed.data;
    }
    const { response, body } = await requestJson(
      `${base}/api/issues/${issueId}`,
      {
        headers,
        redirect: 'error',
      },
      signal,
    );
    if (!response.ok)
      throw new Error(`Paperclip issue read failed (${response.status})`);
    const parsed = parseIssue(body);
    if (!parsed.success || parsed.data.id !== issueId)
      throw new Error('invalid Paperclip issue response');
    return parsed.data;
  }

  async function readActivity(issueId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    if (transport) {
      const parsed = activitySchema.safeParse(
        await transport.readActivity(issueId, signal),
      );
      if (!parsed.success)
        throw new Error('invalid Paperclip activity response');
      return parsed.data;
    }
    const { response, body } = await requestJson(
      `${base}/api/issues/${issueId}/activity`,
      { headers, redirect: 'error' },
      signal,
    );
    if (!response.ok)
      throw new Error(`Paperclip activity read failed (${response.status})`);
    const parsed = activitySchema.safeParse(body);
    if (!parsed.success) throw new Error('invalid Paperclip activity response');
    return parsed.data;
  }

  async function readComments(issueId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    if (transport) return transport.readComments(issueId, signal);
    const { response, body } = await requestJson(
      `${base}/api/issues/${issueId}/comments?order=asc&limit=500`,
      { headers, redirect: 'error' },
      signal,
    );
    if (!response.ok)
      throw new Error(`Paperclip comments read failed (${response.status})`);
    return body;
  }

  async function reportBoardConflict(
    issueId: string,
    comment: string,
    signal?: AbortSignal,
    onWriteStarted?: (kind: 'review' | 'conflict_comment') => void,
  ): Promise<boolean> {
    if (transport) {
      if (signal?.aborted) return false;
      if (!transport.createComment)
        throw new Error('Paperclip comment-only transport is unavailable');
      onWriteStarted?.('conflict_comment');
      if (signal?.aborted) return false;
      await transport.createComment(issueId, comment, signal);
      return !signal?.aborted;
    }
    if (signal?.aborted) return false;
    onWriteStarted?.('conflict_comment');
    if (signal?.aborted) return false;
    const { response } = await requestJson(
      `${base}/api/issues/${issueId}/comments`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: comment }),
      },
      signal,
    );
    if (signal?.aborted) return false;
    if (!response.ok)
      throw new Error(`Paperclip conflict comment failed (${response.status})`);
    return true;
  }

  return {
    async readContract(issueId: string): Promise<Contract> {
      const issue = await readIssue(issueId);
      if (
        Buffer.byteLength(issue.description, 'utf8') >
        MAX_CONTRACT_DESCRIPTION_BYTES
      )
        throw new Error(
          'Paperclip task description exceeds the 8 KB contract limit',
        );
      const block = parseContract(issue.description);
      if (!block.ok) throw new Error(block.error);
      return {
        issueId: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title,
        description: issue.description,
        revision: issue.updatedAt,
        targetRepo: block.value.targetRepo,
        checks: block.value.checks,
      };
    },

    async readBoard(job: Job): Promise<BoardView> {
      const issue = await readIssue(job.issue);
      const assignee = issue.assignee;
      const assigneeId =
        typeof assignee === 'string'
          ? assignee
          : typeof assignee === 'object' &&
              assignee !== null &&
              'name' in assignee
            ? String(assignee.name)
            : (issue.assigneeAgentId ?? issue.assigneeUserId ?? null);
      return {
        status: issue.status,
        assignee: assigneeId,
        updatedAt: issue.updatedAt,
      };
    },

    async submitForReview(
      job: Job,
      contract: Contract,
      evidence: VerdictEvidence,
      recordedSha: string,
      submitOptions: SubmitForReviewOptions = {},
    ): Promise<ReviewSubmission> {
      const {
        signal,
        reconcile,
        onWriteStarted,
        onSubmitted,
        onSubmissionWindow,
        onReconciliation,
        onConflictComment,
      } = submitOptions;
      const session = submitOptions.session ?? options.session;
      if (
        contract.issueId !== job.issue ||
        !validEvidence(contract, evidence) ||
        evidence.sha !== recordedSha
      )
        return 'refused';
      if (
        !session ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session) ||
        (submitOptions.session !== undefined &&
          options.session !== '' &&
          options.session !== submitOptions.session)
      )
        return 'refused';
      const results = evidence.checks
        .map((check) => `- ${check.id}: pass; result sha256 ${check.sha256}`)
        .join('\n');
      const reviewComment = [
        `Krn-Session: ${session}`,
        `Commit: ${evidence.sha}`,
        'Checks:',
        results,
        `Evidence SHA-256: ${hash(`${evidence.sha}\n${results}`)}`,
      ].join('\n');
      const recoveryKey = submissionRecoveryKey(job, evidence.sha);
      const priorReceipt =
        submitOptions.priorReceipt ??
        submissionReceipts.get(recoveryKey) ??
        null;
      if (priorReceipt && priorReceipt.issueId !== job.issue) return 'refused';
      const priorReconciliation =
        submitOptions.priorReconciliation ??
        submissionReconciliations.get(recoveryKey) ??
        null;
      const priorWindowEventIds =
        submitOptions.priorWindowEventIds ??
        submissionWindows.get(recoveryKey) ??
        null;
      const priorConflictComment =
        submitOptions.priorConflictComment ??
        conflictCommentDeliveries.get(recoveryKey) ??
        null;
      const deliverConflictComment = async (
        delivery: ConflictCommentDelivery,
      ): Promise<ReviewSubmission> => {
        rememberConflictComment(recoveryKey, delivery, onConflictComment);
        if (signal?.aborted) return 'stopped';
        const delivered = await reportBoardConflict(
          job.issue,
          delivery.body,
          signal,
          onWriteStarted,
        );
        if (!delivered) return 'stopped';
        rememberConflictComment(
          recoveryKey,
          { ...delivery, state: 'delivered' },
          onConflictComment,
        );
        return 'board_conflict';
      };
      if (priorReconciliation === 'board_conflict') {
        rememberReconciliation(recoveryKey, 'board_conflict', onReconciliation);
        if (priorConflictComment?.state === 'delivered')
          return 'board_conflict';
        const comments = await readComments(job.issue, signal).catch(
          () => null,
        );
        if (signal?.aborted) return 'stopped';
        const snapshot = commentsSnapshot(comments);
        if (
          priorConflictComment &&
          hasExactComment(comments, priorConflictComment.body)
        ) {
          rememberConflictComment(
            recoveryKey,
            { ...priorConflictComment, state: 'delivered' },
            onConflictComment,
          );
          return 'board_conflict';
        }
        let delivery = priorConflictComment;
        if (!delivery) {
          const [replayIssue, replayActivity] = await Promise.all([
            readIssue(job.issue, signal).catch(() => null),
            readActivity(job.issue, signal).catch(() => null),
          ]);
          if (signal?.aborted) return 'stopped';
          if (!replayIssue || !replayActivity || !priorReceipt)
            return 'board_conflict';
          const receiptAt = Date.parse(priorReceipt.updatedAt);
          const replayEvents = replayActivityEvents(
            replayActivity,
            priorWindowEventIds,
            receiptAt,
            hash(reviewComment),
            job.issue,
          );
          const body = boardConflictComment(
            session,
            evidence.sha,
            priorReceipt.updatedAt,
            hash(reviewComment),
            replayEvents.foreignEvents.length
              ? replayEvents.foreignEvents
              : replayEvents.newEvents,
          );
          delivery = { state: 'pending', body, sha256: hash(body) };
        }
        if (hasExactComment(comments, delivery.body)) {
          rememberConflictComment(
            recoveryKey,
            { ...delivery, state: 'delivered' },
            onConflictComment,
          );
          return 'board_conflict';
        }
        rememberConflictComment(recoveryKey, delivery, onConflictComment);
        if (!snapshot?.complete) return 'board_conflict';
        return deliverConflictComment(delivery);
      }

      if (reconcile || priorReceipt !== null) {
        const [replayIssue, comments, replayActivity] = await Promise.all([
          readIssue(job.issue, signal).catch(() => null),
          readComments(job.issue, signal).catch(() => null),
          readActivity(job.issue, signal).catch(() => null),
        ]);
        if (signal?.aborted) return 'stopped';
        const snapshot = commentsSnapshot(comments);
        const hasReceipt =
          priorReceipt !== null || hasReviewComment(comments, evidence.sha);
        if (hasReceipt) {
          if (!replayIssue || !replayActivity) {
            rememberReconciliation(recoveryKey, 'refused', onReconciliation);
            return 'refused';
          }
          const commentAt = reviewCommentTime(comments, evidence.sha);
          const receiptAt = Date.parse(
            priorReceipt?.updatedAt ??
              (commentAt === null
                ? replayIssue.updatedAt
                : new Date(commentAt).toISOString()),
          );
          if (!Number.isFinite(receiptAt)) {
            rememberReconciliation(recoveryKey, 'refused', onReconciliation);
            return 'refused';
          }
          const replayEvents = replayActivityEvents(
            replayActivity,
            priorWindowEventIds,
            receiptAt,
            hash(reviewComment),
            job.issue,
          );
          const conflict =
            replayIssue.status !== 'in_review' ||
            (priorReceipt !== null &&
              replayIssue.updatedAt !== priorReceipt.updatedAt) ||
            replayEvents.foreignEvents.length > 0;
          if (conflict) {
            rememberReconciliation(
              recoveryKey,
              'board_conflict',
              onReconciliation,
            );
            const conflictBody = boardConflictComment(
              session,
              evidence.sha,
              priorReceipt?.updatedAt ?? replayIssue.updatedAt,
              hash(reviewComment),
              replayEvents.foreignEvents.length
                ? replayEvents.foreignEvents
                : replayEvents.newEvents,
            );
            const delivery: ConflictCommentDelivery = {
              state: 'pending',
              body: conflictBody,
              sha256: hash(conflictBody),
            };
            if (hasExactComment(comments, conflictBody)) {
              rememberConflictComment(
                recoveryKey,
                { ...delivery, state: 'delivered' },
                onConflictComment,
              );
              return 'board_conflict';
            }
            rememberConflictComment(recoveryKey, delivery, onConflictComment);
            if (!snapshot?.complete) return 'board_conflict';
            return deliverConflictComment(delivery);
          }
          if (
            replayEvents.ownReviewEvents.length !== 1 ||
            replayEvents.ownCommentEvents.length !== 1
          ) {
            rememberReconciliation(recoveryKey, 'refused', onReconciliation);
            return 'refused';
          }
          const recoveredReceipt = priorReceipt ?? {
            issueId: replayIssue.id,
            status: replayIssue.status,
            updatedAt: new Date(receiptAt).toISOString(),
          };
          rememberReceipt(recoveryKey, recoveredReceipt, onSubmitted);
          rememberReconciliation(recoveryKey, 'submitted', onReconciliation);
          return 'submitted';
        }
        if (reconcile && !snapshot?.complete) {
          rememberReconciliation(recoveryKey, 'refused', onReconciliation);
          return 'refused';
        }
      }
      if (signal?.aborted) return 'stopped';
      const current = await readIssue(job.issue, signal).catch(() => null);
      if (signal?.aborted) return 'stopped';
      if (!current) return 'refused';
      if (current.updatedAt !== contract.revision || current.status === 'done')
        return 'board_changed';
      const beforeActivity = await readActivity(job.issue, signal).catch(
        () => null,
      );
      if (signal?.aborted) return 'stopped';
      if (!beforeActivity) return 'refused';
      const fenced = await readIssue(job.issue, signal).catch(() => null);
      if (signal?.aborted) return 'stopped';
      if (!fenced) return 'refused';
      if (fenced.updatedAt !== contract.revision || fenced.status === 'done')
        return 'board_changed';
      const beforeEventIds = beforeActivity.map((event) => event.id);
      rememberWindow(recoveryKey, beforeEventIds, onSubmissionWindow);
      const comment = reviewComment;
      let response: Response | undefined;
      let body: unknown;
      if (signal?.aborted) return 'stopped';
      const writeStartedAt = Date.now();
      onWriteStarted?.('review');
      if (signal?.aborted) return 'stopped';
      if (transport) {
        body = await transport.updateIssue(job.issue, 'in_review', comment);
      } else {
        const result = await requestJson(`${base}/api/issues/${job.issue}`, {
          method: 'PATCH',
          redirect: 'error',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'in_review', comment }),
        });
        response = result.response;
        body = result.body;
      }
      if (signal?.aborted) return 'stopped';
      if (response && !response.ok)
        throw new Error(
          `Paperclip review submission failed (${response.status})`,
        );
      const receipt = parseIssue(body);
      if (!receipt.success || receipt.data.id !== job.issue)
        throw new Error('invalid Paperclip review receipt');
      const submissionReceipt = {
        issueId: receipt.data.id,
        status: receipt.data.status,
        updatedAt: receipt.data.updatedAt,
      };
      rememberReceipt(recoveryKey, submissionReceipt, onSubmitted);
      if (signal?.aborted) return 'stopped';
      const [afterIssue, afterActivity] = await Promise.all([
        readIssue(job.issue, signal),
        readActivity(job.issue, signal),
      ]);
      if (signal?.aborted) return 'stopped';
      const beforeIds = new Set(beforeEventIds);
      const newEvents = afterActivity.filter(
        (event) => !beforeIds.has(event.id),
      );
      const receiptAt = Date.parse(receipt.data.updatedAt);
      const ownCommentEvents = newEvents.filter(
        (event) =>
          /comment/iu.test(event.action) &&
          eventCommentHash(event) === hash(comment) &&
          withinWriteWindow(event, writeStartedAt, receiptAt),
      );
      const ownReviewEvents = newEvents.filter(
        (event) =>
          event.action === 'issue.updated' &&
          event.entityId === job.issue &&
          activityStatus(event) &&
          withinWriteWindow(event, writeStartedAt, receiptAt) &&
          ownCommentEvents.some(
            (commentEvent) =>
              Math.abs(
                Date.parse(commentEvent.createdAt) -
                  Date.parse(event.createdAt),
              ) <= 1000,
          ),
      );
      const ownEvents = new Set([...ownCommentEvents, ...ownReviewEvents]);
      const foreignEvents = newEvents.filter((event) => !ownEvents.has(event));
      if (
        foreignEvents.length > 0 ||
        ownReviewEvents.length !== 1 ||
        ownCommentEvents.length !== 1 ||
        afterIssue.updatedAt !== receipt.data.updatedAt
      ) {
        rememberReconciliation(recoveryKey, 'board_conflict', onReconciliation);
        const conflictBody = boardConflictComment(
          session,
          evidence.sha,
          submissionReceipt.updatedAt,
          hash(comment),
          foreignEvents.length > 0 ? foreignEvents : newEvents,
        );
        return deliverConflictComment({
          state: 'pending',
          body: conflictBody,
          sha256: hash(conflictBody),
        });
      }
      const result =
        afterIssue.status === 'in_review' ? 'submitted' : 'refused';
      rememberReconciliation(recoveryKey, result, onReconciliation);
      return result;
    },
  };
}

export function parsePaperclipContract(description: string) {
  return parseContract(description);
}
