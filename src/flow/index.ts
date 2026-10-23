// Compose red-first evidence, independent panel sessions, and their bound record.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireHostLock } from './host-lock.ts';
import { judgeRole, ReviewAbortedError } from './panel.ts';
import { writeReviewRecord } from './record.ts';
import {
  git,
  redFirst,
  repoRoot,
  resolveCommit,
  validateSha,
} from './repository.ts';
import {
  type NewReviewRecord,
  newReviewRecordSchema,
  panelRoles,
  type ReviewReasoningEffort,
  type ReviewRecord,
  type ReviewRole,
  roleSchema,
} from './types.ts';

export function aggregatePanelVerdict(
  judges: readonly ReviewRecord['judges'][number][],
  panelPartial: boolean,
): NonNullable<ReviewRecord['panelVerdict']> {
  if (
    judges.some(
      (judge) => judge.state === 'complete' && judge.verdict === 'FAIL',
    )
  )
    return 'FAIL';
  if (panelPartial || judges.some((judge) => judge.state === 'incomplete'))
    return 'INCOMPLETE';
  return 'PASS';
}

function recordedPrepass(
  judge: Awaited<ReturnType<typeof judgeRole>>,
): NonNullable<ReviewRecord['prepass']> {
  const metadata = {
    sessionId: judge.sessionId,
    ...(judge.model === undefined ? {} : { model: judge.model }),
    ...(judge.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: judge.reasoningEffort }),
  };
  if (judge.state === 'complete')
    return { state: 'complete', findings: judge.findings, ...metadata };
  return {
    state: 'incomplete',
    findings: [],
    reason: judge.reason,
    ...metadata,
  };
}

export async function runReview(input: {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly lens: string;
  readonly panel?: readonly ReviewRole[];
  readonly prepassChecklist?: string;
  readonly reasoningEffort?: ReviewReasoningEffort;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly hostLock?: string;
  /** Test seam; the CLI always uses CodexHost's installed executable. */
  readonly codexExecutable?: string;
}): Promise<NewReviewRecord> {
  const root = repoRoot(input.repo);
  const sha = validateSha(root, input.head);
  const lens = readFileSync(resolve(input.lens), 'utf8');
  if (!lens.trim()) throw new Error('--lens file is empty');
  if (Buffer.byteLength(lens) > 32 * 1024)
    throw new Error('--lens file exceeds 32 KB');
  const panel = input.panel ?? panelRoles;
  if (!panel.length || new Set(panel).size !== panel.length)
    throw new Error('--panel must contain unique judge roles');
  for (const role of panel) roleSchema.parse(role);
  const base = resolveCommit(root, input.base);
  const panelPartial =
    panel.length !== panelRoles.length ||
    panelRoles.some((role) => !panel.includes(role));
  const reasoningEffort = input.reasoningEffort ?? 'high';
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const toolSha = git(toolRoot, ['rev-parse', 'HEAD']);
  const lensSha256 = createHash('sha256').update(lens, 'utf8').digest('hex');
  const hostLock =
    input.hostLock === undefined
      ? undefined
      : await acquireHostLock(input.hostLock, input.signal);
  let red: Awaited<ReturnType<typeof redFirst>>;
  try {
    hostLock?.assertHeld();
    red = await redFirst(root, base, sha, hostLock?.signal ?? input.signal);
    hostLock?.assertHeld();
  } finally {
    await hostLock?.release();
  }
  let prepass: NonNullable<ReviewRecord['prepass']> | undefined;
  if (input.prepassChecklist !== undefined) {
    const judge = await judgeRole(
      root,
      sha,
      'adversarial',
      lens,
      red,
      input.timeoutMs ?? 600000,
      input.codexExecutable,
      input.signal,
      reasoningEffort,
      input.prepassChecklist,
    );
    prepass = recordedPrepass(judge);
    if (
      prepass.state === 'complete' &&
      prepass.findings.some((finding) => finding.severity === 'BLOCKING')
    ) {
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      if (input.signal?.aborted) throw new ReviewAbortedError();
      const record = newReviewRecordSchema.parse({
        schemaVersion: 1,
        headSha: sha,
        base,
        createdAt: new Date().toISOString(),
        lensSha256,
        toolSha,
        redFirst: red.results,
        judges: [],
        prepass,
      });
      writeReviewRecord(root, record);
      return record;
    }
  }
  const judges = [];
  for (const role of panel)
    judges.push(
      await judgeRole(
        root,
        sha,
        role,
        lens,
        red,
        input.timeoutMs ?? 600000,
        input.codexExecutable,
        input.signal,
        reasoningEffort,
      ),
    );
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  if (input.signal?.aborted) throw new ReviewAbortedError();
  const record = newReviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: sha,
    base,
    createdAt: new Date().toISOString(),
    panelVerdict: aggregatePanelVerdict(judges, panelPartial),
    lensSha256,
    panel: {
      requestedRoles: [...panel],
      requiredRoles: [...panelRoles],
      partial: panelPartial,
    },
    toolSha,
    redFirst: red.results,
    judges,
    ...(prepass === undefined ? {} : { prepass }),
  });
  writeReviewRecord(root, record);
  return record;
}
