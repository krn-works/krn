// Paperclip owns task status; ledger binds review submission to its issue revision. ADR 0007.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Job, Result } from '../core/index.ts';
import type { CheckEvidence } from '../verdict/index.ts';

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
export type Ledger = ReturnType<typeof createLedger>;
export type LedgerOptions = {
  apiUrl: string;
  token: string;
  session: string;
  fetch?: typeof fetch;
};

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

export function createLedger(options: LedgerOptions) {
  if (!options.session || /[\r\n]/.test(options.session))
    throw new Error('invalid Krn-Session value');
  const base = options.apiUrl.replace(/\/$/, '');
  const request = options.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
  };

  async function readIssue(issueId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(issueId))
      throw new Error('invalid Paperclip issue ID');
    const response = await request(`${base}/api/issues/${issueId}`, {
      headers,
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`Paperclip issue read failed (${response.status})`);
    const parsed = parseIssue(await response.json());
    if (!parsed.success || parsed.data.id !== issueId)
      throw new Error('invalid Paperclip issue response');
    return parsed.data;
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
    ): Promise<boolean> {
      if (
        contract.issueId !== job.issue ||
        !validEvidence(contract, evidence) ||
        evidence.sha !== recordedSha
      )
        return false;
      const current = await readIssue(job.issue);
      if (current.updatedAt !== contract.revision || current.status === 'done')
        return false;
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
      const response = await request(`${base}/api/issues/${job.issue}`, {
        method: 'PATCH',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in_review', comment }),
      });
      if (!response.ok)
        throw new Error(
          `Paperclip review submission failed (${response.status})`,
        );
      const receipt = parseIssue(await response.json());
      if (!receipt.success || receipt.data.id !== job.issue)
        throw new Error('invalid Paperclip review receipt');
      return receipt.data.status === 'in_review';
    },
  };
}

export function parsePaperclipContract(description: string) {
  return parseContract(description);
}
