// The KRN harness a replayed unit runs under: the instruction and hook files at a chosen ref, laid over the
// unit's parent tree, minus every file the original pull request changed. Those stay at the parent's
// version, so the arm cannot see the merged solution and its patch still applies to the parent's code.
// One owner for replay (the K workspace) and grading (both arms and the validity check use the same tree).
// Usage: node evals/d23/harness.ts <checkout> <ref> <parent> <merge>
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Rule, render, workerRules } from '../../scripts/render-agents.ts';

/** Lead skills and agents: a worker never leads, hands off or runs a retro, and their listings cost context. */
export const LEAD_ONLY = [
  '.agents/skills/krn-lead',
  '.agents/skills/krn-handoff',
  '.agents/skills/krn-retro',
  '.claude/skills/krn-lead',
  '.claude/skills/krn-handoff',
  '.claude/skills/krn-retro',
];

const isLeadOnly = (file: string) =>
  LEAD_ONLY.some((dir) => file === dir || file.startsWith(`${dir}/`));

export const HARNESS_ROOTS = [
  '.claude/agents',
  '.claude/settings.json',
  '.claude/skills',
  '.agents',
  'AGENTS.md',
  'CLAUDE.md',
  'scripts/claude',
  'src/hook',
];

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });

const lines = (out: string) => out.split('\n').filter(Boolean);

/** Relative module specifiers a source file names: static, re-export and dynamic imports. */
export function relativeImports(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
    ),
  ].map((m) => m[1] ?? '');
}

/**
 * Files outside `roots` that the files under `roots` import, transitively, computed from the import graph
 * at `commit` (a hook importing src/repo/contract.ts pulls it and whatever it imports into the overlay).
 */
export function importClosure(
  roots: string[],
  listed: (commit: string, roots: string[]) => string[],
  read: (file: string) => string | undefined,
  commit: string,
): string[] {
  const inRoot = (f: string) =>
    roots.some((r) => f === r || f.startsWith(`${r}/`));
  const seen = new Set<string>();
  const queue = listed(commit, roots).filter((f) => f.endsWith('.ts'));
  const visited = new Set(queue);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const source = read(file);
    if (source === undefined) continue;
    for (const spec of relativeImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (visited.has(target) || target.startsWith('..')) continue;
      visited.add(target);
      if (read(target) === undefined) continue;
      if (!inRoot(target)) seen.add(target);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

/** The overlay at `commit`: the fixed roots plus every file their hooks import, from the import graph. */
export function overlayFiles(repo: string, commit: string): Set<string> {
  const listed = (c: string, roots: string[]) =>
    lines(git(repo, 'ls-tree', '-r', '--name-only', c, '--', ...roots));
  const read = (f: string) => {
    try {
      return execFileSync('git', ['show', `${commit}:${f}`], {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return undefined;
    }
  };
  return new Set([
    ...listed(commit, HARNESS_ROOTS),
    ...importClosure(HARNESS_ROOTS, listed, read, commit),
  ]);
}

export interface HarnessPlan {
  write: string[];
  remove: string[];
}

/** Files to write at `ref` and parent files to remove, keeping every path the merged change touched. */
export function harnessPlan(
  repo: string,
  ref: string,
  parent: string,
  merge: string,
): HarnessPlan {
  const touched = new Set(
    lines(git(repo, 'diff', '--name-only', parent, merge)),
  );
  const at = (commit: string) => overlayFiles(repo, commit);
  const onRef = at(ref);
  const onParent = at(parent);
  return {
    write: [...onRef].filter((f) => !touched.has(f) && !isLeadOnly(f)).sort(),
    remove: [...onParent]
      .filter((f) => (!onRef.has(f) || isLeadOnly(f)) && !touched.has(f))
      .sort(),
  };
}

/**
 * AGENTS.md as a worker sees it: the ref's rule registry without lead and governance rules (`audience: lead`)
 * and without the lead's workflow paragraph. A ref without a registry keeps its own file.
 */
export function workerAgents(repo: string, ref: string): string {
  try {
    const { rules } = JSON.parse(
      git(repo, 'show', `${ref}:spec/rules.json`),
    ) as {
      rules: Rule[];
    };
    return render(workerRules(rules), true);
  } catch {
    return git(repo, 'show', `${ref}:AGENTS.md`);
  }
}

/** Apply the plan to a checkout of the parent (or merge) from `repo`. */
export function layHarness(
  repo: string,
  dir: string,
  ref: string,
  plan: HarnessPlan,
): void {
  for (const f of plan.remove)
    rmSync(join(dir, f), { force: true, recursive: true });
  for (const f of plan.write) {
    const target = join(dir, f);
    rmSync(target, { force: true, recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const [mode] = git(repo, 'ls-tree', ref, '--', f).split(/\s+/);
    if (f === 'AGENTS.md' && mode !== '120000') {
      writeFileSync(target, workerAgents(repo, ref));
      continue;
    }
    const body = execFileSync('git', ['show', `${ref}:${f}`], {
      cwd: repo,
      maxBuffer: 64 << 20,
    });
    if (mode === '120000') symlinkSync(body.toString('utf8'), target);
    else
      writeFileSync(target, body, { mode: mode === '100755' ? 0o755 : 0o644 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ref, parent, merge] = process.argv.slice(2);
  if (!dir || !ref || !parent || !merge)
    throw new Error('usage: harness.ts <checkout> <ref> <parent> <merge>');
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const plan = harnessPlan(repo, ref, parent, merge);
  layHarness(repo, dir, ref, plan);
  process.stdout.write(
    `harness: wrote ${plan.write.length}, removed ${plan.remove.length}\n`,
  );
}
