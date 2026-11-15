// SessionStart restart brief for a session.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emitContext, hookInput } from '../harness/claude.ts';
import { memoryDirectory } from '../harness/memory-directory.ts';
import { isWorkerSession } from '../hook/session.ts';
import { sessionStandards } from '../hook/session-standards.ts';
import { cutText } from '../memory/cut-text.ts';
import { resumeBlock, section } from '../memory/handoff-resume.ts';
import { compactIndex } from '../memory/identifier-index.ts';
import { checkMemory } from '../memory/memory-refs.ts';
import {
  openEntries,
  recordSessionClass,
} from '../memory/operator-inbox-store.ts';
import { stateLoss } from '../state/loss.ts';
import { object } from './io.ts';

function closed(project: string, id: unknown): boolean {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id)) return false;
  try {
    const task = object(
      JSON.parse(readFileSync(join(project, 'tasks', `${id}.json`), 'utf8')),
    );
    return task.status === 'closed';
  } catch {
    return false;
  }
}

function resumeTaskId(handoff: string): string | undefined {
  return /^\s*-\s+Task:\s*`?(t-[a-z0-9]{7})\b/imu.exec(
    section(handoff, 'Resume') ?? '',
  )?.[1];
}

export const PLAN_FILE = 'docs/program/plan.md';

/**
 * The tracked plan as a pointer, never its text: `plan.md@<hash>` so a session can tell the plan
 * moved, plus the plan's slice line for the resume task when it has one (ADR 0024).
 */
export function planPointer(
  project: string,
  handoff = '',
  limit = 700,
): string | undefined {
  let plan: string;
  try {
    plan = readFileSync(join(project, PLAN_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const hash = createHash('sha256').update(plan).digest('hex').slice(0, 12);
  const lines = [
    `Plan: ${PLAN_FILE}@${hash} (the north star and slices; read it before planning)`,
  ];
  const id = resumeTaskId(handoff);
  const slice = id
    ? plan
        .split('\n')
        .find((line) => line.startsWith(`- [S`) && line.includes(` ${id}]`))
    : undefined;
  if (slice)
    lines.push(
      `Slice: ${slice.length > limit ? `${cutText(slice, limit - 1)}…` : slice}`,
    );
  return lines.join('\n');
}

// The resume task's record, so a session never cats tasks/<id>.json at startup.
export function taskBrief(
  project: string,
  handoff: string,
  limit = 1500,
): string | undefined {
  const id = resumeTaskId(handoff);
  if (!id) return undefined;
  try {
    const task = object(
      JSON.parse(readFileSync(join(project, 'tasks', `${id}.json`), 'utf8')),
    );
    const body = Array.isArray(task.body) ? task.body.join('\n') : '';
    const text = `Task ${id} (${String(task.status)}, P${String(task.priority)}): ${String(task.title)}\n${body}`;
    return text.length > limit ? `${cutText(text, limit - 1)}…` : text;
  } catch {
    return undefined; // A missing or unreadable record leaves the Resume line.
  }
}

// An entry idle for longer than this window is dead weight in the restart block.
const idleWindow = 24 * 60 * 60 * 1000;

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Last activity on a claim: its claim time, its record write, or the newest commit in its worktree.
function claimActivity(path: string, claim: Record<string, unknown>): number {
  let latest = mtime(path);
  if (typeof claim.claimed === 'string') {
    const claimed = Date.parse(claim.claimed);
    if (Number.isFinite(claimed) && claimed <= Date.now())
      latest = Math.max(latest, claimed);
  }
  if (typeof claim.worktree === 'string' && claim.worktree.startsWith('/')) {
    try {
      if (statSync(claim.worktree).isDirectory()) {
        const seconds = Number(
          execFileSync('git', ['log', '-1', '--format=%ct'], {
            cwd: claim.worktree,
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim(),
        );
        if (Number.isFinite(seconds)) latest = Math.max(latest, seconds * 1000);
      }
    } catch {
      /* A missing or broken worktree adds no activity. */
    }
  }
  return latest;
}

// The restart block for one project; shared by the Claude and Codex hooks. A transcript
// (SessionStart after compaction) adds the identifier index beside the resume block.
export function restartText(
  project: string,
  event: string,
  transcriptPath?: string,
  sessionId?: string,
): string {
  const [commonDirectory = '', sha = '', branch = ''] = execFileSync(
    'git',
    ['rev-parse', '--git-common-dir', 'HEAD', '--abbrev-ref', 'HEAD'],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
    .trim()
    .split('\n');
  const main = dirname(resolve(project, commonDirectory));
  // Only state that changes per session; static rules live in CLAUDE.md.
  const lines = [`Branch: ${branch}; HEAD: ${sha.slice(0, 7)}`];
  const now = Date.now();
  const liveClaims = new Set<string>();
  const claims = join(main, '.krn/task-claims');
  if (existsSync(claims)) {
    for (const entry of readdirSync(claims, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(claims, entry.name);
      let claim: Record<string, unknown>;
      try {
        claim = object(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        continue; // One unreadable claim must not hide the rest.
      }
      // A claim on a closed task is stale; a missing record stays visible.
      if (closed(project, claim.id)) continue;
      // An idle claim is stale; it stays out of the model's context.
      if (now - claimActivity(path, claim) > idleWindow) continue;
      liveClaims.add(`.krn/task-claims/${entry.name}`);
      lines.push(
        `Open claim: ${entry.name} ${JSON.stringify({ id: claim.id, actor: claim.actor, branch: claim.branch }).slice(0, 160)}`,
      );
    }
  }
  let newest: { path: string; mtime: number } | undefined;
  function visit(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'handoff.md') {
        const mtime = statSync(path).mtimeMs;
        if (
          !newest ||
          mtime > newest.mtime ||
          (mtime === newest.mtime && path < newest.path)
        )
          newest = { path, mtime };
      }
    }
  }
  visit(join(main, '.krn/runs'));
  try {
    const open = openEntries(main);
    if (open.length > 0)
      lines.splice(
        1,
        0,
        `Operator inbox: ${open.length} open prompt(s); run node scripts/claude/operator-inbox.ts open`,
      );
  } catch {
    /* The inbox must never interrupt startup. */
  }
  try {
    const stale = new Set<string>();
    for (const finding of checkMemory({
      root: main,
      memory: memoryDirectory(main),
      changed: false,
    }).findings)
      if (
        [
          'SUPERSEDED',
          'EXPIRED',
          'CHANGED',
          'STALE-TASK',
          'MISSING-TASK',
          'DANGLING',
        ].includes(finding.kind)
      )
        stale.add(finding.file);
    if (stale.size > 0)
      lines.splice(
        1,
        0,
        `Memory: ${stale.size} stale note(s) ${[...stale].slice(0, 5).join(', ')}${stale.size > 5 ? ', ...' : ''}; update or delete (node scripts/claude/memory-refs.ts)`.slice(
          0,
          300,
        ),
      );
  } catch {
    /* Memory checks must never interrupt startup. */
  }
  try {
    const lost = stateLoss(main, project).filter((path) =>
      liveClaims.has(path),
    );
    lines.splice(
      1,
      0,
      ...lost.slice(0, 5).map((path) => `STATE LOSS: ${path}`),
      ...(lost.length > 5 ? [`STATE LOSS: ${lost.length - 5} more`] : []),
    );
  } catch {
    /* The loss check must never interrupt startup. */
  }
  lines.splice(1, 0, `Newest handoff: ${newest?.path ?? 'none'}`);
  let next = 2;
  let handoff = '';
  if (newest) {
    try {
      handoff = readFileSync(newest.path, 'utf8');
    } catch {
      /* An unreadable handoff leaves the pointer. */
    }
  }
  const plan = planPointer(project, handoff);
  if (plan) {
    lines.splice(1, 0, plan);
    next += 1;
  }
  if (handoff) {
    try {
      const block = resumeBlock(handoff, 3000);
      if (block) lines.splice(next++, 0, block);
      const task = taskBrief(project, handoff);
      if (task) lines.splice(next++, 0, task);
    } catch {
      /* An unreadable handoff leaves the pointer. */
    }
  }
  if (transcriptPath) {
    const index = compactIndex(transcriptPath, [project, main]);
    if (index) lines.splice(next, 0, index);
  }
  // An adopted repository's interactive session gets the standards that match its task; a worker's brief already has them.
  if (sessionId !== undefined && !isWorkerSession()) {
    try {
      const block = sessionStandards(project, main, sessionId, branch);
      if (block) lines.splice(next, 0, block);
    } catch {
      /* Standards must never interrupt startup. */
    }
  }
  return fitEnvelope(event, lines.join('\n'));
}

// Budget includes JSON escaping and the envelope, not just the context string.
export function fitEnvelope(event: string, text: string, limit = 8000): string {
  return cutText(
    text,
    limit,
    (value) =>
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: value },
      }).length,
  );
}

export function main(): void {
  try {
    const input = hookInput(['SessionStart']);
    if (
      typeof input.source !== 'string' ||
      !['startup', 'resume', 'clear', 'compact'].includes(input.source)
    )
      throw new Error('Invalid source');
    recordSessionClass(input.project, input.sessionId);
    emitContext(
      input.event,
      restartText(
        input.project,
        input.event,
        input.source === 'compact' ? input.transcriptPath : undefined,
        input.sessionId,
      ),
    );
  } catch {
    /* Missing or unreadable state is not a reason to interrupt a session. */
  }
}
