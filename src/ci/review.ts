// Review before merge: a fresh-context reviewer reads a risky diff while the Check runs, and ship
// merges only on its verdict for the same patch. The verdict lives outside the tree, so HEAD never moves.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runner } from './command.ts';

/** 0: nothing to review; 1: small code, not reviewed; 2: risky or large, the verdict gates the merge. */
export type ReviewTier = 0 | 1 | 2;

/** Changed lines outside tests, docs and records above which any diff is tier 2. */
export const REVIEW_SIZE_LIMIT = 150;
/** Code where one defect disables a gate or a hook for every lane. */
const RISKY_PREFIXES = [
  'src/hook/',
  'src/ci/',
  '.github/',
  'src/cli/lane',
  'src/repo/required-check',
  'src/repo/host-gate',
  'src/repo/slot-lock',
];
const LIGHT = [/^tasks\/[^/]+\.json$/u, /^docs\//u, /\.md$/u, /^test\//u];

/** The new path of one `git diff --numstat` path column (`a => b`, `dir/{a => b}/f`). */
function newPath(column: string): string {
  return column
    .replace(/\{[^{}]* => ([^{}]*)\}/gu, '$1')
    .replace(/^.* => /u, '')
    .replace(/\/\/+/gu, '/');
}

/** The tier of a diff from its `git diff --numstat` text; `inFrame` names the files that produce the CI verdict. */
export function reviewTier(
  numstat: string,
  inFrame: (path: string) => boolean,
): ReviewTier {
  let code = 0;
  let any = false;
  for (const row of numstat.split('\n')) {
    const [added, deleted, ...rest] = row.split('\t');
    if (rest.length === 0) continue;
    const path = newPath(rest.join('\t'));
    if (
      RISKY_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      inFrame(path)
    )
      return 2;
    if (LIGHT.some((pattern) => pattern.test(path))) continue;
    any = true;
    code += (Number(added) || 0) + (Number(deleted) || 0);
  }
  if (code > REVIEW_SIZE_LIMIT) return 2;
  return any ? 1 : 0;
}

const answerSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      evidence: z.array(z.string()).default([]),
      reproduce: z.string().optional(),
      class: z.string().optional(),
      kind: z.string().optional(),
    }),
  ),
});
type Answer = z.infer<typeof answerSchema>['findings'][number];

/** One finding as `krn findings validate` reads it; `confirmed` only when ship reproduced it. */
export type ReviewFinding = Answer & {
  status: 'confirmed' | 'needs_validation';
  foundBy: 'reviewer';
  verifiedBy?: 'krn-pr-ship';
  /** Exit of the reproduce command on the head, then on the merge base. */
  exits?: { head: number | null; base: number | null };
};

/**
 * A reproduced finding blocks unless the reviewer marks it an over-refusal: a deny guard refusing a
 * harmless input. Such a finding is posted and does not block, so a deny-by-default guard converges
 * instead of meeting a fresh shell edge case every round. A missing or unknown kind blocks.
 */
function blocks(finding: ReviewFinding): boolean {
  return finding.status === 'confirmed' && finding.kind !== 'over-refusal';
}

export type ReviewVerdict =
  | { kind: 'skip'; line: string }
  | { kind: 'pass' | 'block'; line: string; findings: ReviewFinding[] }
  | { kind: 'silent'; line: string };

export interface ReviewHandle {
  /** The line ship prints when the review starts. */
  readonly line: string;
  /** The verdict for the head `at` is about to merge: the started run when its patch matches, else a new run. */
  verdict(at: string): Promise<ReviewVerdict>;
  /** Stops a run still going and removes its scratch worktree; ship calls it on every exit. */
  dispose(): void;
}

export interface ReviewInput {
  /** The main checkout: verdict records live under its .krn/runs/review. */
  main: string;
  /** The shipping worktree; the reviewer never runs in it. */
  cwd: string;
  /** The base ref the patch is cut against, e.g. origin/main. */
  base: string;
  head: string;
  /** The repository's reviewer command (krn.json `review`), or undefined when it names none. */
  command: string | undefined;
  /** Whether a path produces the CI verdict (the gate frame); the cli supplies the manifest's. */
  inFrame: (path: string) => boolean;
  /** Posts a comment on the PR; a comment raises no CI run and moves no head. */
  comment: (body: string) => Promise<void>;
  run: Runner;
  now: () => number;
  /** How long a tier 2 ship waits for the reviewer, from its start. */
  timeoutMs: number;
}

/** `git patch-id --stable` of base...at: the same patch keeps its verdict across a rebase. */
function patchId(run: Runner, cwd: string, base: string, at: string): string {
  const diff = run('git', ['diff', `${base}...${at}`], cwd);
  if (diff.code !== 0) return at;
  const id = run('git', ['patch-id', '--stable'], cwd, diff.stdout);
  return id.stdout.trim().split(/\s+/u)[0] || at;
}

/** The environment a reviewer or a reproduce command gets: no credential the shell holds. */
export function reviewEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|BW_SESSION|CREDENTIAL/iu.test(
        key,
      )
    )
      out[key] = value;
  return out;
}

const REPRODUCE_TIMEOUT_MS = 300_000;
/** Exits of a command that never ran its check: timeout, not executable, not found. */
const BROKEN = new Set([124, 126, 127]);
const evidencePattern = /^[^\s:][^\s]*:[1-9]\d*$/u;

/** Exit of `command` in `dir`, or null when it timed out, was killed or could not run. */
function exitOf(command: string, dir: string): number | null {
  const shown = spawnSync('sh', ['-c', command], {
    cwd: dir,
    env: reviewEnvironment(process.env),
    timeout: REPRODUCE_TIMEOUT_MS,
    stdio: 'ignore',
  });
  if (shown.error !== undefined || shown.signal !== null) return null;
  return shown.status;
}

/**
 * A finding is reproduced when its command fails on the head and passes on the merge base: a defect
 * the change brought. Any other outcome (a broken command, red on both) stays needs_validation.
 */
function verify(
  finding: Answer,
  scratch: string,
  run: Runner,
  at: string,
  baseSha: string,
): ReviewFinding {
  const plain: ReviewFinding = {
    ...finding,
    status: 'needs_validation',
    foundBy: 'reviewer',
  };
  const command = finding.reproduce?.trim();
  if (!command) return plain;
  // Each run starts from clean tracked files: an edit a reproduction leaves never reaches the next run.
  // Untracked reproduction files stay across the reset and the checkout.
  const clean = () => run('git', ['reset', '-q', '--hard'], scratch).code === 0;
  const head = clean() ? exitOf(command, scratch) : null;
  let base: number | null = null;
  if (head !== null && head !== 0 && !BROKEN.has(head)) {
    if (
      clean() &&
      run('git', ['checkout', '-q', '--detach', baseSha], scratch).code === 0
    )
      base = exitOf(command, scratch);
    clean();
    run('git', ['checkout', '-q', '--detach', at], scratch);
  }
  const located =
    finding.evidence.length > 0 &&
    finding.evidence.every((entry) => evidencePattern.test(entry));
  return head !== null &&
    head !== 0 &&
    !BROKEN.has(head) &&
    base === 0 &&
    located
    ? {
        ...plain,
        status: 'confirmed',
        verifiedBy: 'krn-pr-ship',
        exits: { head, base },
      }
    : { ...plain, exits: { head, base } };
}

/** The PR comment that records a verdict: one header line, then the findings. */
export function reviewComment(
  at: string,
  patch: string,
  verdict: ReviewVerdict,
): string {
  const header = `krn-review: ${at} ${patch} tier 2 ${verdict.kind}`;
  if (verdict.kind !== 'pass' && verdict.kind !== 'block')
    return `${header}\n\n${verdict.line}\n`;
  const rows = verdict.findings.map(
    (f) =>
      `- **${f.status !== 'confirmed' ? 'not reproduced' : blocks(f) ? 'reproduced' : 'reproduced over-refusal, not blocking'}** ${f.title} (${f.evidence.join(', ') || 'no location'})${
        f.reproduce
          ? `\n  reproduce: \`${f.reproduce}\` exited ${f.exits?.head ?? 'n/a'} on the head, ${f.exits?.base ?? 'n/a'} on the base`
          : ''
      }`,
  );
  return `${header}\n\n${verdict.line}\n${rows.length > 0 ? `\n${rows.join('\n')}\n` : ''}`;
}

const recordSchema = z.object({ kind: z.string(), head: z.string() });

/**
 * Starts the review of `head` when its diff is tier 2 and the repository names a reviewer.
 * The run goes on beside the Check wait; `verdict` joins it before the merge call.
 */
export function startReview(input: ReviewInput): ReviewHandle {
  const { run, cwd, base, head, main, now } = input;
  const numstat = run(
    'git',
    // An unquoted path: a quoted non-ASCII name would miss its risky prefix.
    ['-c', 'core.quotePath=false', 'diff', '--numstat', `${base}...${head}`],
    cwd,
  );
  const skip = (line: string): ReviewHandle => ({
    line,
    verdict: () => Promise.resolve({ kind: 'skip', line }),
    dispose: () => {
      // Nothing runs below tier 2.
    },
  });
  if (numstat.code !== 0)
    return skip(`review: skipped, no diff of ${base}...${head}`);
  const tier = reviewTier(numstat.stdout, input.inFrame);
  if (tier < 2) return skip(`review: tier ${tier}, not reviewed`);
  const command = input.command;
  if (command === undefined)
    return skip('review: tier 2, skipped: krn.json names no review command');
  const records = join(main, '.krn', 'runs', 'review');
  const runs = new Map<string, Promise<ReviewVerdict>>();
  const posted = new Set<string>();
  const live = new Map<number, string>();
  const scratchOf = (patch: string) =>
    join(main, '.krn', 'tmp', `review-${patch.slice(0, 12)}`);
  const removeScratch = (scratch: string) =>
    run('git', ['worktree', 'remove', '--force', scratch], main);

  const reviewRun = (at: string, patch: string): Promise<ReviewVerdict> => {
    // A patch already passed keeps its verdict: a rerun of ship neither reviews nor comments again.
    const stored = join(records, `${patch}.json`);
    if (existsSync(stored))
      try {
        const record = recordSchema.parse(
          JSON.parse(readFileSync(stored, 'utf8')),
        );
        if (record.kind === 'pass') {
          posted.add(patch);
          return Promise.resolve({
            kind: 'pass',
            line: `review: pass recorded for patch ${patch.slice(0, 12)} at ${record.head}`,
            findings: [],
          });
        }
      } catch {
        // An unreadable record is reviewed again.
      }
    const started = now();
    const scratch = scratchOf(patch);
    const out = join(records, `${patch}.findings.json`);
    mkdirSync(records, { recursive: true });
    rmSync(out, { force: true });
    removeScratch(scratch);
    const added = run(
      'git',
      ['worktree', 'add', '--detach', scratch, at],
      main,
    );
    if (added.code !== 0)
      return Promise.resolve({
        kind: 'silent',
        line: `review: no scratch worktree for ${at}: ${added.stderr.trim()}`,
      });
    const baseSha = run('git', ['merge-base', base, at], cwd).stdout.trim();
    // Reproductions run the repository's tests: they need its installed dependencies.
    const modules = join(main, 'node_modules');
    if (existsSync(modules) && !existsSync(join(scratch, 'node_modules')))
      symlinkSync(modules, join(scratch, 'node_modules'));
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], {
        cwd: scratch,
        env: {
          ...reviewEnvironment(process.env),
          KRN_REVIEW_BASE: baseSha,
          KRN_REVIEW_HEAD: at,
          KRN_REVIEW_OUT: out,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      if (child.pid !== undefined) live.set(child.pid, scratch);
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      const stop = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(stop, input.timeoutMs);
      child.on('error', (error) => {
        stderr = error.message;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (child.pid !== undefined) live.delete(child.pid);
        const seconds = Math.round((now() - started) / 1000);
        let parsed: z.infer<typeof answerSchema> | undefined;
        if (code === 0 && existsSync(out))
          try {
            parsed = answerSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
          } catch {
            parsed = undefined;
          }
        if (parsed === undefined) {
          removeScratch(scratch);
          const why =
            signal !== null
              ? `was stopped after ${seconds}s (${signal}; KRN_REVIEW_TIMEOUT_S)`
              : code !== 0
                ? `exited ${code}`
                : 'wrote no valid findings file';
          resolve({
            kind: 'silent',
            line: `review: the reviewer ${why}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
          });
          return;
        }
        const findings = parsed.findings.map((finding) =>
          verify(finding, scratch, run, at, baseSha),
        );
        // A reproduction is the regression test KRN-14 asks for: keep it for the author.
        const reproductions = join(scratch, '.krn', 'tmp', 'review');
        if (existsSync(reproductions))
          run('cp', ['-r', reproductions, join(records, patch)], main);
        removeScratch(scratch);
        const confirmed = findings.filter((f) => f.status === 'confirmed');
        const blocking = findings.filter(blocks);
        const kind = blocking.length > 0 ? 'block' : 'pass';
        writeFileSync(
          stored,
          `${JSON.stringify({ head: at, base: baseSha, patch, kind, seconds, findings }, null, 2)}\n`,
        );
        resolve({
          kind,
          findings,
          line: `review: ${kind} after ${seconds}s, ${findings.length} finding(s), ${confirmed.length} reproduced, ${blocking.length} blocking`,
        });
      });
    });
  };

  const start = (at: string, patch: string) => {
    let pending = runs.get(patch);
    if (pending === undefined) {
      try {
        pending = reviewRun(at, patch);
      } catch (error) {
        pending = Promise.resolve({
          kind: 'silent',
          line: `review: the reviewer did not start: ${(error as Error).message}`,
        });
      }
      runs.set(patch, pending);
    }
    return pending;
  };
  // The run is joined in `verdict`; its promise never rejects (every failure resolves `silent`).
  void start(head, patchId(run, cwd, base, head));
  return {
    line: `review: tier 2, the reviewer reads ${base}...${head} beside the Check`,
    async verdict(at) {
      const patch = patchId(run, cwd, base, at);
      const verdict = await start(at, patch);
      if (!posted.has(patch)) {
        posted.add(patch);
        try {
          await input.comment(reviewComment(at, patch, verdict));
        } catch {
          // The record under .krn/runs/review holds the verdict; a lost comment never decides a merge.
        }
      }
      return verdict;
    },
    dispose() {
      for (const [pid, scratch] of live) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
        removeScratch(scratch);
      }
      live.clear();
    },
  };
}
