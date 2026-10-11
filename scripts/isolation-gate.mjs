import { z } from 'zod';

const tapSummarySchema = z.object({
  testCount: z.number().int().nonnegative().optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  todoCount: z.number().int().nonnegative().optional(),
  isolationSkipNames: z.array(z.string()),
});
const isolationSkipEventSchema = z
  .object({
    nonce: z.string().regex(/^[a-f0-9]{64}$/u),
    testName: z.string().min(1),
    line: z.string().min(1),
  })
  .strict();
const isolationSkipNonceSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const emptyTapSummary = { isolationSkipNames: [] };

export function decideIsolation(testName, required, capabilities, isCI) {
  const labels = {
    bwrap: 'bwrap user namespaces',
    systemdUserScope: 'systemd user scopes',
  };
  const missing = required.filter((name) => !capabilities[name]?.available);
  if (missing.length === 0) return { kind: 'run' };

  const list = missing.map((name) => labels[name]).join(', ');
  if (isCI)
    return {
      kind: 'skip',
      line: `SKIP(isolation): ${testName} — missing ${list}`,
    };
  return {
    kind: 'fail',
    message: `Isolation requirements failed for ${testName}: missing ${list}`,
  };
}

export function isolationSummary(skipNames) {
  const lines = [`Isolation-dependent tests skipped: ${skipNames.length}`];
  if (skipNames.length === 0) lines.push('Isolation skip names: none');
  else {
    lines.push('Isolation skip names:');
    for (const name of skipNames) lines.push(`- ${name}`);
  }
  return lines.join('\n');
}

export function parseIsolationSkipSignals(output, expectedNonce) {
  const parsedOutput = z.string().safeParse(output);
  const parsedNonce = isolationSkipNonceSchema.safeParse(expectedNonce);
  if (!parsedOutput.success || !parsedNonce.success) return [];

  const signals = [];
  for (const line of parsedOutput.data.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    const parsedSignal = isolationSkipEventSchema.safeParse(payload);
    if (parsedSignal.success && parsedSignal.data.nonce === parsedNonce.data)
      signals.push({
        testName: parsedSignal.data.testName,
        line: parsedSignal.data.line,
      });
  }
  return signals;
}

export function countIsolationSkips(output) {
  const parsedOutput = z.string().safeParse(output);
  if (!parsedOutput.success) return 0;
  return [
    ...parsedOutput.data.matchAll(
      /^[ \t]*ok [\d.]+ - .*? # SKIP SKIP\(isolation\):[^\r\n]*$/gmu,
    ),
  ].length;
}

export function parseTapSummary(output, isolationSkipSignals = []) {
  const capturedOutput = z.string().safeParse(output);
  if (!capturedOutput.success) return emptyTapSummary;
  const count = (name) => {
    const matches = capturedOutput.data.matchAll(
      new RegExp(`^# ${name} (\\d+)$`, 'gmu'),
    );
    const last = [...matches].at(-1);
    return last ? Number(last[1]) : undefined;
  };
  const skippedEntries = [
    ...capturedOutput.data.matchAll(/^[ \t]*ok [\d.]+ - (.*?) # SKIP (.*)$/gmu),
  ].map((match) => ({ testName: match[1], line: match[2] }));
  const parsedSignals = z
    .array(z.object({ testName: z.string(), line: z.string() }).strict())
    .safeParse(isolationSkipSignals);
  const unmatchedEntries = [...skippedEntries];
  const isolationSkipNames = [];
  if (parsedSignals.success) {
    for (const signal of parsedSignals.data) {
      const index = unmatchedEntries.findIndex(
        (entry) =>
          entry.testName === signal.testName && entry.line === signal.line,
      );
      if (index < 0) continue;
      unmatchedEntries.splice(index, 1);
      isolationSkipNames.push(signal.testName);
    }
  }
  const summary = tapSummarySchema.safeParse({
    testCount: count('tests'),
    skippedCount: count('skipped'),
    todoCount: count('todo'),
    isolationSkipNames,
  });
  return summary.success ? summary.data : emptyTapSummary;
}

export function testSuiteExitCode(exitCode, summary, requireZeroSkips, isCI) {
  if (exitCode !== 0) return exitCode || 1;
  if (!Number.isInteger(summary.testCount) || summary.testCount === 0) return 1;
  if (requireZeroSkips && summary.isolationSkipNames.length > 0) return 1;
  if (
    isCI &&
    (summary.skippedCount !== summary.isolationSkipNames.length ||
      summary.todoCount !== 0)
  )
    return 1;
  return 0;
}

export async function postGateStatusWhenClean({ exitCode, skipCount, post }) {
  if (exitCode !== 0 || skipCount !== 0) return false;
  await post();
  return true;
}
