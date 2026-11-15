// Drift of an adopted repository: the KRN-owned adoption files that differ from what `krn adopt` writes now.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appliesTo, type Standard } from '../brain/standards.ts';
import {
  readPack,
  readProject,
  repositoryFacts,
} from '../brain/standards-cli.ts';
import { adopt } from './adopt.ts';

export interface Drift {
  /** Files that exist but differ from what adopt writes now. */
  drifted: string[];
  /** Files adopt would create. */
  missing: string[];
  /** Files already equal to what adopt writes. */
  kept: string[];
}

/** The tracker is part of the adoption when tasks/ exists; krn.json, tasks/ and the CI call stay repo-owned. */
function options(root: string) {
  return { refresh: true, tracker: existsSync(join(root, 'tasks')) };
}

/** Compares without keeping any change: adopt writes into its journal, which is rolled back at once. */
export function adoptionDrift(root: string): Drift {
  const report = adopt(root, options(root));
  report.rollback();
  return split(report.written, report.unchanged, report.created);
}

/** Rewrites the drifted and missing files to what adopt writes now; repo-owned files are not touched. */
export function refreshAdoption(root: string): Drift {
  const report = adopt(root, options(root));
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
 * The ids of the universal pack records that apply to an adopted repository and are absent from its
 * `.agents/standards.json`: the pack grew after the repository was adopted. None when it has no such file.
 */
export function missingPackRecords(
  root: string,
  pack: readonly Standard[] = readPack(),
): string[] {
  if (!existsSync(join(root, '.agents/standards.json'))) return [];
  const held = new Set(readProject(root).map((standard) => standard.id));
  const repository = repositoryFacts(root);
  return pack
    .filter(
      (standard) =>
        standard.layer === 'universal' &&
        appliesTo(standard, repository) &&
        !held.has(standard.id),
    )
    .map((standard) => standard.id);
}
