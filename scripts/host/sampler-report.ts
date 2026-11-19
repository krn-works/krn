// Prints the last N hours of host samples as a per-project table with peaks and saturated hours.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HostSample, samplesDir } from './sampler.ts';

export interface ProjectRow {
  project: string;
  avgCpu: number;
  peakCpu: number;
  avgRssMb: number;
  peakRssMb: number;
  peakProcs: number;
}

export interface Report {
  samples: number;
  rows: ProjectRow[];
  peakLoad: number;
  peakSwapMb: number;
  ncpu: number;
  /** UTC hours (ISO prefix `YYYY-MM-DDTHH`) whose mean 1-minute load was at least the CPU thread count. */
  saturatedHours: string[];
  /** Sum of per-project CPU against the host total, over samples that have both (percent difference). */
  cpuSumVsTotalPct: number | null;
}

/** A torn or foreign line yields null and is skipped. */
function parseLine(line: string): HostSample | null {
  try {
    return JSON.parse(line) as HostSample;
  } catch {
    return null;
  }
}

export function loadSamples(dir: string, since: Date): HostSample[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) =>
      /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f),
    );
  } catch {
    files = [];
  }
  const out: HostSample[] = [];
  for (const f of files.sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const s = parseLine(line);
      if (s && new Date(s.ts) >= since) out.push(s);
    }
  }
  return out;
}

export function buildReport(samples: HostSample[]): Report {
  const acc = new Map<
    string,
    { cpu: number[]; rss: number[]; procs: number }
  >();
  for (const s of samples) {
    for (const [name, p] of Object.entries(s.projects)) {
      const a = acc.get(name) ?? { cpu: [], rss: [], procs: 0 };
      a.cpu.push(p.cpu);
      a.rss.push(p.rssKb / 1024);
      a.procs = Math.max(a.procs, p.procs);
      acc.set(name, a);
    }
  }
  const n = samples.length || 1;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const rows = [...acc.entries()]
    .map(([project, a]) => ({
      project,
      // a project absent from a sample counts as zero for that sample
      avgCpu: r1(a.cpu.reduce((x, y) => x + y, 0) / n),
      peakCpu: r1(Math.max(...a.cpu)),
      avgRssMb: Math.round(a.rss.reduce((x, y) => x + y, 0) / n),
      peakRssMb: Math.round(Math.max(...a.rss)),
      peakProcs: a.procs,
    }))
    .sort((x, y) => y.avgCpu - x.avgCpu);

  const hours = new Map<string, { sum: number; n: number; ncpu: number }>();
  let sumDiff = 0;
  let sumTotal = 0;
  for (const s of samples) {
    const h = s.ts.slice(0, 13);
    const e = hours.get(h) ?? { sum: 0, n: 0, ncpu: 0 };
    e.sum += s.load[0];
    e.n += 1;
    e.ncpu = Math.max(e.ncpu, s.ncpu);
    hours.set(h, e);
    if (s.cpuTotal !== null) {
      sumTotal += s.cpuTotal;
      sumDiff += Object.values(s.projects).reduce((x, p) => x + p.cpu, 0);
    }
  }
  return {
    samples: samples.length,
    rows,
    peakLoad: Math.max(0, ...samples.map((s) => s.load[0])),
    peakSwapMb: Math.round(
      Math.max(0, ...samples.map((s) => s.swapUsedKb)) / 1024,
    ),
    ncpu: Math.max(0, ...samples.map((s) => s.ncpu)),
    saturatedHours: [...hours.entries()]
      .filter(([, e]) => e.ncpu > 0 && e.sum / e.n >= e.ncpu)
      .map(([h]) => h)
      .sort(),
    cpuSumVsTotalPct:
      sumTotal > 0 ? r1(((sumDiff - sumTotal) / sumTotal) * 100) : null,
  };
}

export function formatReport(r: Report, hours: number): string {
  const head = [
    'project',
    'avg cpu%',
    'peak cpu%',
    'avg rss MB',
    'peak rss MB',
    'peak procs',
  ];
  const body = r.rows.map((x) => [
    x.project,
    String(x.avgCpu),
    String(x.peakCpu),
    String(x.avgRssMb),
    String(x.peakRssMb),
    String(x.peakProcs),
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((b) => (b[i] as string).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) =>
        i === 0
          ? c.padEnd(widths[i] as number)
          : c.padStart(widths[i] as number),
      )
      .join('  ');
  return [
    `host samples, last ${hours} h: ${r.samples} samples, ${r.ncpu} threads`,
    line(head),
    ...body.map(line),
    `peak load1 ${r.peakLoad}, peak swap ${r.peakSwapMb} MB`,
    `saturated hours (mean load1 >= threads): ${r.saturatedHours.length}${r.saturatedHours.length ? ` (${r.saturatedHours.join(', ')})` : ''}`,
    r.cpuSumVsTotalPct === null
      ? 'cpu sum vs host total: n/a'
      : `cpu sum vs host total: ${r.cpuSumVsTotalPct}%`,
  ].join('\n');
}

if (import.meta.main) {
  const i = process.argv.indexOf('--hours');
  const hours = i >= 0 ? Number(process.argv[i + 1]) : 24;
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('usage: sampler-report.ts [--hours N]');
    process.exit(2);
  }
  const now = process.env.KRN_SAMPLER_NOW
    ? new Date(process.env.KRN_SAMPLER_NOW)
    : new Date();
  const samples = loadSamples(
    samplesDir(),
    new Date(now.getTime() - hours * 3600_000),
  );
  console.log(formatReport(buildReport(samples), hours));
}
