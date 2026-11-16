// Screening unit set (ADR 0021 point 7): outside open-source fixes dated after June 2026 whose issue body is the only task text.
// Usage:
//   node evals/units/screening.ts build --candidates <jsonl> --sources <dir> [--limit N]   units + manifest rows, unverified
//   node evals/units/screening.ts verify [--concurrency 2] [--log-dir <dir>] [--id <id>]   run base and fix, record exit codes
//   node evals/units/screening.ts verify --recorded [--manifest <file>]                                       count recorded verifications only
// verify prints `units: N verified` and exits 0 when N >= 70. No model runs.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Unit } from './unit.ts';

export const MIN_VERIFIED = 70;

export interface Candidate {
  repo: string;
  pr: string;
  merged: string;
  fix: string;
  issue: string;
  test: string;
  lang: string;
}

export interface Verification {
  installBase: number;
  testBase: number;
  /** assertion: the hidden test ran and failed; compile: it could not load, which excludes the unit. */
  baseFailure: 'assertion' | 'compile' | 'none';
  installFix: number;
  testFix: number;
}

export interface ManifestRow {
  id: string;
  repo: string;
  issue: string;
  fixPr: string;
  base: string;
  fix: string;
  committed: string;
  test: string;
  verification?: Verification | undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
export const manifestFile = join(here, 'screening-manifest.json');
let manifestPath = manifestFile;

/** A unit id has the shape of a task id: t- plus seven base-36 characters taken from the issue URL. */
export const unitId = (issue: string): string =>
  `t-${BigInt(
    `0x${createHash('sha1').update(issue).digest('hex').slice(0, 12)}`,
  )
    .toString(36)
    .slice(0, 7)
    .padEnd(7, '0')}`;

/** True when the recorded runs show the hidden test red on base by assertion and green on the fix. */
export function verified(v: Verification | undefined): boolean {
  return (
    v !== undefined &&
    v.installBase === 0 &&
    v.installFix === 0 &&
    v.baseFailure === 'assertion' &&
    v.testBase !== 0 &&
    v.testFix === 0
  );
}

export function readManifest(file = manifestPath): ManifestRow[] {
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ManifestRow[])
    : [];
}

const git = (dir: string, ...a: string[]) => {
  const r = spawnSync('git', ['-C', dir, ...a], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Install and test commands for the stack the base tree shows; null when no runner can be named. */
export function commandsFor(
  lang: string,
  testFile: string,
  files: (p: string) => string | null,
): { install: string; test: string } | null {
  const q = JSON.stringify(testFile);
  if (lang === 'Go')
    return {
      install: 'go mod download',
      test: `timeout 240 go test -count=1 ./${dirname(testFile) === '.' ? '' : `${dirname(testFile)}/`}`,
    };
  if (lang === 'Python') {
    if (!files('pyproject.toml') && !files('setup.py')) return null;
    return {
      install:
        'python3 -m venv .venv && for x in test tests dev; do .venv/bin/python -m pip install -q pytest -e ".[$x]" && exit 0; done; .venv/bin/python -m pip install -q pytest -e .',
      test: `timeout 240 .venv/bin/python -m pytest -q -p no:cacheprovider ${q}`,
    };
  }
  if (lang === 'PHP') {
    if (!files('composer.json')) return null;
    return {
      install: 'composer install -q --no-interaction --no-scripts',
      test: `timeout 240 vendor/bin/phpunit ${q}`,
    };
  }
  const pkg = files('package.json');
  if (!pkg) return null;
  const install = files('pnpm-lock.yaml')
    ? 'pnpm install --frozen-lockfile --ignore-scripts'
    : files('package-lock.json')
      ? 'npm ci --ignore-scripts'
      : 'npm install --ignore-scripts';
  const runner = /vitest/.test(pkg)
    ? `npx --no-install vitest run ${q}`
    : /jest/.test(pkg)
      ? `npx --no-install jest ${q}`
      : /node --test|node:test/.test(pkg + (files(testFile) ?? ''))
        ? `node --test ${q}`
        : null;
  return runner ? { install, test: `timeout 240 ${runner}` } : null;
}

function build(
  candidates: Candidate[],
  sources: string,
  out: string,
  limit: number,
): void {
  const rows = readManifest();
  const have = new Set(rows.map((r) => r.id));
  mkdirSync(sources, { recursive: true });
  for (const c of candidates) {
    if (rows.length >= limit) break;
    const id = unitId(c.issue);
    if (have.has(id)) continue;
    try {
      const dir = join(sources, c.repo.replace('/', '__'));
      if (!existsSync(dir))
        git(
          '.',
          'clone',
          '-q',
          '--filter=blob:none',
          '--no-checkout',
          `https://github.com/${c.repo}.git`,
          dir,
        );
      const base = git(dir, 'rev-parse', `${c.fix}^1`);
      const committed = git(dir, 'show', '-s', '--format=%cs', c.fix);
      const at = (p: string) => {
        try {
          return git(dir, 'show', `${base}:${p}`);
        } catch {
          return null;
        }
      };
      const changed = git(dir, 'diff', '--name-only', base, c.fix).split('\n');
      if (!changed.includes(c.test) || changed.every((f) => f === c.test))
        continue;
      const cmds = commandsFor(c.lang, c.test, at);
      if (!cmds) continue;
      const hidden = git(dir, 'show', `${c.fix}:${c.test}`);
      const m = /issues\/(\d+)$/.exec(c.issue);
      const api = spawnSync(
        'gh',
        ['api', `repos/${c.repo}/issues/${m?.[1]}`, '--jq', '[.title,.body]'],
        { encoding: 'utf8', maxBuffer: 1 << 26 },
      );
      if (api.status !== 0) continue;
      const [title, body] = JSON.parse(api.stdout) as [string, string | null];
      if (!title || !body?.trim()) continue;
      const unit: Unit & { committed: string; issue: string } = {
        id,
        repo: c.repo,
        base,
        reference: c.fix,
        task: { title, body },
        spec: title,
        hidden: { file: 'hidden.txt', dest: c.test },
        install: cmds.install,
        test: cmds.test,
        committed,
        issue: c.issue,
      };
      const ud = join(out, id);
      mkdirSync(ud, { recursive: true });
      writeFileSync(join(ud, 'hidden.txt'), `${hidden}\n`);
      writeFileSync(
        join(ud, 'unit.json'),
        `${JSON.stringify(unit, null, 2)}\n`,
      );
      rows.push({
        id,
        repo: c.repo,
        issue: c.issue,
        fixPr: c.pr,
        base,
        fix: c.fix,
        committed,
        test: cmds.test,
      });
      console.log(`built ${id} ${c.repo} ${c.issue}`);
    } catch (e) {
      console.error(`skip ${c.issue}: ${String(e).slice(0, 120)}`);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(rows, null, 2)}\n`);
}

let cacheRoot = '';

const GB = 1024 ** 3;

/** Bytes under a path, symlinks not followed. */
export function dirBytes(path: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const n of readdirSync(path)) total += dirBytes(join(path, n));
  return total;
}

/** Remove a tree whose directories or files may be read-only (the Go module cache is). */
function forceRemove(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) {
      chmodSync(path, 0o700);
      for (const n of readdirSync(path)) forceRemove(join(path, n));
    }
  } catch {
    // already gone
  }
  rmSync(path, { recursive: true, force: true });
}

export interface CacheLimits {
  capBytes: number;
  /** Free disk that must remain; pruning continues while below it. */
  freeFloorBytes: number;
}

const freeBytes = (path: string): number => {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
};

/** Cache is over the size cap or the disk is under the free floor. */
export function cacheOverLimit(
  root: string,
  lim: CacheLimits,
  free: (p: string) => number = freeBytes,
): boolean {
  if (!existsSync(root)) return false;
  return dirBytes(root) > lim.capBytes || free(root) < lim.freeFloorBytes;
}

/** Delete the largest cache subdirectories until the cache fits the cap and the free floor holds. Call only when no unit is running. */
export function pruneCache(
  root: string,
  lim: CacheLimits,
  free: (p: string) => number = freeBytes,
): string[] {
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .map((name) => ({ name, bytes: dirBytes(join(root, name)) }))
    .sort((a, b) => b.bytes - a.bytes);
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  const removed: string[] = [];
  for (const d of dirs) {
    if (total <= lim.capBytes && free(root) >= lim.freeFloorBytes) break;
    forceRemove(join(root, d.name));
    total -= d.bytes;
    removed.push(d.name);
  }
  return removed;
}

const cacheLimits = (): CacheLimits => ({
  capBytes: Number(process.env.KRN_SCREEN_CACHE_MAX_GB ?? 8) * GB,
  freeFloorBytes: Number(process.env.KRN_SCREEN_MIN_FREE_GB ?? 6) * GB,
});
/** Third-party install and test commands see no tokens: PATH, HOME and caches inside scratch only. */
function cleanEnv(): NodeJS.ProcessEnv {
  const c = (n: string) => join(cacheRoot, n);
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    CI: '1',
    MISE_GO_VERSION: '1.27.3',
    GOCACHE: c('go-build'),
    GOMODCACHE: c('go-mod'),
    GOFLAGS: '-mod=mod',
    npm_config_cache: c('npm'),
    COMPOSER_HOME: c('composer'),
    PIP_CACHE_DIR: c('pip'),
    XDG_CACHE_HOME: c('xdg'),
  };
}

const run = (cmd: string, cwd: string, log: string): Promise<number> =>
  new Promise((resolve) => {
    appendFileSync(log, `\n$ ${cmd}\n`);
    const p = spawn('sh', ['-c', `${cmd} >> ${JSON.stringify(log)} 2>&1`], {
      cwd,
      env: cleanEnv(),
    });
    p.on('close', (c) => resolve(c ?? 1));
  });

/** Copy the hidden test into a prepared worktree, install and run it: the grade of whatever state the worktree holds. */
export async function gradeWorktree(
  wt: string,
  unit: Unit,
  unitDir: string,
  log: string,
  scratch: string,
): Promise<{ install: number; test: number; compile: boolean }> {
  cacheRoot = join(scratch, 'cache');
  mkdirSync(dirname(join(wt, unit.hidden.dest)), { recursive: true });
  writeFileSync(
    join(wt, unit.hidden.dest),
    readFileSync(join(unitDir, unit.hidden.file)),
  );
  const install = await run(
    `timeout 300 sh -c ${JSON.stringify(unit.install)}`,
    wt,
    log,
  );
  if (install !== 0) return { install, test: -1, compile: false };
  const mark = readFileSync(log, 'utf8').length;
  const test = await run(unit.test, wt, log);
  const tail = readFileSync(log, 'utf8').slice(mark);
  const compile =
    /\[build failed\]|\[setup failed\]|undefined: |ImportError|ModuleNotFoundError|SyntaxError|Cannot find module|Class .* not found|Call to undefined/.test(
      tail,
    ) ||
    (unit.test.includes('pytest') && test === 2);
  return { install, test, compile };
}

/** Run the hidden test on one commit in a throwaway worktree of the clone. */
async function gradeAt(
  clone: string,
  sha: string,
  unit: Unit,
  unitDir: string,
  scratch: string,
  log: string,
): Promise<{ install: number; test: number; compile: boolean }> {
  const wt = mkdtempSync(join(scratch, 'screen-'));
  rmSync(wt, { recursive: true });
  git(clone, 'worktree', 'add', '-q', '--detach', wt, sha);
  try {
    appendFileSync(log, `\n== ${sha}\n`);
    return await gradeWorktree(wt, unit, unitDir, log, scratch);
  } finally {
    git(clone, 'worktree', 'remove', '--force', wt);
  }
}

async function verify(
  sources: string,
  unitsDir: string,
  scratch: string,
  logDir: string,
  concurrency: number,
  only: string | undefined,
): Promise<void> {
  const rows = readManifest();
  mkdirSync(logDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  cacheRoot = join(scratch, 'cache');
  // Round-robin over repositories: one unit per repository first, so a slow repository costs one wait.
  const seen = new Map<string, number>();
  const order = rows
    .map((r, i) => ({
      r,
      i,
      k: seen.set(r.repo, (seen.get(r.repo) ?? -1) + 1).get(r.repo) as number,
    }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
  let next = 0;
  const slow = new Set<string>();
  // Caches are shared by in-flight units: when over a limit, hold new units until the running ones end, then prune.
  let active = 0;
  let pruning = false;
  const settle = async () => {
    while (cacheOverLimit(cacheRoot, cacheLimits()) || pruning) {
      if (active === 0 && !pruning) {
        pruning = true;
        const gone = pruneCache(cacheRoot, cacheLimits());
        console.log(`cache pruned: ${gone.join(', ') || 'nothing'}`);
        pruning = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const work = async () => {
    while (next < order.length) {
      await settle();
      const row = order[next++];
      if (!row) return;
      active++;
      try {
        await one(row);
      } finally {
        active--;
      }
    }
  };
  const one = async (row: ManifestRow) => {
    {
      if (only && row.id !== only) return;
      if (row.verification) return;
      if (slow.has(row.repo)) {
        row.verification = {
          installBase: 124,
          testBase: -1,
          baseFailure: 'none',
          installFix: -1,
          testFix: -1,
        };
        return;
      }
      const ud = join(unitsDir, row.id);
      const unit = JSON.parse(
        readFileSync(join(ud, 'unit.json'), 'utf8'),
      ) as Unit;
      const clone = join(sources, row.repo.replace('/', '__'));
      const log = join(logDir, `${row.id}.log`);
      writeFileSync(log, `${row.repo} ${row.issue}\n`);
      try {
        git(clone, 'fetch', '-q', 'origin', row.fix);
      } catch (e) {
        appendFileSync(log, `fetch skipped: ${String(e)}\n`);
      }
      let v: Verification;
      try {
        const b = await gradeAt(clone, unit.base, unit, ud, scratch, log);
        const f =
          b.install === 0 && b.test !== 0 && !b.compile
            ? await gradeAt(clone, unit.reference, unit, ud, scratch, log)
            : { install: -1, test: -1, compile: false };
        v = {
          installBase: b.install,
          testBase: b.test,
          baseFailure:
            b.test === 0 ? 'none' : b.compile ? 'compile' : 'assertion',
          installFix: f.install,
          testFix: f.test,
        };
      } catch (e) {
        appendFileSync(log, `error: ${String(e)}\n`);
        v = {
          installBase: -2,
          testBase: -2,
          baseFailure: 'none',
          installFix: -2,
          testFix: -2,
        };
      }
      if (v.installBase === 124 || v.installFix === 124 || v.testBase === 124)
        slow.add(row.repo);
      row.verification = v;
      writeFileSync(manifestPath, `${JSON.stringify(rows, null, 2)}\n`);
      console.log(
        `${row.id} ${row.repo} ${verified(v) ? 'ok' : 'drop'} ${JSON.stringify(v)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  // A dropped unit leaves the unit set: the screening counts every directory it finds.
  for (const r of rows)
    if (r.verification && !verified(r.verification))
      rmSync(join(unitsDir, r.id), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  manifestPath = flag('manifest') ?? manifestFile;
  const sources = flag('sources') ?? '.krn/sources/screening';
  if (cmd === 'build') {
    const file = flag('candidates');
    if (!file) throw new Error('missing --candidates');
    const cands = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Candidate);
    build(cands, sources, here, Number(flag('limit') ?? 400));
  } else if (cmd === 'verify') {
    if (!rest.includes('--recorded'))
      await verify(
        sources,
        here,
        flag('scratch') ?? '.krn/tmp/screen-scratch',
        flag('log-dir') ?? '.krn/runs/lane/screening-verify',
        Number(flag('concurrency') ?? 2),
        flag('id'),
      );
    const n = new Set(
      readManifest()
        .filter((r) => verified(r.verification))
        .map((r) => r.id),
    ).size;
    console.log(`units: ${n} verified`);
    process.exit(n >= MIN_VERIFIED ? 0 : 1);
  } else {
    console.error('usage: build | verify');
    process.exit(64);
  }
}
