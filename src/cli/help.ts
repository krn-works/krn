// Usage text for the commands this CLI owns.
const usage: Readonly<Record<string, string>> = {
  task: 'krn task <ready|claim|show|list|create|edit|comment|dep|close|release|check> [...]  repository work tracker; `krn task` lists verbs',
  ledger:
    'krn ledger [--since YYYY-MM-DD] [--pr N] [--limit N] [--repo OWNER/REPO] [--root DIR] [--transcripts DIR] [--json]  outcome ledger',
  standards:
    "krn standards check|propose|harvest [...]  check [--root DIR]: run the enforcement of every standard that applies to a repository top level (the shipped standards/records.json plus the own records of .agents/standards.json; a copy `krn adopt` marked with origin krn runs as the current pack record and fails when the pack no longer holds it): 'command' and 'krn' standards run there, 'advisory' ones are only counted, and a pack record promoted from proposals (`harvested`) must come from 2 repositories, 3 proposals or an https source and carry an enforcement; one PASS or FAIL line with enforced, failed and advisory counts, one stderr line per failure naming the standard and its exit; exit 1 on a failure, 65 on a malformed file, 66 when the root or a file cannot be read. propose --text TEXT --kind check|template|skill|prose --evidence REF [--evidence REF]... [--root DIR]: write one tracked retro lesson to .agents/standards-proposals/ (an equal lesson is kept, not duplicated). harvest [REPO...] [--root DIR]: group the proposals of the given repositories (else the JSON path array in the untracked .krn/adopted.json) by normalized text and print one candidate line per lesson with its count, origins and evidence",
  doctor:
    'krn doctor  reports the host `krn task` entry, its commit and origin/main; exit 78 when stale or unpinned; `krn doctor --unattended [--window-hours N]` exits 0 only when an App token mints and the bw serve session outlives the window (default 8h), else 69 (mint) or 75 (vault) with the remedy',
  state:
    'krn state check|resume|set|accept|handoff|retro [--root DIR]  delivery-loop capsule check, resume brief and writers; check exits 1 when divergent',
  lane: 'krn lane start|run|drop|brief [...]  run: start the lane, run one headless claude session on a task, ship the commit (exit 0 only when merged; a failed run keeps its worktree and releases the claim); drop SLUG: remove a dead lane worktree, branch and claim; start: fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; brief: print a lane brief behind the FR-40 brain packet; `krn lane` lists verbs',
  decide:
    'krn decide add|list|close [...]  operator decisions: rows with a recommendation, a default and a deadline under .krn/operator/; `list --notify` prints rows not yet announced (for the daily housekeeping run)',
  repo: 'krn repo contract [--root DIR]  print the repo contract as JSON: base branch, test, related ({files}) and fast commands, tracker; krn.json fields win over detection (Cargo.toml, go.mod, package.json, pytest markers, Makefile); exit 65 with the fields to write when no test command is found',
  plan: 'krn plan [--root DIR]  one line: plan points left per account (5h, 7d) from .krn/plan/samples.jsonl and the account to spend next (nearest seven-day reset)',
  adopt: `krn adopt <path> [--tracker] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD]  write krn.json from detection, the .claude/settings.json Stop hook, rules in AGENTS.md and the .krn/ ignore into a git repository; --ref SHA adds tasks/ and the ci.yml call of the shared project CI; reruns change nothing`,
  hook: 'krn hook stop|scope [--check|--related]  Claude Code hook entry: stdin payload in; stop exits 2 to refuse a worker Stop (contract-driven tests), --check runs the related tests, --related lists them; scope refuses a worker write to tracker state outside its Scope; stop is installed by `krn adopt`',
  ci: 'krn ci wait|logs  wait: --repo OWNER/REPO --pr N --head SHA --base SHA [--timeout-seconds N] [--start-timeout-seconds N] [--merge-timeout-seconds N] (auto-merge: waits for the merge, refreshes the pinned Product entry); logs: --repo OWNER/REPO --run ID [--lines N] prints failed-job log tails across every attempt',
  pr: 'krn pr ship --title TITLE --body-file PATH [--repo OWNER/REPO] [--force]  in a branch worktree: push, create the PR, enable auto-merge, wait through the merge, remove the worktree and branch; one verdict line; `krn pr body --task ID [--verified TEXT] [--refs] [--out PATH]` generates the body from the task record and commits',
};

/** One `krn <command> ...  <description>` line per owned command, for the capability index. */
export function commandLines(): string[] {
  return Object.values(usage);
}

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
