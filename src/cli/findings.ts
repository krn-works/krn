// Review findings: a schema a validator checks; only a fresh-context verifier sets `confirmed`.
import { readFileSync } from 'node:fs';
import { CliUsageError } from '../cli-kit/usage-error.ts';

export const findingsUsage =
  'krn findings validate <file>  check a findings JSON file ({"findings":[...]}); each finding has id, title, status confirmed|needs_validation|rejected; confirmed needs evidence ["path:line"], a reproduce command, and verifiedBy naming a verifier other than foundBy; needs_validation carries no severity; exit 1 with one stderr line per problem, 65 on malformed JSON, 66 when unreadable';

const statuses = ['confirmed', 'needs_validation', 'rejected'];
const severities = ['low', 'medium', 'high', 'critical'];
const evidencePattern = /^[^\s:][^\s]*:[1-9]\d*$/u;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Problems of one findings document; empty when it is valid. */
export function validateFindings(document: unknown): string[] {
  const rows =
    typeof document === 'object' && document !== null
      ? (document as { findings?: unknown }).findings
      : undefined;
  if (!Array.isArray(rows)) return ['findings must be an array'];
  const problems: string[] = [];
  rows.forEach((raw: unknown, index) => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    const name = text(row.id) ? row.id : `#${index}`;
    const fail = (message: string) => problems.push(`${name}: ${message}`);
    if (!text(row.id)) fail('id is required');
    if (!text(row.title)) fail('title is required');
    if (typeof row.status !== 'string' || !statuses.includes(row.status)) {
      fail(`status must be one of ${statuses.join(', ')}`);
      return;
    }
    if (row.severity !== undefined) {
      if (row.status === 'needs_validation')
        fail('needs_validation must not carry a severity');
      else if (
        typeof row.severity !== 'string' ||
        !severities.includes(row.severity)
      )
        fail(`severity must be one of ${severities.join(', ')}`);
    }
    if (row.status !== 'confirmed') return;
    const evidence = row.evidence;
    if (
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      !evidence.every(
        (entry) => typeof entry === 'string' && evidencePattern.test(entry),
      )
    )
      fail('confirmed needs evidence, a non-empty list of "path:line"');
    if (!text(row.reproduce))
      fail('confirmed needs a reproduce command that shows the defect');
    if (!text(row.verifiedBy)) fail('confirmed needs verifiedBy');
    else if (row.verifiedBy === row.foundBy)
      fail('verifiedBy must be a fresh-context verifier, not the finder');
  });
  return problems;
}

export function findingsCommand(args: string[]): void {
  const [verb, file, ...extra] = args;
  if (verb !== 'validate' || file === undefined || extra.length > 0)
    throw new CliUsageError(findingsUsage);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`krn findings: cannot read ${file}\n`);
    process.exitCode = 66;
    return;
  }
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    process.stderr.write(`krn findings: ${file} is not valid JSON\n`);
    process.exitCode = 65;
    return;
  }
  const problems = validateFindings(document);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stdout.write(`FAIL ${problems.length} problem(s) in ${file}\n`);
    process.exitCode = 1;
    return;
  }
  const count = (document as { findings: unknown[] }).findings.length;
  process.stdout.write(`PASS ${count} finding(s) in ${file}\n`);
}
