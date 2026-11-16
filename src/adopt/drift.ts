// Drift of an adopted repository: the KRN-owned adoption files that differ from what `krn adopt` writes now.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../brain/standards-cli.ts';
import { adopt, projectStandards } from './adopt.ts';

export interface Drift {
  /** Files that exist but differ from what adopt writes now. */
  drifted: string[];
  /** Files adopt would create. */
  missing: string[];
  /** Files already equal to what adopt writes. */
  kept: string[];
}

/** The tracker is part of the adoption when tasks/ exists; krn.json, tasks/ and the CI call stay repo-owned. */
function options(root: string, force = false) {
  return { refresh: true, force, tracker: existsSync(join(root, 'tasks')) };
}

/** Compares without keeping any change: adopt writes into its journal, which is rolled back at once. */
export function adoptionDrift(root: string): Drift {
  const report = adopt(root, options(root));
  report.rollback();
  const drift = split(report.written, report.unchanged, report.created);
  // A site skill edited in this repository is drift even though a refresh keeps it.
  return { ...drift, drifted: [...drift.drifted, ...(report.held ?? [])] };
}

/**
 * Rewrites the drifted and missing files to what adopt writes now; repo-owned files are not touched.
 * An edited site skill file stays as it is (`kept`) unless `force` asks for the pinned copy.
 */
export function refreshAdoption(root: string, force = false): Drift {
  const report = adopt(root, options(root, force));
  return split(report.written, report.unchanged, report.created);
}

function split(
  written: string[],
  kept: string[],
  created: ReadonlySet<string>,
): Drift {
  return {
    drifted: written.filter((file) => !created.has(file)),
    missing: written.filter((file) => created.has(file)),
    kept,
  };
}

/**
 * The ids of the pack records `krn adopt` would copy into an adopted repository that are absent from its
 * `.agents/standards.json`: the pack grew after the repository was adopted. None when it has no such file.
 * The pack is the one adopt reads, so a refresh always clears what this names.
 */
export function missingPackRecords(root: string): string[] {
  if (!existsSync(join(root, '.agents/standards.json'))) return [];
  const held = new Set(readProject(root).map((standard) => standard.id));
  return projectStandards(root, options(root))
    .filter((standard) => !held.has(standard.id))
    .map((standard) => standard.id);
}
