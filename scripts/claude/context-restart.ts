import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emitContext, hookInput, object } from './context-io.ts';

const rules = [
  'delegate reading to a subagent (krn-reader) that returns a verdict and path',
  'pass pointers, not file contents',
  'verify by commands that print a verdict',
  'one slice per session',
  'at a gauge advisory, finish the step and run krn-handoff',
];

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

try {
  const input = hookInput(['SessionStart']);
  if (
    typeof input.source !== 'string' ||
    !['startup', 'resume', 'compact'].includes(input.source)
  )
    throw new Error('Invalid source');
  const git = (...arguments_: string[]) =>
    execFileSync('git', ['rev-parse', ...arguments_], {
      cwd: input.project,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const branch = git('--abbrev-ref', 'HEAD');
  const head = git('--short', 'HEAD');
  const main = dirname(resolve(input.project, git('--git-common-dir')));
  // Keep the mandatory rules before optional repository data, so truncation preserves them.
  const lines = [
    `Branch: ${branch}; HEAD: ${head}`,
    ...rules.map((rule) => `Rule: ${rule}`),
  ];
  const claims = join(main, '.krn/task-claims');
  if (existsSync(claims)) {
    lines.push(`Claims directory: ${claims}`);
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
      if (closed(input.project, claim.id)) continue;
      lines.push(
        `Open claim: ${entry.name} ${JSON.stringify({ id: claim.id, actor: claim.actor, branch: claim.branch }).slice(0, 160)}`,
      );
    }
  }
  const capsules = join(main, '.krn/runs/delivery-loop');
  if (existsSync(capsules)) {
    for (const entry of readdirSync(capsules, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const path = join(capsules, entry.name, 'state.md');
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      lines.push(`Capsule: ${path}`);
      // Same fieldLine semantics as GLOBAL capsule-abi.mjs: first trimmed label line.
      for (const label of ['Outcome state', 'Restart state']) {
        const line = text
          .split('\n')
          .find((line) => line.trimStart().startsWith(`${label}:`));
        if (line) lines.push(line.trimStart().slice(0, 400));
      }
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
  lines.splice(1, 0, `Newest handoff: ${newest?.path ?? 'none'}`);
  // Budget includes JSON escaping and the envelope, not just the context string.
  let text = lines.join('\n');
  const length = (value: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.event,
        additionalContext: value,
      },
    }).length;
  while (length(text) > 8000)
    text = text.slice(0, Math.max(0, text.length - (length(text) - 8000)));
  emitContext(input.event, text);
} catch {
  /* Missing or unreadable state is not a reason to interrupt a session. */
}
