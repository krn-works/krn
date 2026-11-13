// Usage text for the commands this CLI owns.
const usage: Readonly<Record<string, string>> = {
  task: 'krn task <ready|claim|show|list|create|edit|comment|dep|close|release|check> [...]  repository work tracker; `krn task` lists verbs',
  ledger:
    'krn ledger [--since YYYY-MM-DD] [--pr N] [--limit N] [--repo OWNER/REPO] [--root DIR] [--transcripts DIR] [--json]  outcome ledger',
  brain:
    'krn brain packet <fr40-task-id> [--arm brain|static] [--write] [--json]  FR-40 shadow packet: record ids, as-of date, tokens',
  standards:
    'krn standards check [--root DIR]  validate the shipped standards pack (standards/records.json) and .agents/standards.json: dates, enforcement refs and evidence paths; one PASS or FAIL line naming the standards that apply to the repository; exit 1 on a problem, 65 on a malformed file',
  doctor:
    'krn doctor  reports the host `krn task` entry, its commit and origin/main; exit 78 when stale or unpinned',
  state:
    'krn state check|resume|set|accept|handoff|retro [--root DIR]  delivery-loop capsule check, resume brief and writers; check exits 1 when divergent',
  lane: 'krn lane start|run|drop|brief [...]  run: start the lane, run one headless claude session on a task, ship the commit (exit 0 only when merged; a failed run keeps its worktree and releases the claim); drop SLUG: remove a dead lane worktree, branch and claim; start: fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; brief: print a lane brief behind the FR-40 brain packet; `krn lane` lists verbs',
  decide:
    'krn decide add|list|close [...]  operator decisions: rows with a recommendation, a default and a deadline under .krn/operator/; `list --notify` prints rows not yet announced (for the daily housekeeping run)',
  repo: 'krn repo contract [--root DIR]  print the repo contract as JSON: base branch, test, related ({files}) and fast commands, tracker; krn.json fields win over detection (Cargo.toml, go.mod, package.json, pytest markers, Makefile); exit 65 when no test command is found',
  plan: 'krn plan [--root DIR]  one line: plan points left per account (5h, 7d) from .krn/plan/samples.jsonl and the account to spend next (nearest seven-day reset)',
  adopt: `krn adopt <path> [--tracker] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD]  write krn.json from detection, the .claude/settings.json Stop hook, rules in AGENTS.md and the .krn/ ignore into a git repository; --ref SHA adds tasks/ and the ci.yml call of the shared project CI; reruns change nothing`,
  hook: 'krn hook stop  Claude Code hook entry: stdin payload in, exit 2 refuses a worker Stop (contract-driven tests); installed by `krn adopt`',
  ci: 'krn ci wait|logs  wait: --repo OWNER/REPO --pr N --head SHA --base SHA [--timeout-seconds N] [--start-timeout-seconds N] [--merge-timeout-seconds N] (auto-merge: waits for the merge, refreshes the pinned Product entry); logs: --repo OWNER/REPO --run ID [--lines N] prints failed-job log tails across every attempt',
  pr: 'krn pr ship --title TITLE --body-file PATH [--repo OWNER/REPO] [--force]  in a branch worktree: push, create the PR, enable auto-merge, wait through the merge, remove the worktree and branch; one verdict line; `krn pr body --task ID [--verified TEXT] [--refs] [--out PATH]` generates the body from the task record and commits',
};

export function commandHelp(args: string[]): string | undefined {
  const [command, ...rest] = args;
  if (command === undefined) return undefined;
  // `task` prints its own, richer help.
  if (command === 'task') return undefined;
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
