import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRecord } from './record.ts';

/** One open-task pointer into agent state that the checkout no longer holds. */
export interface EvidenceMiss {
  path: string;
  task: string;
  recovery: string | null;
}

const runsReference = /\.krn\/runs\/[\w.@/<>*{}-]+/gu;
const placeholder = /[<>*{}]/u;

/**
 * Lists every `.krn/runs/` path cited by an open task that is missing under
 * `evidenceRoot`, with its location under `recoveryRoot` when a copy exists.
 */
export function evidenceMisses(
  records: Iterable<TaskRecord>,
  evidenceRoot: string,
  recoveryRoot?: string,
): EvidenceMiss[] {
  const misses: EvidenceMiss[] = [];
  for (const record of records) {
    if (record.status !== 'open') continue;
    for (const path of runsReferences([record.title, ...record.body])) {
      if (existsSync(join(evidenceRoot, path))) continue;
      const copy =
        recoveryRoot === undefined ? undefined : join(recoveryRoot, path);
      misses.push({
        path,
        task: record.id,
        recovery: copy !== undefined && existsSync(copy) ? copy : null,
      });
    }
  }
  return misses;
}

export function formatEvidenceMiss(miss: EvidenceMiss): string {
  const recovery =
    miss.recovery === null ? 'no recovery copy' : `recovery ${miss.recovery}`;
  return `tasks/${miss.task}.json: missing evidence ${miss.path} (${recovery})`;
}

function runsReferences(texts: string[]): string[] {
  const paths = new Set<string>();
  for (const text of texts)
    for (const [match] of text.matchAll(runsReference)) {
      if (placeholder.test(match)) continue;
      paths.add(match.replace(/[.,:;/]+$/u, ''));
    }
  return [...paths].sort();
}
