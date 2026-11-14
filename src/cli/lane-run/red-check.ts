import { join } from 'node:path';
import { z } from 'zod';
import { checkCommand, krnInvocation } from './brief.ts';
import { failingTests, lastLine } from './preflight.ts';

/** The failing check's verdict line, its failing test files and the path of its full output. */
/** A red required Check a ship reported: the run that failed and the head it judged. */
/** The red-check record `krn lane run` leaves after a red Check. */
export const redCheckSchema = z.object(
  { run: z.string(), sha: z.string() },
  { error: 'red-check record under .krn/runs is malformed' },
);
export type RedCheck = z.infer<typeof redCheckSchema>;

/** The red Check named in a ship failure (`<check> concluded <conclusion> on <sha> in run <id>`), if any. */
export function redCheckOf(message: string): RedCheck | undefined {
  const match = /\bconcluded (\w+) on ([0-9a-f]{7,40}) in run (\d+)/u.exec(
    message,
  );
  if (match === null || match[1] === 'success') return undefined;
  return { sha: match[2] as string, run: match[3] as string };
}

/** The KRN_TEST_SUMMARY_JSON line a CI test step prints. */
export const testSummarySchema = z.object({
  files: z.array(z.object({ file: z.string(), failed: z.number() })).optional(),
});

/** The failing job's step and its first finding in a `krn ci logs` capture; the first failing job is the cause, an aggregate job after it only repeats it. */
export function redCheckFinding(logs: string): {
  job: string;
  section: string[];
  finding: string;
} {
  const lines = logs.split('\n');
  const start = lines.findIndex((line) => line.startsWith('== attempt '));
  if (start === -1)
    return {
      job: 'no failed job in the logs',
      section: [],
      finding: lastLine(logs) || 'no output',
    };
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith('== attempt '),
  );
  const section = lines.slice(start, next === -1 ? undefined : next);
  const job = (section[0] as string).replace(/^== attempt \d+ job \d+ /u, '');
  const body = section.slice(1);
  const summary = body.find((line) =>
    line.startsWith('KRN_TEST_SUMMARY_JSON='),
  );
  if (summary !== undefined)
    try {
      const parsed = testSummarySchema.parse(
        JSON.parse(summary.slice('KRN_TEST_SUMMARY_JSON='.length)),
      );
      const red = (parsed.files ?? []).filter((file) => file.failed > 0);
      if (red.length > 0)
        return {
          job,
          section,
          finding: `failing tests: ${red
            .map(
              (file) =>
                `${file.file.replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//u, '')} (${file.failed} failed)`,
            )
            .join(', ')}`,
        };
    } catch {
      /* A truncated summary line falls through to the log lines. */
    }
  const files = failingTests(body.join('\n'));
  if (files.length > 0)
    return { job, section, finding: `failing tests: ${files.join(', ')}` };
  // The step's own output ends just before the runner's error line, after its last log group.
  const end = body.findIndex((line) => line.startsWith('##[error]'));
  const before = body.slice(0, end === -1 ? body.length : end);
  const group = before.findLastIndex((line) => line.startsWith('##['));
  const output = before
    .slice(group + 1)
    .filter((line) => line.trim() !== '')
    .slice(-3);
  return {
    job,
    section,
    finding:
      output.length > 0
        ? output.join('; ')
        : (body.find((line) => line.startsWith('##[error]')) ??
          'no finding in the log tail'),
  };
}

/** The top of a rerun's brief: the previous attempt's red Check, its failing step and finding, and the demand for a new commit. */
export function redCheckBrief(
  root: string,
  red: RedCheck,
  logs: string | Error,
): string {
  const krn = krnInvocation(root);
  const head = `The previous attempt of this lane FAILED CI: the required Check concluded failure on ${red.sha.slice(0, 12)} in run ${red.run}.`;
  const demand = `Your earlier commit ${red.sha.slice(0, 12)} is already in this worktree and is not enough. Fix the cause, add a NEW commit with the same trailer, and run \`${checkCommand(root)}\`; a run that adds no commit since the red Check exits 74 with "no new commit since the red Check". Full log: ${krn} ci logs --run ${red.run}.`;
  if (logs instanceof Error)
    return `${head}\nThe CI log could not be read (${logs.message.split('\n')[0]}); read it with ${krn} ci logs --run ${red.run}.\n${demand}\n\n`;
  const { job, section, finding } = redCheckFinding(logs);
  return `${head}\nFailing job and step: ${job}\nFirst finding: ${finding}\n${demand}\n\nFailing job log tail:\n\`\`\`\n${section.slice(-40).join('\n')}\n\`\`\`\n\n`;
}

/** Where a lane run records the red Check its ship hit, so the rerun in the same worktree briefs it. */
export function redCheckFile(main: string, lane: string): string {
  return join(main, '.krn', 'tmp', `lane-run-${lane}-red-check.json`);
}

export function failedCheckDetail(
  command: string,
  output: string,
  logPath: string,
): string {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  const verdict =
    [...lines]
      .reverse()
      .find((line) => /\bFAIL\b|\bfail(ed|ing)?\b/iu.test(line)) ??
    lines[lines.length - 1] ??
    'no output';
  const files = [
    ...new Set(
      lines
        .filter((line) => /not ok|✖|test at|FAIL|failing/iu.test(line))
        .flatMap((line) => line.match(/[\w./-]+\.test\.[cm]?[jt]s/gu) ?? []),
    ),
  ];
  return `no passing check on the final tree: ${command} failed: ${verdict.trim()}; failing files: ${files.length === 0 ? 'none named' : files.join(', ')}; full output ${logPath}`;
}
