// Usage text for the commands this CLI owns.
const usage: Readonly<Record<string, string>> = {
  task: 'krn task <ready|claim|show|list|create|edit|comment|dep|close|release|check> [...]  repository work tracker; `krn task` lists verbs',
  review:
    'krn review --repo PATH --base REF --head SHA --lens PATH [--panel ...] [--pr N]  opt-in review panel; `krn review --help` lists all options',
  worker: 'krn worker start|send|stop --run DIR  opt-in Codex worker',
  ledger:
    'krn ledger [--since YYYY-MM-DD] [--pr N] [--limit N] [--repo OWNER/REPO] [--root DIR] [--transcripts DIR] [--json]  outcome ledger',
  eval: 'krn eval <plan|prepare|score|report|...> --experiment DIR  memory experiment harness; `krn eval` lists verbs',
  brain:
    'krn brain packet <fr40-task-id> [--arm brain|static] [--write] [--json]  FR-40 shadow packet: record ids, as-of date, tokens',
  doctor:
    'krn doctor  reports the host `krn task` entry, its commit and origin/main; exit 78 when stale or unpinned',
  state:
    'krn state check|resume|set|accept|handoff [--root DIR]  delivery-loop capsule check, resume brief and writers; check exits 1 when divergent',
  lane: 'krn lane start SLUG [--task ID] [--actor NAME] [--reason TEXT] [--root DIR]  fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; prints the path and branch',
  ci: 'krn ci wait|logs  wait: --repo OWNER/REPO --pr N --head SHA --base SHA [--timeout-seconds N] [--start-timeout-seconds N] [--merge-timeout-seconds N] (auto-merge: waits for the merge, refreshes the pinned Product entry); logs: --repo OWNER/REPO --run ID [--lines N] prints failed-job log tails across every attempt',
};

export function commandHelp(args: string[]): string | undefined {
  const [command, ...rest] = args;
  if (command === undefined) return undefined;
  // `task`, `review` and `eval` print their own, richer help.
  if (['task', 'review', 'eval'].includes(command)) return undefined;
  if (!rest.some((arg) => arg === '--help' || arg === '-h')) return undefined;
  const line = usage[command];
  return line === undefined ? undefined : `Usage: ${line}\n`;
}

export function topLevelHelp(): string {
  return `krn: delivery layer over agent harnesses\n\nOwned commands (\`krn <command> --help\`):\n${Object.values(
    usage,
  )
    .map((line) => `  ${line.split('  ')[0]}`)
    .join('\n')}\n`;
}
