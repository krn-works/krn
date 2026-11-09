// The outcome capsule field contract: labels, state vocabularies, and the
// parsers for the bracketed acceptance and cleanup lists.
export const ABI_LABELS = [
  'Outcome and observable acceptance',
  'Current workflow owner and sole writer',
  'Outcome state',
  'Publication state',
  'Repository base, HEAD or working-tree fingerprint, and dirty-state scope',
  'Native Goal identity/state and configured tracker item/state',
  'Restart state',
  'Outstanding workflow-run cleanup',
  'Authority',
  'Evidence observed',
  'Explicit non-proofs',
  'Review fixed point and Standards / Spec disposition',
  'Open unknowns and blockers with owners',
  'Workflow friction and lesson candidates',
  'Durable CONTEXT / ADR / research references',
  'Next bounded owner and action',
] as const;

export type AbiLabel = (typeof ABI_LABELS)[number];
export type CapsuleFields = Record<AbiLabel, string | null>;

export const OUTCOME_STATES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'BLOCKED',
  'DEFERRED',
  'NEEDS_REVIEW',
  'COMPLETE',
  'SUPERSEDED',
  'ABANDONED',
]);

export const PUBLICATION_STATES: ReadonlySet<string> = new Set([
  'NOT_REQUESTED',
  'NOT_AUTHORIZED',
  'LOCAL_ONLY',
  'PUBLISH_PENDING',
  'PR_OPEN',
  'MERGE_READY',
  'MERGED',
  'DEPLOYED',
]);

const CLEANUP_STATES = new Set(['ACTIVE', 'CLEANUP_PENDING', 'BLOCKED']);

export function fieldLine(text: string, label: string): string | null {
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(`${label}:`))
      return line
        .trimStart()
        .slice(label.length + 1)
        .trim();
  }
  return null;
}

export function readFields(text: string): CapsuleFields {
  return Object.fromEntries(
    ABI_LABELS.map((label) => [label, fieldLine(text, label)]),
  ) as CapsuleFields;
}

export function stripMarkup(value: string): string {
  return value.replace(/[`<>]/g, '').trim();
}

export interface CleanupEntry {
  pointer: string;
  workflow: string;
  consumer: string;
  trigger: string;
  state: string;
}

export function parseCleanup(value: string): {
  entries: CleanupEntry[];
  malformed: string[];
} {
  const trimmedValue = value.trim();
  if (/^none$/i.test(trimmedValue)) return { entries: [], malformed: [] };
  if (!trimmedValue.startsWith('[')) return { entries: [], malformed: [value] };
  const open = value.indexOf('[');
  const close = value.lastIndexOf(']');
  if (close <= open) return { entries: [], malformed: [value] };
  if (value.slice(close + 1).trim() !== '')
    return { entries: [], malformed: [value] };
  const entries: CleanupEntry[] = [];
  const malformed: string[] = [];
  for (const chunk of value.slice(open + 1, close).split(',')) {
    const entry = chunk.replace(/[<>]/g, '').trim();
    if (!entry) continue;
    const parts = entry.split(';').map((part) => part.trim());
    const [pointer, workflow, consumer, trigger, state] = parts;
    if (
      parts.length === 5 &&
      parts.slice(0, 4).every((part) => part !== '') &&
      state !== undefined &&
      CLEANUP_STATES.has(state)
    ) {
      entries.push({
        pointer: pointer as string,
        workflow: workflow as string,
        consumer: consumer as string,
        trigger: trigger as string,
        state,
      });
    } else malformed.push(entry);
  }
  if (entries.length === 0 && malformed.length === 0) malformed.push(value);
  return { entries, malformed };
}

export interface AcceptanceItem {
  criterion: string;
  status: 'todo' | 'pass' | 'drop';
  reason?: string;
}

const DROP_REASON = /^drop\s*:\s*(.+)$/i;

// The acceptance ledger is one bracketed list of `criterion; status` items so a
// fresh session can re-verify each criterion independently. A status is `todo`,
// `pass`, or `drop:<why>`; a drop without a reason is malformed, and prose that
// never opened a bracket has no ledger at all.
export function parseAcceptance(value: string): {
  ledger: boolean;
  items: AcceptanceItem[];
  malformed: string[];
} {
  const trimmed = value.trim();
  if (!trimmed.startsWith('['))
    return { ledger: false, items: [], malformed: [] };
  if (!trimmed.endsWith(']'))
    return { ledger: true, items: [], malformed: [trimmed] };
  const items: AcceptanceItem[] = [];
  const malformed: string[] = [];
  for (const chunk of trimmed.slice(1, -1).split(',')) {
    const entry = chunk.replace(/[<>]/g, '').trim();
    if (!entry) continue;
    const separator = entry.indexOf(';');
    const criterion = separator === -1 ? '' : entry.slice(0, separator).trim();
    const rawStatus = separator === -1 ? '' : entry.slice(separator + 1).trim();
    const reason = DROP_REASON.exec(rawStatus);
    const status = rawStatus.toLowerCase();
    if (criterion && (status === 'todo' || status === 'pass')) {
      items.push({ criterion, status });
    } else if (criterion && reason && (reason[1] ?? '').trim() !== '') {
      items.push({
        criterion,
        status: 'drop',
        reason: (reason[1] ?? '').trim(),
      });
    } else malformed.push(entry);
  }
  if (items.length === 0 && malformed.length === 0) malformed.push(trimmed);
  return { ledger: true, items, malformed };
}

const COMMIT_ANCHOR =
  /\b(base|HEAD|fingerprint)\s*=\s*([0-9a-f]{40}|[0-9a-f]{64})\b/gi;

export function fixedPointAnchors(value: string | null): {
  base: string | null;
  head: string | null;
  fingerprint: string | null;
} {
  const anchors = {
    base: null as string | null,
    head: null as string | null,
    fingerprint: null as string | null,
  };
  if (!value) return anchors;
  for (const match of value.replace(/[<>`]/g, '').matchAll(COMMIT_ANCHOR)) {
    const key = (match[1] ?? '').toLowerCase() as
      | 'base'
      | 'head'
      | 'fingerprint';
    anchors[key] = (match[2] ?? '').toLowerCase();
  }
  return anchors;
}
