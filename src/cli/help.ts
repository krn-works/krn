// Usage text for the commands this CLI owns; any other command forwards to the legacy entry (ADR 0001).
const usage: Readonly<Record<string, string>> = {
  task: 'krn task <ready|claim|show|list|create|edit|dep|close|release|check> [...]  repository work tracker; `krn task` lists verbs',
  review:
    'krn review --repo PATH --base REF --head SHA --lens PATH [--panel ...] [--pr N]  opt-in review panel; `krn review --help` lists all options',
  worker: 'krn worker start|send|stop --run DIR  opt-in Codex worker',
  delegate:
    'krn delegate --input FILE... [--brief FILE...] [--repo PATH] [--results DIR] [--concurrency N] [--timeout-ms N]  run bounded Codex jobs',
  ledger:
    'krn ledger [--since YYYY-MM-DD] [--pr N] [--limit N] [--repo OWNER/REPO] [--root DIR] [--transcripts DIR] [--json]  outcome ledger',
  start:
    'krn start --job ID --issue ID [--base REF] [--force]  open a job worktree',
  checkpoint:
    'krn checkpoint --job ID --issue ID --worktree PATH --intent TEXT --session ID --message TEXT --next TEXT [--decision TEXT] [--repo-root PATH]',
  stop: 'krn stop --job ID --issue ID --worktree PATH [--repo-root PATH]',
  note: 'krn note --job ID --issue ID --worktree PATH --kind intervention|reconstruction (--text TEXT | stdin) [--repo-root PATH]',
  eval: 'krn eval <plan|prepare|...> --experiment DIR  memory experiment harness; `krn eval` lists verbs',
  ci: 'krn ci wait --repo OWNER/REPO --pr N --head SHA --base SHA [--timeout-seconds N]',
  report: 'krn report journey --job ID --repo PATH [--stage ...]',
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
    .join(
      '\n',
    )}\n\nEvery other command forwards to the legacy entry, whose own usage follows.\n`;
}
