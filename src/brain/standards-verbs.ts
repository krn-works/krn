// The one table of `krn standards` verbs: name, synopsis and help. The handlers are bound to these
// names in src/cli/standards-router.ts, whose type requires one per verb here, so `--help`, the
// usage error and the dispatch cannot drift apart.

export const standardsVerbs = {
  check: {
    synopsis: ['check [--record ID | --tasks] [--root DIR]'],
    help: "check [--record ID] [--root DIR]: run the enforcement of every standard that applies to a repository top level (the shipped standards/records.json plus the own records of .agents/standards.json; a copy `krn adopt` marked with origin krn runs as the current pack record and fails when the pack no longer holds it): 'command' and 'krn' standards run there, 'advisory' ones are only counted, and a pack record promoted from proposals (`harvested`) must come from 2 repositories, 3 proposals or an https source and carry an enforcement; one PASS or FAIL line with enforced, failed and advisory counts, one stderr line per failure naming the standard and its exit; with --record ID only that record is judged (exit 0 when it passes whatever else is red, 1 when it fails or no record has that id); exit 1 on a failure, 65 on a malformed file, 66 when the root or a file cannot be read.",
  },
  install: {
    synopsis: ['install --global [--check]'],
    help: 'install --global [--check]: write the universal standards to the user level instruction files; with --check only report drift (exit 1 on drift)',
  },
  propose: {
    synopsis: [
      'propose --text TEXT --kind check|template|skill|prose --evidence REF [--evidence REF]... [--root DIR]',
    ],
    help: 'propose --text TEXT --kind check|template|skill|prose --evidence REF [--evidence REF]... [--root DIR]: write one tracked retro lesson to .agents/standards-proposals/ (an equal lesson is kept, not duplicated).',
  },
  harvest: {
    synopsis: [
      'harvest [--from-ledger] [REPO...] [--root DIR]',
      'harvest --skills REPO [--commit SHA]',
      'harvest --repos [DIR...] [--repos-file FILE]',
    ],
    help: "harvest --skills REPO [--commit SHA] [--rules]: with --rules print one accepted advisory record per rule of the known skills in .claude/skills and .agents/skills of REPO (one short imperative sentence, applies.stacks or paths, evidence the source file:line and the commit) instead; otherwise print one trial record (advisory, audience worker, needs wordpress or frontend, path globs, provenance the skill path and the commit that last changed .claude/skills) per .claude/skills/*/SKILL.md of REPO as a JSON array, reading REPO and never writing it. harvest [--from-ledger] [REPO...] [--root DIR]: group the proposals of the given repositories (else the host registry `krn adopt` appends to, ~/.krn/adopted.json or the file KRN_ADOPTED_REGISTRY names, or with --root the JSON path array in that repository's untracked .krn/adopted.json) by normalized text; --from-ledger adds one proposal per merged PR the outcome ledger shows reworked (changed or reverted) or with a rerun of the required check, evidenced by #PR (reads GitHub through gh in each repository) and print one candidate line per lesson with its count, origins and evidence.",
  },
  effect: {
    synopsis: ['effect [--overlap] [--root DIR]'],
    help: "effect [--overlap] [--root DIR]: with --overlap print one line, the mean Jaccard overlap of the served record sets of different tasks (session and lane packets, a task's sets united); otherwise read the append-only .krn/brain/exposures.jsonl every run writes (krn.exposure/v1: {at,run,task,channel,attempt,served,withheld,tokens,violated,outcome,lane_ok}) and print one row per record with its served and withheld runs (a task counts once per record and arm) and how often the record's own check failed on the final diff in each arm.",
  },
  retire: {
    synopsis: ['retire [--write] [--root DIR]'],
    help: "retire [--write] [--root DIR]: list the own records (the conventions file and .agents/standards.json) with at least 30 served and 10 withheld scoped diffs whose served diffs show no benefit under Fisher's exact test (one-sided p >= 0.1; one prose record in ten is withheld per task by a hash of task and record id); --write sets their valid_to to today for a PR to carry, and the operator vetoes by closing it",
  },
  review: {
    synopsis: ['review [--root DIR]'],
    help: 'review [--root DIR]: the enforced records the diff can break, with offending file:line; exit 1 on a violation',
  },
  query: {
    synopsis: [
      'query TEXT [--file PATH]... [--stack S] [--budget TOKENS] [--task ID] [--type TYPE] [--json] [--root DIR]',
    ],
    help: 'query TEXT [--file PATH]... [--stack S] [--budget N] [--json]: ranked records for what you are doing now.',
  },
} as const satisfies Readonly<
  Record<string, { synopsis: readonly string[]; help: string }>
>;

export type StandardsVerb = keyof typeof standardsVerbs;

export function isStandardsVerb(
  name: string | undefined,
): name is StandardsVerb {
  return name !== undefined && Object.hasOwn(standardsVerbs, name);
}

/** The usage error text: every synopsis of the table. */
export const usage = `usage: krn standards ${Object.values(standardsVerbs)
  .flatMap((verb) => verb.synopsis)
  .join(' | ')}`;

/** The `krn standards --help` text: the verb list, then each verb's help from the table. */
export function standardsHelp(): string {
  const names = Object.keys(standardsVerbs).join('|');
  const verbs = Object.values(standardsVerbs).map((verb) => verb.help);
  return `krn standards ${names} [...]  ${verbs.join(' ')}`;
}
