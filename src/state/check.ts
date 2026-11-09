// `krn state check`: validates the delivery-loop capsules under
// .krn/runs/delivery-loop. Each capsule is judged by an ordered list of rules;
// add a check by writing a `CapsuleRule` and appending it to CAPSULE_RULES.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ABI_LABELS,
  type CapsuleFields,
  fixedPointAnchors,
  OUTCOME_STATES,
  PUBLICATION_STATES,
  parseAcceptance,
  parseCleanup,
  readFields,
  stripMarkup,
} from './capsule.ts';
import { git } from './git.ts';
import {
  capsuleStoreReport,
  type Finding,
  isInside,
  posixRelative,
  resolveRepositoryRoot,
  runDirectoriesDetailed,
} from './runs.ts';

export interface CheckReport {
  root: string;
  git: boolean;
  applicability: 'checked' | 'no-file-backed-capsule';
  ignoredRuns: boolean | null;
  capsules: { id: string; path: string }[];
  errors: Finding[];
  warnings: Finding[];
  status: 'clean' | 'divergent' | 'not-applicable';
}

// Capsule narrative is a working record, not a history log: the four fields that
// tend to absorb status prose are bounded per field and in total.
const NARRATIVE_BUDGETS = [
  ['Evidence observed', 4096],
  ['Next bounded owner and action', 2048],
  ['Open unknowns and blockers with owners', 2048],
  ['Review fixed point and Standards / Spec disposition', 2048],
] as const;
const NARRATIVE_TOTAL_BUDGET = 8192;

function narrativeBudgetFindings(fields: CapsuleFields): string[] {
  const over: string[] = [];
  let total = 0;
  for (const [label, cap] of NARRATIVE_BUDGETS) {
    const value = fields[label];
    if (value === null) continue;
    const size = Buffer.byteLength(value, 'utf8');
    total += size;
    if (size > cap) over.push(`${label} ${size}/${cap}`);
  }
  if (total > NARRATIVE_TOTAL_BUDGET)
    over.push(`narrative total ${total}/${NARRATIVE_TOTAL_BUDGET}`);
  return over;
}

// A COMPLETE capsule's review evidence must name a repository-relative path
// that exists inside the root.
function reviewEvidenceUnresolved(root: string, token: string): string | null {
  const target = resolve(root, token.replace(/^\.\//, ''));
  return isInside(root, target) && existsSync(target)
    ? null
    : `evidence ${token} does not exist in the repository`;
}

export function normalizeRunPointer(root: string, pointer: string): string {
  // Resolve symlink aliases so one physical run reached by two names has one
  // identity; a missing pointer falls back to its normalized lexical path.
  const absolute = resolve(root, pointer);
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  return posixRelative(root, resolved);
}

// A friction candidate is a reflection awaiting an integration decision: it
// drains only when it names a task record (`deferred:<id>` or `<id>`).
const candidateText = (friction: string | null): string =>
  stripMarkup(friction ?? '');

function frictionCandidates(friction: string | null): string[] {
  return [
    ...candidateText(friction).matchAll(/\bcandidate:\s*([^\s;,`]+)/gi),
  ].map((match) => (match[1] ?? '').replace(/[.,]+$/, ''));
}

function taskRecordIds(root: string): Set<string> {
  const ids = new Set<string>();
  const directory = join(root, 'tasks');
  try {
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      return ids;
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      try {
        const record: unknown = JSON.parse(
          readFileSync(join(directory, file.name), 'utf8'),
        );
        const id = (record as { id?: unknown }).id;
        if (typeof id === 'string' && `${id}.json` === file.name) ids.add(id);
      } catch {
        // An unreadable record resolves no candidate.
      }
    }
  } catch {
    // An absent task directory resolves no candidate.
  }
  return ids;
}

function fixedPointErrors(
  root: string,
  fixedPoint: string,
  canCheckCommits: boolean,
): Finding[] {
  const errors: Finding[] = [];
  for (const match of fixedPoint.matchAll(
    /\b(base|HEAD|fingerprint)\s*=\s*([^\s,;]+)/gi,
  )) {
    const label = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').replace(/[`<>]/g, '');
    if (label === 'fingerprint') continue;
    if (!/^[0-9a-f]+$/i.test(value)) {
      errors.push({
        rule: 'invalid-fixed-point',
        detail: `${label}=${value} is not a commit token`,
      });
      continue;
    }
    const token = value.toLowerCase();
    if (token.length !== 40 && token.length !== 64) {
      errors.push({
        rule: 'invalid-fixed-point',
        detail: `partial token ${token}`,
      });
    } else if (
      canCheckCommits &&
      !git(root, ['cat-file', '-e', `${token}^{commit}`]).ok
    ) {
      errors.push({ rule: 'invalid-fixed-point', detail: token });
    }
  }
  return errors;
}

interface RuleContext {
  root: string;
  id: string;
  text: string;
  fields: CapsuleFields;
  outcome: string | null;
  state: { relativePath: string; resolvedRelativePath?: string };
  usableGit: boolean;
  hasGit: boolean;
  currentHead: { ok: boolean; out: string };
  taskIds: ReadonlySet<string>;
  containedInRepo: (relative: string) => boolean;
  ignored: { checked: number; ignored: number };
  listedRunPointers: Set<string>;
  runOwners: Map<string, string>;
  errors: Finding[];
  warnings: Finding[];
}

type CapsuleRule = (ctx: RuleContext) => void;

const isOutcome = (ctx: RuleContext, value: string) =>
  ctx.outcome !== null && stripMarkup(ctx.outcome) === value;

const gitIgnoredRule: CapsuleRule = (ctx) => {
  const { id, root, errors, warnings } = ctx;
  if (ctx.hasGit && !ctx.usableGit) {
    errors.push({ id, rule: 'not-a-git-worktree', detail: root });
  } else if (!ctx.hasGit) {
    errors.push({ id, rule: 'git-unavailable', detail: 'git is not on PATH' });
  } else {
    const ignorePath = ctx.state.resolvedRelativePath ?? ctx.state.relativePath;
    const ignore = git(root, ['check-ignore', '-q', ignorePath]);
    ctx.ignored.checked += 1;
    if (ignore.ok) ctx.ignored.ignored += 1;
    else if (ignore.status === 1)
      errors.push({
        id,
        rule: 'runs-not-ignored',
        detail: `${ignorePath} is not git-ignored`,
      });
    else
      warnings.push({
        id,
        rule: 'gitignore-unverified',
        detail: `${ignorePath}: git check-ignore failed`,
      });
  }
};

const fieldsRule: CapsuleRule = (ctx) => {
  const { id, fields, text, errors } = ctx;
  for (const [label, value] of Object.entries(fields)) {
    if (value === null || stripMarkup(value) === '')
      errors.push({ id, rule: 'missing-field', detail: label });
    else if (/<fill\b/.test(value))
      errors.push({ id, rule: 'unresolved-placeholder', detail: label });
  }
  for (const label of ABI_LABELS) {
    const occurrences = text
      .split('\n')
      .filter((line) => line.trimStart().startsWith(`${label}:`)).length;
    if (occurrences > 1)
      errors.push({ id, rule: 'duplicate-field', detail: label });
  }
  const overBudget = narrativeBudgetFindings(fields);
  if (overBudget.length > 0)
    errors.push({
      id,
      rule: 'capsule-narrative-over-budget',
      detail: `${overBudget.join('; ')}; history belongs in the run ledger`,
    });
};

const acceptanceRule: CapsuleRule = (ctx) => {
  const { id, errors, warnings } = ctx;
  const acceptance = ctx.fields['Outcome and observable acceptance'];
  if (
    acceptance &&
    !/`[^`]+`/.test(acceptance) &&
    !/[\\/]|--|\btest\b|\bcheck\b/.test(acceptance)
  )
    warnings.push({
      id,
      rule: 'vague-acceptance',
      detail:
        'acceptance names no command, path, or code marker; state the check the next session can run',
    });
  const ledger = parseAcceptance(acceptance ?? '');
  for (const entryText of ledger.malformed)
    errors.push({ id, rule: 'malformed-acceptance', detail: entryText });
  if (isOutcome(ctx, 'ACTIVE') && !ledger.ledger)
    warnings.push({
      id,
      rule: 'acceptance-without-ledger',
      detail:
        'record each criterion as [criterion; todo|pass|drop:<why>] so the next session can re-verify it',
    });
  if (isOutcome(ctx, 'COMPLETE')) {
    const open = ledger.items.filter((item) => item.status === 'todo');
    if (open.length > 0)
      errors.push({
        id,
        rule: 'complete-with-open-acceptance',
        detail: open.map((item) => item.criterion).join(', '),
      });
  }
};

const dispositionRule: CapsuleRule = (ctx) => {
  const disposition =
    ctx.fields['Review fixed point and Standards / Spec disposition'];
  if (
    disposition &&
    !/^(none|pending|not-applicable)$/i.test(stripMarkup(disposition)) &&
    !/evidence=/.test(disposition) &&
    !/`[^`]+`/.test(disposition)
  )
    ctx.warnings.push({
      id: ctx.id,
      rule: 'disposition-without-evidence',
      detail: 'store the executed command, its exit, and the fixed point',
    });
};

const statesRule: CapsuleRule = (ctx) => {
  const { outcome } = ctx;
  const publication = ctx.fields['Publication state'];
  if (outcome && !OUTCOME_STATES.has(stripMarkup(outcome)))
    ctx.errors.push({
      id: ctx.id,
      rule: 'invalid-outcome-state',
      detail: outcome,
    });
  if (publication && !PUBLICATION_STATES.has(stripMarkup(publication)))
    ctx.errors.push({
      id: ctx.id,
      rule: 'invalid-publication-state',
      detail: publication,
    });
};

const frictionRule: CapsuleRule = (ctx) => {
  const friction = ctx.fields['Workflow friction and lesson candidates'];
  const complete = isOutcome(ctx, 'COMPLETE');
  for (const token of frictionCandidates(friction)) {
    const deferred = /^deferred:(.+)$/i.exec(token);
    if (ctx.taskIds.has(deferred ? (deferred[1] ?? '') : token)) continue;
    const finding = { id: ctx.id, rule: 'dangling-candidate', detail: token };
    (complete ? ctx.errors : ctx.warnings).push(finding);
  }
  if (!complete) return;
  const residue = candidateText(friction)
    .replace(/\bcandidate:\s*[^\s;,`]+/gi, '')
    .replace(/[;,\s]+/g, '');
  if (residue.length > 0 && !/^none$/i.test(residue))
    ctx.errors.push({
      id: ctx.id,
      rule: 'complete-with-friction',
      detail: candidateText(friction),
    });
};

const restartRule: CapsuleRule = (ctx) => {
  const restart = ctx.fields['Restart state'];
  if (restart && stripMarkup(restart) !== 'ABSENT') {
    const restartPath = stripMarkup(restart);
    if (!ctx.containedInRepo(restartPath))
      ctx.errors.push({
        id: ctx.id,
        rule: 'restart-path-outside-repo',
        detail: restartPath,
      });
    else if (!existsSync(resolve(ctx.root, restartPath)))
      ctx.errors.push({
        id: ctx.id,
        rule: 'restart-path-missing',
        detail: restartPath,
      });
  }
};

const cleanupRule: CapsuleRule = (ctx) => {
  const cleanup = ctx.fields['Outstanding workflow-run cleanup'];
  if (!cleanup || stripMarkup(cleanup) === 'none') return;
  const { id, root, errors } = ctx;
  const parsed = parseCleanup(stripMarkup(cleanup));
  for (const entryText of parsed.malformed)
    errors.push({ id, rule: 'malformed-cleanup', detail: entryText });
  for (const entry of parsed.entries) {
    const normalized = normalizeRunPointer(root, entry.pointer);
    let ownerKey = normalized;
    try {
      ownerKey = realpathSync(resolve(root, entry.pointer));
    } catch {
      // keep normalized
    }
    const owner = ctx.runOwners.get(ownerKey);
    if (owner && owner !== id)
      errors.push({
        id,
        rule: 'duplicate-run-consumer',
        detail: `${entry.pointer} already owned by ${owner}`,
      });
    else ctx.runOwners.set(ownerKey, id);
    ctx.listedRunPointers.add(normalized);
    if (!ctx.containedInRepo(entry.pointer))
      errors.push({
        id,
        rule: 'cleanup-pointer-outside-repo',
        detail: entry.pointer,
      });
    else if (
      (entry.state === 'ACTIVE' || entry.state === 'BLOCKED') &&
      !existsSync(resolve(root, entry.pointer))
    )
      errors.push({
        id,
        rule: 'ghost-cleanup-entry',
        detail: `${entry.pointer} (${entry.state})`,
      });
  }
};

const fixedPointRule: CapsuleRule = (ctx) => {
  const fixedPoint =
    ctx.fields[
      'Repository base, HEAD or working-tree fingerprint, and dirty-state scope'
    ];
  if (!fixedPoint) return;
  const { id, errors, warnings } = ctx;
  for (const finding of fixedPointErrors(ctx.root, fixedPoint, ctx.usableGit))
    errors.push({ id, ...finding });
  const commits = [
    ...fixedPoint
      .replace(/[<>`]/g, '')
      .matchAll(/\b(base|HEAD)\s*=\s*([0-9a-f]{40}|[0-9a-f]{64})\b/gi),
  ].map((match) => (match[2] ?? '').toLowerCase());
  const anchorHead = fixedPointAnchors(fixedPoint).head;
  if (
    !/\b(base|HEAD|fingerprint)\s*=\s*[^\s,;]+/i.test(stripMarkup(fixedPoint))
  ) {
    const finding = {
      id,
      rule: 'missing-fixed-point',
      detail: stripMarkup(fixedPoint),
    };
    (isOutcome(ctx, 'ACTIVE') ? errors : warnings).push(finding);
  }
  if (isOutcome(ctx, 'COMPLETE') && anchorHead === null)
    // A COMPLETE outcome needs an end anchor: a base-only fixed point cannot
    // detect that HEAD advanced after completion.
    errors.push({
      id,
      rule: 'complete-without-commit-anchor',
      detail: stripMarkup(fixedPoint),
    });
  if (
    anchorHead !== null &&
    ctx.currentHead.ok &&
    anchorHead !== ctx.currentHead.out.toLowerCase()
  ) {
    const stale = {
      id,
      rule: 'stale-fixed-point',
      detail: `capsule records ${commits.join(', ')} but HEAD is ${ctx.currentHead.out}`,
    };
    (isOutcome(ctx, 'COMPLETE') ? errors : warnings).push(stale);
  }
};

const nextActionRule: CapsuleRule = (ctx) => {
  const next = ctx.fields['Next bounded owner and action'];
  if (
    isOutcome(ctx, 'ACTIVE') &&
    next &&
    /^(none|n\/a|tbd)$/i.test(stripMarkup(next))
  )
    ctx.errors.push({
      id: ctx.id,
      rule: 'active-without-next',
      detail: stripMarkup(next),
    });
};

const completeRule: CapsuleRule = (ctx) => {
  if (!isOutcome(ctx, 'COMPLETE')) return;
  const { id, root, errors, fields } = ctx;
  const cleanup = fields['Outstanding workflow-run cleanup'];
  const restart = fields['Restart state'];
  if (cleanup && stripMarkup(cleanup) !== 'none')
    errors.push({
      id,
      rule: 'complete-with-cleanup',
      detail: 'COMPLETE capsules must have no outstanding cleanup',
    });
  if (restart && stripMarkup(restart) !== 'ABSENT')
    errors.push({
      id,
      rule: 'complete-with-restart',
      detail: stripMarkup(restart),
    });
  const review = fields['Review fixed point and Standards / Spec disposition'];
  const reviewText = review ? stripMarkup(review).trim() : '';
  if (/^(pending|unreviewed|not[ _-]?reviewed|tbd)\b/i.test(reviewText)) {
    errors.push({
      id,
      rule: 'complete-with-pending-review',
      detail: reviewText,
    });
  } else if (review && !/^(none|not-applicable)$/i.test(reviewText)) {
    const evidence = review.match(/evidence\s*=\s*([^\s;,`]+)/i);
    if (
      !evidence ||
      /^(none|n\/a|na|tbd|-|pending)$/i.test(evidence[1] ?? '')
    ) {
      errors.push({
        id,
        rule: 'complete-review-without-evidence',
        detail: reviewText,
      });
    } else {
      const unresolved = reviewEvidenceUnresolved(
        root,
        (evidence[1] ?? '').replace(/[<>]/g, ''),
      );
      if (unresolved)
        errors.push({
          id,
          rule: 'complete-review-evidence-unresolved',
          detail: unresolved,
        });
    }
  }
  const participants =
    fields['Native Goal identity/state and configured tracker item/state'];
  const participantText = participants ? stripMarkup(participants) : '';
  const active =
    /\bstate\s*[=:]\s*["']?(active|open|in[ _-]?progress|blocked|deferred|running)\b/i.test(
      participantText,
    ) ||
    /\((?:active|open|in[ _-]?progress|blocked|deferred|running)\)/i.test(
      participantText,
    );
  if (participants && active)
    errors.push({
      id,
      rule: 'complete-with-active-participant',
      detail: participantText,
    });
};

// Order matters only within errors and within warnings; keep it stable.
export const CAPSULE_RULES: readonly CapsuleRule[] = [
  gitIgnoredRule,
  fieldsRule,
  acceptanceRule,
  dispositionRule,
  statesRule,
  frictionRule,
  restartRule,
  cleanupRule,
  fixedPointRule,
  nextActionRule,
  completeRule,
];

export function inspectState(repo: string): CheckReport {
  const { root, hasGit } = resolveRepositoryRoot(repo);
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const capsules: { id: string; path: string }[] = [];
  const listedRunPointers = new Set<string>();
  const runOwners = new Map<string, string>();
  const ignored = { checked: 0, ignored: 0 };
  const gitRepo = hasGit
    ? git(root, ['rev-parse', '--is-inside-work-tree'])
    : { ok: false, out: '' };
  const usableGit = gitRepo.ok && gitRepo.out === 'true';

  const { storeErrors, entries } = capsuleStoreReport(root);
  for (const error of storeErrors)
    errors.push({ id: 'runs', rule: error.rule, detail: error.detail });
  const candidates = [...entries].sort(
    (left, right) =>
      Number(left.link) - Number(right.link) || left.id.localeCompare(right.id),
  );

  const taskIds = taskRecordIds(root);
  const currentHead = usableGit
    ? git(root, ['rev-parse', 'HEAD'])
    : { ok: false, out: '' };
  const seenDirectories = new Set<string>();
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // keep lexical
  }
  const containedInRepo = (relative: string): boolean => {
    if (!isInside(root, relative)) return false;
    try {
      return isInside(realRoot, realpathSync(resolve(root, relative)));
    } catch {
      return true;
    }
  };

  for (const entry of candidates) {
    if (entry.kind === 'resolve') {
      errors.push({
        id: entry.id,
        rule: 'unreadable-capsule',
        detail: `${entry.id} cannot be resolved`,
      });
      continue;
    }
    if (entry.resolvedDirectory !== undefined) {
      if (seenDirectories.has(entry.resolvedDirectory)) continue;
      seenDirectories.add(entry.resolvedDirectory);
    }
    if (entry.error) {
      errors.push({ id: entry.id, ...entry.error });
      continue;
    }
    const state = entry.state;
    if (!state) continue;
    capsules.push({ id: entry.id, path: state.relativePath });
    const fields = readFields(state.text);
    const ctx: RuleContext = {
      root,
      id: entry.id,
      text: state.text,
      fields,
      outcome: fields['Outcome state'],
      state,
      usableGit,
      hasGit,
      currentHead,
      taskIds,
      containedInRepo,
      ignored,
      listedRunPointers,
      runOwners,
      errors,
      warnings,
    };
    for (const rule of CAPSULE_RULES) rule(ctx);
  }

  const inventory = runDirectoriesDetailed(root);
  for (const detail of inventory.errors)
    errors.push({ id: 'runs', rule: 'unreadable-run-inventory', detail });
  if (capsules.length > 0) {
    for (const run of inventory.runs) {
      if (!listedRunPointers.has(normalizeRunPointer(root, run.pointer)))
        errors.push({
          id: run.workflow,
          rule: 'orphaned-run',
          detail: run.pointer,
        });
    }
  }

  return {
    root,
    git: hasGit,
    applicability: capsules.length > 0 ? 'checked' : 'no-file-backed-capsule',
    ignoredRuns:
      ignored.checked === 0 ? null : ignored.ignored === ignored.checked,
    capsules,
    errors,
    warnings,
    status:
      errors.length > 0
        ? 'divergent'
        : capsules.length > 0
          ? 'clean'
          : 'not-applicable',
  };
}
