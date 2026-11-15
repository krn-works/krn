// Pure parts of the first-day walkthrough (scripts/first-day-walkthrough.ts).

/** The numbered lines under a `next steps:` heading of a command's output. */
export function nextSteps(output: string): string[] {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'next steps:');
  if (start < 0) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+\d+\.\s+(.+)$/u.exec(line);
    if (!match) break;
    steps.push(match[1] as string);
  }
  return steps;
}

/** The shell commands a printed step names: its backticked spans, else the text after the first `: `; none for prose. */
export function stepCommands(step: string): string[] {
  const quoted = [...step.matchAll(/`([^`]+)`/gu)].map((m) => m[1] as string);
  if (quoted.length > 0) return quoted;
  const colon = step.indexOf(': ');
  const tail = colon < 0 ? '' : step.slice(colon + 2).trim();
  return /^(git|krn|npm|command)\b/u.test(tail) ? [tail] : [];
}

/** True when a failure message names something the operator can do next. */
export function namesRemedy(message: string): boolean {
  return /\b(pass|run|use|set|add|install|create|pipe|write|see|try|start|put|check)\b|--[a-z]|`krn /iu.test(
    message,
  );
}

export type StepResult = { name: string; ok: boolean; detail: string };

/** One verdict line per step and a closing verdict; the exit code is 0 only when every step held. */
export function summarize(results: StepResult[]): {
  text: string;
  exitCode: number;
} {
  const lines = results.map(
    (r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `: ${r.detail}`}`,
  );
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    failed === 0
      ? `first-day-walkthrough: PASS ${results.length} steps`
      : `first-day-walkthrough: FAIL ${failed} of ${results.length} steps`,
  );
  return { text: lines.join('\n'), exitCode: failed === 0 ? 0 : 1 };
}
