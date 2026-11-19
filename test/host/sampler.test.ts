import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classify,
  parseStat,
  record,
  sample,
} from '../../scripts/host/sampler.ts';
import {
  buildReport,
  formatReport,
  loadSamples,
} from '../../scripts/host/sampler-report.ts';

const sampler = fileURLToPath(
  new URL('../../scripts/host/sampler.ts', import.meta.url),
);
const reportCli = fileURLToPath(
  new URL('../../scripts/host/sampler-report.ts', import.meta.url),
);
const ROOT = '/fixture/projects';

function statLine(
  pid: number,
  comm: string,
  ticks: number,
  rssPages: number,
): string {
  // fields 3..24: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
  const f = Array(22).fill('0');
  f[0] = 'S';
  f[11] = String(ticks);
  f[12] = '0';
  f[21] = String(rssPages);
  return `${pid} (${comm}) ${f.join(' ')}`;
}

interface Proc {
  pid: number;
  comm?: string;
  ticks: number;
  rss: number;
  cwd?: string;
  cgroup?: string;
}

function writeProc(
  root: string,
  procs: Proc[],
  busyTicks: number,
  load = '1.00 2.00 3.00 1/100 5',
): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    root.concat('/stat'),
    `cpu  ${busyTicks} 0 0 900 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\n`,
  );
  writeFileSync(`${root}/loadavg`, load);
  writeFileSync(
    `${root}/meminfo`,
    'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 900 kB\nSwapFree: 300 kB\n',
  );
  for (const p of procs) {
    mkdirSync(`${root}/${p.pid}`);
    writeFileSync(
      `${root}/${p.pid}/stat`,
      statLine(p.pid, p.comm ?? 'node', p.ticks, p.rss),
    );
    writeFileSync(
      `${root}/${p.pid}/cgroup`,
      p.cgroup ?? '0::/user.slice/user-1000.slice/session-1.scope\n',
    );
    if (p.cwd) symlinkSync(p.cwd, `${root}/${p.pid}/cwd`);
  }
  mkdirSync(`${root}/self`);
}

test('classify groups by project cwd, tmp root, systemd unit, else other', () => {
  assert.equal(classify(`${ROOT}/krn/.krn/worktrees/x`, null, ROOT), 'krn');
  assert.equal(classify('/tmp/kt-abc/work', null, ROOT), 'tmp:kt-abc');
  assert.equal(
    classify(
      '/home/u',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-chrome-1.scope\n',
      ROOT,
    ),
    'unit:app-chrome-1.scope',
  );
  assert.equal(
    classify('/home/u', '0::/init.scope\n', ROOT),
    'unit:init.scope',
  );
  assert.equal(classify(null, null, ROOT), 'other');
});

test('parseStat survives spaces and parentheses in comm', () => {
  assert.deepEqual(parseStat(statLine(7, 'a (b) c', 250, 12)), {
    ticks: 250,
    rssPages: 12,
  });
  assert.equal(parseStat('garbage'), null);
});

test('sample computes per-project CPU from deltas over a fixture /proc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sampler-'));
  try {
    const proc = join(dir, 'proc');
    const out = join(dir, 'out');
    const t0 = new Date('2026-11-19T10:00:00Z');
    writeProc(
      proc,
      [
        { pid: 10, ticks: 1000, rss: 250, cwd: `${ROOT}/krn/src` },
        { pid: 11, ticks: 0, rss: 250, cwd: `${ROOT}/krn` },
        {
          pid: 12,
          ticks: 50,
          rss: 100,
          cwd: '/home/u',
          cgroup: '0::/a/app-x.scope\n',
        },
      ],
      1000,
    );
    const first = sample({
      procRoot: proc,
      samplesDir: out,
      now: t0,
      projectsRoot: ROOT,
    });
    assert.equal(first.cpuTotal, null);
    assert.equal(first.projects.krn?.procs, 2);
    assert.equal(first.projects.krn?.rssKb, 2000);
    assert.equal(first.ncpu, 2);
    assert.equal(first.swapUsedKb, 600);
    assert.equal(first.memAvailKb, 400);
    assert.deepEqual(first.load, [1, 2, 3]);

    // 60 s later: pid 10 used 3000 ticks (50% of a core), pid 12 used 600 ticks.
    writeProc(
      proc,
      [
        { pid: 10, ticks: 4000, rss: 250, cwd: `${ROOT}/krn/src` },
        { pid: 11, ticks: 0, rss: 250, cwd: `${ROOT}/krn` },
        {
          pid: 12,
          ticks: 650,
          rss: 100,
          cwd: '/home/u',
          cgroup: '0::/a/app-x.scope\n',
        },
      ],
      4600,
    );
    const second = sample({
      procRoot: proc,
      samplesDir: out,
      now: new Date(t0.getTime() + 60_000),
      projectsRoot: ROOT,
    });
    assert.equal(second.projects.krn?.cpu, 50);
    assert.equal(second.projects['unit:app-x.scope']?.cpu, 10);
    assert.equal(second.cpuTotal, 60);
    const sum = Object.values(second.projects).reduce((x, p) => x + p.cpu, 0);
    assert.ok(
      Math.abs(sum - (second.cpuTotal as number)) <=
        0.1 * (second.cpuTotal as number),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sampler entry appends one JSONL line per run under the env-overridden directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sampler-'));
  try {
    const proc = join(dir, 'proc');
    writeProc(proc, [{ pid: 10, ticks: 5, rss: 1, cwd: `${ROOT}/krn` }], 10);
    const env = {
      ...process.env,
      KRN_PROC_ROOT: proc,
      KRN_HOST_SAMPLES_DIR: join(dir, 'out'),
      KRN_SAMPLER_PROJECTS_ROOT: ROOT,
    };
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [sampler], {
        env,
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
    }
    const file = record({
      procRoot: proc,
      samplesDir: join(dir, 'out'),
      now: new Date('2026-01-02T03:04:05Z'),
      projectsRoot: ROOT,
    });
    assert.ok(file.endsWith('2026-01-02.jsonl'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] as string).projects.krn.procs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function line(
  ts: string,
  load: number,
  krn: number,
  other: number,
  total: number | null,
): string {
  return JSON.stringify({
    ts,
    ncpu: 16,
    load: [load, load, load],
    cpuTotal: total,
    memAvailKb: 1,
    swapUsedKb: 2048 * 1024,
    projects: {
      krn: { cpu: krn, rssKb: 1024 * 100, procs: 5 },
      'unit:app-chrome.scope': { cpu: other, rssKb: 1024 * 300, procs: 20 },
    },
  });
}

test('report prints a per-project table with peaks and saturated hours from a fixture JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sampler-'));
  try {
    writeFileSync(
      join(dir, '2026-11-19.jsonl'),
      [
        line('2026-11-19T08:00:00Z', 20, 100, 50, 150),
        line('2026-11-19T08:30:00Z', 18, 300, 100, 400),
        line('2026-11-19T09:00:00Z', 2, 10, 10, 20),
        line('2026-11-17T09:00:00Z', 30, 999, 0, 999),
        '',
        'not json',
      ].join('\n'),
    );
    const since = new Date('2026-11-18T10:00:00Z');
    const report = buildReport(loadSamples(dir, since));
    assert.equal(report.samples, 3);
    assert.deepEqual(report.saturatedHours, ['2026-11-19T08']);
    const krn = report.rows.find((r) => r.project === 'krn');
    assert.equal(krn?.peakCpu, 300);
    assert.equal(krn?.avgCpu, 136.7);
    assert.equal(report.peakLoad, 20);
    assert.equal(report.peakSwapMb, 2048);
    assert.equal(report.cpuSumVsTotalPct, 0);
    const text = formatReport(report, 24);
    assert.match(text, /project\s+avg cpu%\s+peak cpu%/);
    assert.match(text, /krn\s+136\.7\s+300/);
    assert.match(text, /saturated hours .*: 1 \(2026-11-19T08\)/);

    const cli = spawnSync(process.execPath, [reportCli, '--hours', '24'], {
      env: {
        ...process.env,
        KRN_HOST_SAMPLES_DIR: dir,
        KRN_SAMPLER_NOW: '2026-11-19T10:00:00Z',
      },
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /krn\s+136\.7\s+300/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report on an empty directory prints a table header without failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sampler-'));
  try {
    const text = formatReport(
      buildReport(loadSamples(join(dir, 'missing'), new Date(0))),
      24,
    );
    assert.match(text, /0 samples/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
