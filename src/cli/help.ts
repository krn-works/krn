// Usage text for the commands this CLI owns.
import { standardsHelp } from '../brain/standards-verbs.ts';

const usage = {
  task: 'krn task <ready|claim|show|list|create|edit|comment|dep|close|release|check> [...]  repository work tracker; `krn task` lists verbs',
  ledger:
    'krn ledger [--window FROM TO | --last N] [--since YYYY-MM-DD] [--pr N] [--limit N] [--repo OWNER/REPO] [--root DIR] [--transcripts DIR] [--json]  outcome ledger; --predictions scores Predicted: lines (proof line, outside rows after the task merge, metric from spec/metrics.json); --predictions --share prints the share of docs/program/plan.md slices scored; --dollars [--limit N] [--json] prints dollars per merged PR and per first-push-green PR (slice cost joined with first-push-green); --advisor-trial [--limit N] [--min-units N] [--json] compares lane PRs with and without the Fable advisor (arm from the PR body line) on first-push-green and CI rounds, flagging a win carried by fewer than N (default 5) measured units; --effort-policy [--limit N] [--json] compares lane PRs before and under the effort policy (low effort, high after a red Check; arm from the PR body `Lane effort:` line) on first-push-green and cost per PR; --reverts [--limit N] [--json] prints reverts/merged over the last N (default 50) merged PRs, a revert being a merged PR titled Revert "..." matched to the PR it undoes; --first-push-green [--limit N] [--share] [--json] prints the share of the last N (default 50) merged PRs whose first pushed head got a green Check and the CI rounds per PR',
  standards: standardsHelp(),
  doctor:
    'krn doctor  reports the host `krn task` entry, its commit and origin/main; exit 78 when stale or unpinned; lists each registered adopted repository that lacks pack records (`pack-stale=`) and exits 65 with the remedy `krn adopt --refresh-all`; lists each task claim older than `--claim-hours N` (default 6) whose branch has no commit beyond the base (`claim-stale=`) and exits 66; `krn doctor --unattended [--window-hours N] [--root <repo>]` exits 0 only when an App token mints and the bw serve session outlives the window (default 8h), else 69 (mint), 75 (vault) or, with --root, 67 (GitHub App not installed on the repository) with the remedy',
  state:
    'krn state check|resume|set|accept|handoff|retro|tidy [--root DIR]  delivery-loop capsule and .krn/ layout check, resume brief and writers; check exits 1 when divergent; tidy [--dry-run] moves strays and applies retention',
  lane: 'krn lane start|run|drop|finish|brief|status [...]  run: start the lane, run one headless claude session on a task, ship the commit (exit 0 only when merged; a failed run keeps its worktree and releases the claim); drop SLUG: remove a dead lane worktree, branch and claim; finish SLUG: ship a pushed lane branch from its recorded notes; start: fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; status: one line per lane worktree, live, merged or orphaned (committed, no PR, no live ship); brief: print a lane brief behind the FR-40 brain packet; `krn lane` lists verbs',
  findings:
    'krn findings validate <file>  check review findings JSON: confirmed needs path:line evidence, a reproduce command and a verifier other than the finder; needs_validation carries no severity; exit 1 on a problem',
  repo: 'krn repo contract [--root DIR]  print the repo contract as JSON: base branch, test, related ({files}) and fast commands, tracker; krn.json fields win over detection (Cargo.toml, go.mod, package.json, pytest markers, Makefile); exit 65 with the fields to write when no test command is found; `krn repo golden record|check --url BASE_URL [--declare PATH]... [--root DIR]` crawls the sitemap of a running site (golden-master/config.json: sitemap path, dbFixture imported with `wp db import`), normalises nonces, timestamps and asset hashes, and record stores the HTML under golden-master/pages while check exits 1 on every page diff not named by --declare; `krn repo settings [--repo OWNER/NAME] [--apply]` prints a `gap <setting>` line per merge setting that differs from the convention (squash only, squash title PR_TITLE, squash body PR_BODY, delete branch on merge, auto-merge allowed) and exits 1, and --apply sets them with one gh api PATCH',
  prune:
    'krn prune [--days N] [--dry-run] [--root DIR]  free the disk agent work leaves: removes merged clean lane worktrees under .krn/worktrees with no live process (merging the tip into origin/<base> changes nothing; claimed, fresh, dirty and untracked-dirty ones are kept and listed), scratch/ directories of runs idle for an hour, and with --days runs older than N days in owners the .krn layout does not keep (a KEEP file keeps a run); prints bytes freed per class and one verdict line',
  plan: 'krn plan [--root DIR]  one line: plan points left per account (5h, 7d) from .krn/plan/samples.jsonl and the account to spend next (nearest seven-day reset)',
  adopt: `krn adopt <path> [--tracker] [--ref SHA [--install|--lint|--typecheck CMD]] [--test CMD] [--init [--stack S]]  write krn.json from detection, the .claude/settings.json Stop hook, rules in AGENTS.md and the .krn/ ignore into a git repository; --ref SHA adds tasks/ and the ci.yml call of the shared project CI; reruns change nothing; --init first runs git init on main with a minimal real test for an empty or non-git directory`,
  hook: 'krn hook stop|scope [--check|--related]  Claude Code hook entry: stdin payload in; stop only reports and exits 0 (contract-driven tests), --check runs the related tests, --related lists them; scope refuses a worker write to tracker state outside its Scope; stop is installed by `krn adopt`',
  pr: 'krn pr ship --title TITLE --body-file PATH [--repo OWNER/REPO] [--force]  in a branch worktree: run the task Proof commands, push, create the PR, enable auto-merge, watch the required Check with gh, keep the worktree for the next lane start to prune; one verdict line; `krn pr body --task ID [--verified TEXT] [--refs] [--out PATH]` generates the body from the task record and commits',
} as const satisfies Readonly<Record<string, string>>;

/** The one list of owned commands: the router table (index.ts) is typed by it. */
export type CommandName = keyof typeof usage;

export function isCommand(name: string | undefined): name is CommandName {
  return name !== undefined && Object.hasOwn(usage, name);
}

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
  const line = isCommand(command) ? usage[command] : undefined;
  return line === undefined ? undefined : `Usage: ${line}\n`;
}

export function topLevelHelp(): string {
  return `krn: delivery layer over agent harnesses\n\nOwned commands (\`krn <command> --help\`):\n${Object.values(
    usage,
  )
    .map((line) => `  ${line.split('  ')[0]}`)
    .join('\n')}\n`;
}
