// Paperclip owns task status; review writes report post-write conflicts. ADR 0007.
// Residual risk: non-atomic board write; Paperclip exposes no issue-revision precondition.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Job, Result } from '../core/index.ts';
import type { CheckEvidence } from '../verdict/index.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const issueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  status: z.string().min(1),
  assignee: z.unknown().optional(),
  assigneeAgentId: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
});
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
  | 'refused'
  | 'board_changed'
  | 'board_conflict';
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
  readIssue(issueId: string): Promise<unknown>;
  readActivity(issueId: string): Promise<unknown>;
  updateIssue(
    issueId: string,
    status: string,
    comment: string,
  ): Promise<unknown>;
}>;

function parseIssue(value: unknown) {
  return issueSchema.safeParse(value);
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
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };

  async function requestJson(
    input: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const operation = (async () => {
      const response = await fetchRequest(input, {
        ...init,
        signal: controller.signal,
      });
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

  async function readIssue(issueId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    if (transport) {
      const parsed = parseIssue(await transport.readIssue(issueId));
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
    );
    if (!response.ok)
      throw new Error(`Paperclip issue read failed (${response.status})`);
    const parsed = parseIssue(body);
    if (!parsed.success || parsed.data.id !== issueId)
      throw new Error('invalid Paperclip issue response');
    return parsed.data;
  }

  async function readActivity(issueId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    if (transport) {
      const parsed = activitySchema.safeParse(
        await transport.readActivity(issueId),
      );
      if (!parsed.success)
        throw new Error('invalid Paperclip activity response');
      return parsed.data;
    }
    const { response, body } = await requestJson(
      `${base}/api/issues/${issueId}/activity`,
      { headers, redirect: 'error' },
    );
    if (!response.ok)
      throw new Error(`Paperclip activity read failed (${response.status})`);
    const parsed = activitySchema.safeParse(body);
    if (!parsed.success) throw new Error('invalid Paperclip activity response');
    return parsed.data;
  }

  async function reportBoardConflict(
    issueId: string,
    sha: string,
    writtenAt: string,
    writtenCommentHash: string,
    events: readonly z.infer<typeof activitySchema>[number][],
  ) {
    if (!options.session) throw new Error('KRN_SESSION is required to submit');
    const observed = events.length
      ? events.map(
          (event) =>
            `${event.action} at ${event.createdAt}; details=${JSON.stringify(event.details ?? null)}`,
        )
      : [
          'No non-ledger activity was returned for the changed post-write revision.',
        ];
    const comment = [
      `Krn-Session: ${options.session}`,
      `Board conflict after Krn's single review PATCH.`,
      `Krn wrote status=in_review for candidate SHA=${sha} at Paperclip updatedAt=${writtenAt}; review-comment SHA-256=${writtenCommentHash}.`,
      'Intervening board activity observed:',
      ...observed,
      'Human review is required; the ledger made no status correction.',
    ].join('\n');
    if (transport) {
      const current = await readIssue(issueId);
      await transport.updateIssue(issueId, current.status, comment);
      return;
    }
    const { response } = await requestJson(
      `${base}/api/issues/${issueId}/comments`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: comment }),
      },
    );
    if (!response.ok)
      throw new Error(`Paperclip conflict comment failed (${response.status})`);
  }

  return {
    async readContract(issueId: string): Promise<Contract> {
      const issue = await readIssue(issueId);
      const block = parseContract(issue.description);
      if (!block.ok) throw new Error(block.error);
      return {
        issueId: issue.id,
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
    ): Promise<ReviewSubmission> {
      if (
        contract.issueId !== job.issue ||
        !validEvidence(contract, evidence) ||
        evidence.sha !== recordedSha
      )
        return 'refused';
      if (!options.session)
        throw new Error('KRN_SESSION is required to submit');
      const current = await readIssue(job.issue).catch(() => null);
      if (!current) return 'refused';
      if (current.updatedAt !== contract.revision || current.status === 'done')
        return 'board_changed';
      const beforeActivity = await readActivity(job.issue).catch(() => null);
      if (!beforeActivity) return 'refused';
      const fenced = await readIssue(job.issue).catch(() => null);
      if (!fenced) return 'refused';
      if (fenced.updatedAt !== contract.revision || fenced.status === 'done')
        return 'board_changed';
      const results = evidence.checks
        .map((check) => `- ${check.id}: pass; result sha256 ${check.sha256}`)
        .join('\n');
      const comment = [
        `Krn-Session: ${options.session}`,
        `Commit: ${evidence.sha}`,
        'Checks:',
        results,
        `Evidence SHA-256: ${hash(`${evidence.sha}\n${results}`)}`,
      ].join('\n');
      let response: Response | undefined;
      let body: unknown;
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
      if (response && !response.ok)
        throw new Error(
          `Paperclip review submission failed (${response.status})`,
        );
      const receipt = parseIssue(body);
      if (!receipt.success || receipt.data.id !== job.issue)
        throw new Error('invalid Paperclip review receipt');
      const [afterIssue, afterActivity] = await Promise.all([
        readIssue(job.issue),
        readActivity(job.issue),
      ]);
      const beforeIds = new Set(beforeActivity.map((event) => event.id));
      const newEvents = afterActivity.filter(
        (event) => !beforeIds.has(event.id),
      );
      const ownReviewEvents = newEvents.filter(
        (event) =>
          event.action === 'issue.updated' &&
          event.entityId === job.issue &&
          event.details?.status === 'in_review' &&
          event.details?.source === 'comment',
      );
      const foreignEvents = newEvents.filter(
        (event) => !ownReviewEvents.includes(event),
      );
      if (
        foreignEvents.length > 0 ||
        ownReviewEvents.length !== 1 ||
        afterIssue.updatedAt !== receipt.data.updatedAt
      ) {
        await reportBoardConflict(
          job.issue,
          evidence.sha,
          receipt.data.updatedAt,
          hash(comment),
          foreignEvents.length > 0 ? foreignEvents : newEvents,
        );
        return 'board_conflict';
      }
      return afterIssue.status === 'in_review' ? 'submitted' : 'refused';
    },
  };
}

export function parsePaperclipContract(description: string) {
  return parseContract(description);
}
