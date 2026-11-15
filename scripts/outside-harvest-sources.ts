// Harvest proposals from the sources an outside row leaves besides Stop refusals: audit FAILs seen
// in at least two repositories (evals/standards-audit.md) and merged KRN fix commits. Promotable
// candidates mark their enforced pack record `harvested`. Usage:
//   node scripts/outside-harvest-sources.ts [--from PR --to PR] [--audit FILE] [--write]
// Without --write the pack is untouched and the report is printed.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harvestCandidates, renderHarvest } from '../src/brain/proposals.ts';
import { parseUnified } from '../src/brain/record.ts';
import {
  auditFailProposals,
  fixCommitProposals,
  promoteCandidates,
} from './lib/outside-harvest.ts';

export function harvestSources(
  root: string,
  options: { from: number; to: number; audit: string; write: boolean },
  recordedAt = new Date().toISOString().slice(0, 10),
): string[] {
  const packPath = join(root, 'standards/records.json');
  const raw = JSON.parse(readFileSync(packPath, 'utf8')) as {
    id: string;
    harvested?: unknown;
  }[];
  const pack = parseUnified(raw);
  const log = spawnSync('git', ['log', '--format=%s', '-n', '400'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (log.status !== 0) throw new Error(`git log failed: ${log.stderr}`);
  const fixes = fixCommitProposals(
    log.stdout.split('\n').filter(Boolean),
    'krn',
    recordedAt,
  ).filter((item) => {
    const number = Number(item.file.replace('git#', ''));
    return number >= options.from && number <= options.to;
  });
  const sourced = [
    ...auditFailProposals(
      readFileSync(options.audit, 'utf8'),
      pack,
      recordedAt,
    ),
    ...fixes,
  ];
  const candidates = harvestCandidates(sourced);
  const { pack: next, promoted } = promoteCandidates(pack, candidates);
  // Only the `harvested` field is written back, so the rest of the file keeps its key order.
  if (options.write && promoted.length > 0) {
    for (const id of promoted) {
      const entry = raw.find((record) => record.id === id);
      if (entry !== undefined)
        entry.harvested = next.find((record) => record.id === id)?.harvested;
    }
    writeFileSync(packPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return [
    ...renderHarvest(
      candidates,
      new Set(sourced.map((s) => s.repository)).size,
    ),
    `promoted: ${promoted.join(', ') || 'none'}`,
  ];
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const argv = process.argv.slice(2);
  const value = (flag: string, fallback: string): string => {
    const at = argv.indexOf(flag);
    return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
  };
  for (const line of harvestSources(root, {
    from: Number(value('--from', '893')),
    to: Number(value('--to', '900')),
    audit: resolve(value('--audit', join(root, 'evals/standards-audit.md'))),
    write: argv.includes('--write'),
  }))
    process.stdout.write(`${line}\n`);
}
