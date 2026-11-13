import { parseTaskDocument, serializeTask } from './record.ts';

/** The three copies of one task record a lane rerun meets: the base it started from, the lane worktree and the invoking checkout. */
export interface RecordCopies {
  base: string;
  lane: string;
  main: string;
}

export type RecordMerge =
  | { merged: string }
  | { conflict: string }
  | { invalid: string };

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Items appended after a base list, when the list keeps the base as its prefix. */
function appended(base: unknown[], list: unknown[]): unknown[] | undefined {
  if (list.length < base.length) return undefined;
  return base.every((item, index) => same(item, list[index]))
    ? list.slice(base.length)
    : undefined;
}

/**
 * Three-way merge of a task record field by field: a field one side left at base takes the other side's
 * value, and `body` takes both sides' appended items (lane first). Two different edits of one field are a
 * conflict naming that field.
 */
export function mergeTaskRecords(copies: RecordCopies): RecordMerge {
  const parse = (name: keyof RecordCopies) => {
    const parsed = parseTaskDocument(copies[name]);
    if (parsed.record === undefined)
      throw new Error(`${name}: ${parsed.findings.join('; ')}`);
    return parsed.record as unknown as Record<string, unknown>;
  };
  let base: Record<string, unknown>;
  let lane: Record<string, unknown>;
  let main: Record<string, unknown>;
  try {
    base = parse('base');
    lane = parse('lane');
    main = parse('main');
  } catch (error) {
    return { invalid: (error as Error).message };
  }
  const merged: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(lane),
    ...Object.keys(main),
  ])) {
    const [b, l, m] = [base[key], lane[key], main[key]];
    if (same(l, m) || same(m, b)) merged[key] = l;
    else if (same(l, b)) merged[key] = m;
    else if (key === 'body') {
      const fromBase = Array.isArray(b) ? b : [];
      const ours = Array.isArray(l) ? appended(fromBase, l) : undefined;
      const theirs = Array.isArray(m) ? appended(fromBase, m) : undefined;
      if (ours === undefined || theirs === undefined) return { conflict: key };
      merged[key] = [
        ...fromBase,
        ...ours,
        ...theirs.filter((item) => !ours.some((own) => same(own, item))),
      ];
    } else return { conflict: key };
  }
  const result = parseTaskDocument(`${JSON.stringify(merged)}\n`);
  return result.record === undefined
    ? { invalid: `merged: ${result.findings.join('; ')}` }
    : { merged: serializeTask(result.record) };
}
