import type { ReviewRecord, ReviewRole } from './types.ts';

type Judge = ReviewRecord['judges'][number];
export function dropStyle(judge: Judge): Judge {
  if (judge.state !== 'complete') return judge;
  const findings = judge.findings.filter(
    (finding) => finding.category !== 'style',
  );
  const droppedStyle = judge.findings.length - findings.length;
  return {
    ...judge,
    findings,
    droppedStyle,
    verdict:
      droppedStyle > 0 &&
      !findings.some((finding) => finding.severity === 'BLOCKING') &&
      !judge.prior?.some((status) => status.status === 'UNRESOLVED')
        ? 'PASS'
        : judge.verdict,
  };
}
type FindingInput = Omit<
  Extract<Judge, { state: 'complete' }>['findings'][number],
  'path' | 'line'
> & { path: string | null; line: number | null };
type Consolidated = Pick<
  FindingInput,
  'severity' | 'title' | 'path' | 'line' | 'defect' | 'fix'
> & { roles: ReviewRole[] };
export function consolidateFindings(
  judges: readonly (
    | { state: 'complete'; role: ReviewRole; findings: readonly FindingInput[] }
    | { state: 'incomplete' }
  )[],
): Consolidated[] {
  const groups = new Map<string, Consolidated>();
  for (const judge of judges) {
    if (judge.state !== 'complete') continue;
    for (const finding of judge.findings) {
      const key = JSON.stringify([finding.path, finding.line]);
      const previous = groups.get(key);
      const roles = [
        ...new Set([...(previous?.roles ?? []), judge.role]),
      ].sort();
      if (
        !previous ||
        (previous.severity !== 'BLOCKING' && finding.severity === 'BLOCKING')
      ) {
        const { severity, title, path, line, defect, fix } = finding;
        groups.set(key, { severity, title, path, line, defect, fix, roles });
      } else previous.roles = roles;
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.severity === 'BLOCKING') - Number(a.severity === 'BLOCKING') ||
        (a.path ?? '').localeCompare(b.path ?? '') ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .slice(0, 200);
}

export function oneLine(value: string): string {
  return (value.split(/[\n\r\u2028\u2029]/u)[0] ?? '').replace(
    /[\p{Cc}\p{Cf}]/gu,
    '',
  );
}
