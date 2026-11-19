// Host sampler: one JSONL line per run with CPU, RSS and process count per project, plus load and swap.
// Read-only on /proc; it never signals or renices a process. Run once a minute by scripts/systemd/krn-host-sampler.timer.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProjectSample {
  /** CPU percent of one core (200 means two cores busy). */
  cpu: number;
  rssKb: number;
  procs: number;
}

export interface HostSample {
  ts: string;
  ncpu: number;
  load: [number, number, number];
  /** Whole-host busy CPU percent of one core, from /proc/stat deltas; null on the first run. */
  cpuTotal: number | null;
  memAvailKb: number;
  swapUsedKb: number;
  projects: Record<string, ProjectSample>;
}

interface ProcState {
  at: number;
  cpuTicks: number;
  pids: Record<string, number>;
}

export interface SamplerOptions {
  procRoot?: string;
  samplesDir?: string;
  projectsRoot?: string;
  now?: Date;
  clockTicks?: number;
}

function defaultProjectsRoot(): string {
  const root = join(homedir(), 'coding/krn/active');
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
const TMP_ROOTS = [tmpdir(), '/tmp', '/var/tmp'];

export function samplesDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KRN_HOST_SAMPLES_DIR ?? join(homedir(), '.local/share/krn/host-samples')
  );
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Project name for a process: cwd under the projects root, a tmp root, a systemd unit, else `other`. */
export function classify(
  cwd: string | null,
  cgroup: string | null,
  projectsRoot: string,
): string {
  if (cwd) {
    const root = projectsRoot.replace(/\/+$/, '');
    if (cwd.startsWith(`${root}/`))
      return cwd.slice(root.length + 1).split('/')[0] || 'other';
    for (const tmp of TMP_ROOTS) {
      if (cwd.startsWith(`${tmp}/`)) {
        const seg = cwd.slice(tmp.length + 1).split('/')[0];
        if (seg) return `tmp:${seg}`;
      }
    }
  }
  if (cgroup) {
    const unit = cgroup
      .split('\n')
      .map((l) => l.split(':').slice(2).join(':'))
      .flatMap((p) => p.split('/'))
      .reverse()
      .find(
        (s) => /\.(service|scope)$/.test(s) && !/^(user|session)@?/.test(s),
      );
    if (unit) return `unit:${unit.replace(/\\x2d/g, '-')}`;
  }
  return 'other';
}

/** Parse /proc/<pid>/stat; the comm field may hold spaces and parentheses, so split after the last `)`. */
export function parseStat(
  text: string,
): { ticks: number; rssPages: number } | null {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const f = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  // f[0] is field 3 (state): utime is field 14, stime 15, rss 24.
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  const rss = Number(f[21]);
  if (![utime, stime, rss].every(Number.isFinite)) return null;
  return { ticks: utime + stime, rssPages: rss };
}

function cpuTotalTicks(procRoot: string): { busy: number; ncpu: number } {
  const stat = read(join(procRoot, 'stat')) ?? '';
  const lines = stat.split('\n');
  const first = lines.find((l) => /^cpu\s/.test(l));
  const n = busyTicks(first);
  const ncpu = lines.filter((l) => /^cpu\d+\s/.test(l)).length || 1;
  return { busy: n, ncpu };
}

// user+nice+system+irq+softirq+steal (everything except idle and iowait)
function busyTicks(line: string | undefined): number {
  if (!line) return 0;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const pick = (i: number) => v[i] ?? 0;
  return pick(0) + pick(1) + pick(2) + pick(5) + pick(6) + pick(7);
}

function meminfo(procRoot: string): { memAvailKb: number; swapUsedKb: number } {
  const m: Record<string, number> = {};
  for (const l of (read(join(procRoot, 'meminfo')) ?? '').split('\n')) {
    const g = /^(\w+):\s+(\d+)/.exec(l);
    if (g) m[g[1] as string] = Number(g[2]);
  }
  return {
    memAvailKb: m.MemAvailable ?? 0,
    swapUsedKb: Math.max(0, (m.SwapTotal ?? 0) - (m.SwapFree ?? 0)),
  };
}

export function sample(opts: SamplerOptions = {}): HostSample {
  const procRoot = opts.procRoot ?? process.env.KRN_PROC_ROOT ?? '/proc';
  const dir = opts.samplesDir ?? samplesDir();
  const projectsRoot =
    opts.projectsRoot ??
    process.env.KRN_SAMPLER_PROJECTS_ROOT ??
    defaultProjectsRoot();
  const now = opts.now ?? new Date();
  const hz = opts.clockTicks ?? 100;
  const pageKb = 4;

  const statePath = join(dir, 'state.json');
  let prev: ProcState | null = null;
  try {
    prev = JSON.parse(read(statePath) ?? 'null') as ProcState | null;
  } catch {
    prev = null;
  }
  const dt = prev ? (now.getTime() - prev.at) / 1000 : 0;
  const usable = prev !== null && dt > 0;

  const projects: Record<string, ProjectSample> = {};
  const pids: Record<string, number> = {};
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const stat = read(join(procRoot, name, 'stat'));
    const parsed = stat ? parseStat(stat) : null;
    if (!parsed) continue;
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(join(procRoot, name, 'cwd'));
    } catch {
      cwd = null; // kernel thread or exited process
    }
    const project = classify(
      cwd,
      read(join(procRoot, name, 'cgroup')),
      projectsRoot,
    );
    pids[name] = parsed.ticks;
    const p = projects[project] ?? { cpu: 0, rssKb: 0, procs: 0 };
    projects[project] = p;
    p.procs += 1;
    p.rssKb += parsed.rssPages * pageKb;
    const before = prev?.pids[name];
    if (usable && before !== undefined && parsed.ticks >= before) {
      p.cpu += ((parsed.ticks - before) / hz / dt) * 100;
    }
  }
  for (const p of Object.values(projects)) p.cpu = Math.round(p.cpu * 10) / 10;

  const total = cpuTotalTicks(procRoot);
  const cpuTicks = total.busy;
  const cpuTotal =
    usable && prev && cpuTicks >= prev.cpuTicks
      ? Math.round(((cpuTicks - prev.cpuTicks) / hz / dt) * 1000) / 10
      : null;

  const la = (read(join(procRoot, 'loadavg')) ?? '0 0 0')
    .split(/\s+/)
    .map(Number);
  const mem = meminfo(procRoot);

  mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ at: now.getTime(), cpuTicks, pids } satisfies ProcState),
  );
  renameSync(tmp, statePath);

  return {
    ts: now.toISOString(),
    ncpu: total.ncpu,
    load: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
    cpuTotal,
    ...mem,
    projects,
  };
}

/** Append one line to the UTC day file; returns the file path. */
export function record(opts: SamplerOptions = {}): string {
  const dir = opts.samplesDir ?? samplesDir();
  const s = sample({ ...opts, samplesDir: dir });
  const file = join(dir, `${s.ts.slice(0, 10)}.jsonl`);
  appendFileSync(file, `${JSON.stringify(s)}\n`);
  return file;
}

if (import.meta.main) {
  record();
}
