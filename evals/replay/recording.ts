// Record once, replay without model calls: a screen grade needs only the session's final working-tree change.
// The live path writes <unit>-<rep>.patch (the change against unit.base) and <unit>-<rep>.json (the grade) per session;
// replay applies each patch to a fresh unit.base checkout and grades it again, starting no session.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { forceRemove, gradeWorktree } from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';

export interface Recording {
  unit: string;
  rep: number;
  /** The commit the patch applies to. */
  base: string;
  pass: boolean;
  install: number;
  test: number;
  harness: string;
}

export interface Replayed {
  recording: Recording;
  /** Null when the patch did not apply: no grade. */
  pass: boolean | null;
  /** Why the replay produced no grade. */
  error?: string;
}

const local = (repo: string, ...args: string[]) => outsideGit(repo, args);

/**
 * A repository holding only the unit.base commit and no remote: a worktree of the clone would reach origin/main and
 * the reference fix through shared refs and objects. Depth 1 because the clones are partial.
 */
export function baseCheckout(
  sources: string,
  unit: Unit,
  scratch: string,
): string {
  // Absolute: the session repository fetches from it with `git -C <session>`, which would resolve a relative path there.
  const clone = resolve(sources, unit.repo.replace('/', '__'));
  mkdirSync(scratch, { recursive: true });
  try {
    local(clone, 'cat-file', '-e', `${unit.base}^{commit}`);
  } catch {
    local(clone, 'fetch', '-q', 'origin', unit.base);
  }
  const wt = mkdtempSync(join(scratch, 'session-'));
  local(wt, 'init', '-q');
  local(wt, 'fetch', '-q', '--no-tags', '--depth', '1', clone, unit.base);
  local(wt, 'checkout', '-q', '--detach', unit.base);
  rmSync(join(wt, '.git', 'FETCH_HEAD'), { force: true });
  return wt;
}

const stem = (unit: string, rep: number) => `${unit}-${rep}`;

/**
 * Writes the session's change against `base` (tracked, untracked and binary files, even after the session committed or
 * switched branches). Runs before the grade writes the hidden test into the checkout.
 */
export function recordPatch(
  wt: string,
  dir: string,
  unit: string,
  rep: number,
  base: string,
): string {
  mkdirSync(dir, { recursive: true });
  local(wt, 'add', '-A');
  // --output: the patch bytes verbatim, never trimmed or buffered through a string. Fixed a/ b/ prefixes, no colour and
  // no external diff: host settings such as diff.mnemonicPrefix would otherwise shape the recording.
  const file = resolve(dir, `${stem(unit, rep)}.patch`);
  local(
    wt,
    'diff',
    '--cached',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `--output=${file}`,
    base,
  );
  return file;
}

/** Writes the grade beside its patch: a recording is complete only with both files. */
export function recordGrade(dir: string, r: Recording): void {
  writeFileSync(
    join(dir, `${stem(r.unit, r.rep)}.json`),
    `${JSON.stringify(r)}\n`,
  );
}

/** Every recording in `dir`: each <stem>.json beside its <stem>.patch. */
export function readRecordings(dir: string): Recording[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Recording);
}

/** Applies one recorded patch to a fresh unit.base checkout and grades it: no model session. */
export async function replayRecording(
  r: Recording,
  unit: Unit,
  unitDir: string,
  o: { sources: string; scratch: string; dir: string },
): Promise<Replayed> {
  const patch = join(resolve(o.dir), `${stem(r.unit, r.rep)}.patch`);
  const log = join(o.scratch, `${stem(r.unit, r.rep)}-replay.log`);
  const wt = baseCheckout(o.sources, { ...unit, base: r.base }, o.scratch);
  try {
    // An empty patch is a session that changed nothing; `git apply` refuses empty input.
    if (readFileSync(patch, 'utf8').trim() !== '')
      try {
        local(wt, 'apply', '--binary', '--whitespace=nowarn', patch);
      } catch (e) {
        return { recording: r, pass: null, error: `apply: ${String(e)}` };
      }
    const g = await gradeWorktree(wt, unit, unitDir, log, o.scratch);
    return { recording: r, pass: g.install === 0 && g.test === 0 };
  } finally {
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}

/** One line per recording and the exit code: 0 all equal, 1 a grade differs, 65 nothing to replay or a patch failed. */
export function replayVerdict(results: Replayed[]): {
  lines: string[];
  code: number;
} {
  const lines = results.map((x) => {
    const id = `${x.recording.unit}/${x.recording.rep}`;
    if (x.pass === null) return `replay ${id}: no grade (${x.error})`;
    const same = x.pass === x.recording.pass;
    return `replay ${id}: recorded ${x.recording.pass ? 'pass' : 'fail'}, replayed ${x.pass ? 'pass' : 'fail'}, ${same ? 'equal' : 'DIFFERENT'}`;
  });
  const ungraded = results.filter((x) => x.pass === null).length;
  const differ = results.filter(
    (x) => x.pass !== null && x.pass !== x.recording.pass,
  ).length;
  const code = results.length === 0 || ungraded > 0 ? 65 : differ > 0 ? 1 : 0;
  lines.push(
    `verdict: ${results.length - ungraded - differ} of ${results.length} replayed grades equal the recorded grade, 0 model calls`,
  );
  return { lines, code };
}
