// `krn state resume`: the brief a fresh session reads before it continues a capsule.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fieldLine,
  fixedPointAnchors,
  parseCleanup,
  stripMarkup,
} from './capsule.ts';
import {
  type CheckReport,
  inspectState,
  normalizeRunPointer,
} from './check.ts';
import { git, gitRaw } from './git.ts';
import { type Finding, runDirectoriesDetailed } from './runs.ts';

function porcelain(root: string): string[] | null {
  const status = gitRaw(root, ['status', '--porcelain']);
  if (!status.ok) return null;
  return status.out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

const NO_LESSONS = 'workflow lessons: none';

function renderErrors(errors: Finding[]): string {
  if (errors.length === 0) return '';
  return `\n\nBlocking errors:\n${errors
    .map((error) => `- ${error.rule}${error.detail ? `: ${error.detail}` : ''}`)
    .join('\n')}`;
}

interface ResumeReport {
  root: string;
  applicability: 'checked' | 'no-file-backed-capsule';
  status: CheckReport['status'];
  capsules: unknown[];
  errors: Finding[];
  warnings: Finding[];
  text: string;
}

export function resumeBrief(repo: string): ResumeReport {
  const report = inspectState(repo);
  const errors = [...report.errors];
  const warnings = [...report.warnings];
  if (report.capsules.length === 0) {
    return {
      root: report.root,
      applicability: 'no-file-backed-capsule',
      status: report.status,
      capsules: [],
      errors,
      warnings,
      text: `No file-backed outcome capsule found under .krn/runs/delivery-loop/.${renderErrors(errors)}\n\n${NO_LESSONS}`,
    };
  }

  const liveHead = git(report.root, ['rev-parse', 'HEAD']);
  const liveDirty = porcelain(report.root);
  if (liveDirty === null)
    errors.push({
      rule: 'dirty-state-unavailable',
      detail: 'git status failed; the live dirty scope is unknown, not clean',
    });
  const { runs: liveRunList, errors: liveRunErrors } = runDirectoriesDetailed(
    report.root,
  );
  for (const detail of liveRunErrors)
    if (
      !errors.some(
        (error) =>
          error.rule === 'unreadable-run-inventory' && error.detail === detail,
      )
    )
      errors.push({ rule: 'unreadable-run-inventory', detail });
  const liveRuns = new Set(liveRunList.map((run) => run.pointer));

  const briefs = [];
  for (const capsule of report.capsules) {
    const path = join(report.root, capsule.path);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      errors.push({ rule: 'unreadable-capsule', detail: capsule.path });
      continue;
    }
    const field = (label: string) => fieldLine(text, label);
    const anchors = fixedPointAnchors(
      field(
        'Repository base, HEAD or working-tree fingerprint, and dirty-state scope',
      ),
    );
    const recorded = [anchors.base, anchors.head].filter(
      (value): value is string => value !== null,
    );
    const anchorHead = anchors.head;
    const headMoved =
      liveHead.ok &&
      liveHead.out !== '' &&
      anchorHead !== null &&
      anchorHead !== liveHead.out.toLowerCase();
    const cleanupValue = field('Outstanding workflow-run cleanup');
    const listed =
      cleanupValue === null
        ? []
        : parseCleanup(stripMarkup(cleanupValue)).entries;
    const listedPointers = new Set(
      listed.map((entry) => normalizeRunPointer(report.root, entry.pointer)),
    );
    const missingRuns = [
      ...new Set(
        listed
          .filter(
            (entry) =>
              !liveRuns.has(normalizeRunPointer(report.root, entry.pointer)),
          )
          .map((entry) => normalizeRunPointer(report.root, entry.pointer)),
      ),
    ];
    const unlistedRuns = [
      ...new Set(
        [...liveRuns].map((pointer) =>
          normalizeRunPointer(report.root, pointer),
        ),
      ),
    ].filter((pointer) => !listedPointers.has(pointer));
    briefs.push({
      id: capsule.id,
      path: capsule.path,
      outcome: field('Outcome and observable acceptance'),
      outcomeState: field('Outcome state'),
      publicationState: field('Publication state'),
      owner: field('Current workflow owner and sole writer'),
      nextAction: field('Next bounded owner and action'),
      friction: field('Workflow friction and lesson candidates'),
      authority: field('Authority') || null,
      blockers: field('Open unknowns and blockers with owners') || null,
      evidence: field('Evidence observed') || null,
      nonProofs: field('Explicit non-proofs') || null,
      reviewDisposition:
        field('Review fixed point and Standards / Spec disposition') || null,
      restartState: field('Restart state') || null,
      nativeGoal:
        field('Native Goal identity/state and configured tracker item/state') ||
        null,
      durableReferences:
        field('Durable CONTEXT / ADR / research references') || null,
      recordedCommits: recorded,
      recordedFingerprint: anchors.fingerprint,
      liveHead: liveHead.ok ? liveHead.out : null,
      headMoved,
      headRecorded: anchorHead !== null,
      liveDirty,
      cleanupEntries: listed.map((entry) => ({ ...entry })),
      listedRuns: [...listedPointers],
      missingRuns,
      unlistedRuns,
    });
  }

  const lines = briefs.map((brief) => {
    const headState =
      brief.liveHead === null
        ? 'unknown'
        : !brief.headRecorded
          ? 'no recorded HEAD'
          : brief.headMoved
            ? 'MOVED'
            : 'unchanged';
    const dirty =
      brief.liveDirty === null
        ? 'unknown (git status failed)'
        : `${brief.liveDirty.length} paths`;
    const repoLine = `repo: recorded fixed point ${[...new Set(brief.recordedCommits)].join(', ') || brief.recordedFingerprint || 'none'} / live HEAD ${brief.liveHead ?? 'unknown'} (${headState}); dirty ${dirty}`;
    const cleanupLine = `cleanup: listed ${brief.listedRuns.length} / live ${brief.listedRuns.length + brief.unlistedRuns.length - brief.missingRuns.length}; missing ${brief.missingRuns.length ? brief.missingRuns.join(', ') : 'none'}; unlisted ${brief.unlistedRuns.length ? brief.unlistedRuns.join(', ') : 'none'}`;
    return [
      `capsule ${brief.id}`,
      `outcome: ${brief.outcome}`,
      `state: ${brief.outcomeState} / publication ${brief.publicationState}`,
      `owner: ${brief.owner}`,
      `next: ${brief.nextAction}`,
      `authority: ${brief.authority ?? 'none'}`,
      `blockers: ${brief.blockers ?? 'none'}`,
      `evidence: ${brief.evidence ?? 'none'}`,
      `non-proofs: ${brief.nonProofs ?? 'none'}`,
      `review: ${brief.reviewDisposition ?? 'none'}`,
      `restart: ${brief.restartState ?? 'none'}`,
      `goal/tracker: ${brief.nativeGoal ?? 'none'}`,
      `durable refs: ${brief.durableReferences ?? 'none'}`,
      `friction: ${brief.friction}`,
      repoLine,
      cleanupLine,
      brief.cleanupEntries.length
        ? `cleanup entries: ${brief.cleanupEntries.map((entry) => `${entry.pointer} [${entry.workflow}; ${entry.consumer}; ${entry.trigger}; ${entry.state}]`).join(', ')}`
        : 'cleanup entries: none',
    ].join('\n');
  });

  return {
    root: report.root,
    applicability: 'checked',
    status: errors.length > 0 ? 'divergent' : report.status,
    capsules: briefs,
    errors,
    warnings,
    text: `${lines.join('\n\n')}\n\n${NO_LESSONS}${renderErrors(errors)}\n\nRun \`krn state check\` before resuming or completing.`,
  };
}
