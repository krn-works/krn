import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { emitContext, hookInput, object } from './context-io.ts';
import { pressureLines, probe } from './disk-pressure.ts';
import { resumeBlock } from './handoff-resume.ts';
import { memoryDirectory } from './memory-directory.ts';
import { checkMemory } from './memory-refs.ts';
import { openEntries } from './operator-inbox-store.ts';

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

// The restart block for one project; shared by the Claude and Codex hooks.
export function restartText(project: string, event: string): string {
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
  let idleClaims = 0;
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
      if (now - claimActivity(path, claim) > idleWindow) {
        idleClaims += 1;
        continue;
      }
      lines.push(
        `Open claim: ${entry.name} ${JSON.stringify({ id: claim.id, actor: claim.actor, branch: claim.branch }).slice(0, 160)}`,
      );
    }
  }
  // The count sits right after the branch, so truncation of the entries never drops it.
  if (idleClaims > 0)
    lines.splice(1, 0, `Hidden: ${idleClaims} idle claims (idle over 24h)`);
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
  lines.splice(1, 0, `Newest handoff: ${newest?.path ?? 'none'}`);
  if (newest) {
    try {
      const block = resumeBlock(readFileSync(newest.path, 'utf8'), 3000);
      if (block) lines.splice(2, 0, block);
    } catch {
      /* An unreadable handoff leaves the pointer. */
    }
  }
  // A full disk fails builds and git silently; name it right after the branch.
  try {
    lines.splice(1, 0, ...pressureLines(probe([homedir(), main])));
  } catch {
    /* Disk checks must never interrupt startup. */
  }
  // Budget includes JSON escaping and the envelope, not just the context string.
  let text = lines.join('\n');
  const length = (value: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: value,
      },
    }).length;
  while (length(text) > 8000)
    text = text.slice(0, Math.max(0, text.length - (length(text) - 8000)));
  return text;
}

if (import.meta.main) {
  try {
    const input = hookInput(['SessionStart']);
    if (
      typeof input.source !== 'string' ||
      !['startup', 'resume', 'clear', 'compact'].includes(input.source)
    )
      throw new Error('Invalid source');
    emitContext(input.event, restartText(input.project, input.event));
  } catch {
    /* Missing or unreadable state is not a reason to interrupt a session. */
  }
}
