// Live arm C (KRN): the unit's base checkout adopts KRN (krn adopt writes the hooks, rules and contract), then one
// headless session runs through the shared session path (arm-session.ts) and the unit's hidden test grades the result.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceProposal } from '../../src/brain/evidence-proposals.ts';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { inForceRecords, injectionTokens } from './arm-b.ts';
import { type ArmOptions, armRow, commitPreparation } from './arm-session.ts';
import { ARMS } from './arms.ts';
import { type LiveUnit, promptOf } from './live.ts';
import { memoryRecords, seedMemory } from './memory.ts';
import type { Row } from './rows.ts';

const krnEntry = fileURLToPath(
  new URL('../../src/cli/krn.mjs', import.meta.url),
);

/** What krn needs to run: its sources, standards store, version pin and dependencies, never evals or other units. */
const KRN_PARTS = [
  'src',
  'standards',
  'package.json',
  '.node-version',
  'node_modules',
];

/**
 * Makes `krn` callable inside the session sandbox. The adopted hooks run `command -v krn || exit 2`, and the host's
 * `krn` is a symlink into a checkout the sandbox does not mount, so without this every Bash call and every Stop was
 * refused and arm C ended `no-attempt` (t-11kv38i, t-1182p41). A shim in scratch runs the harness's own krn entry; only
 * the parts krn runs from are mounted read-only.
 */
export function krnOnPath(
  base: NodeJS.ProcessEnv,
  scratch: string,
): { env: NodeJS.ProcessEnv; readable: string[] } {
  const bin = join(scratch, 'krn-bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'krn');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec '${process.execPath}' '${krnEntry}' "$@"\n`,
  );
  chmodSync(shim, 0o755);
  const root = dirname(dirname(dirname(krnEntry)));
  return {
    env: {
      ...base,
      PATH: [bin, ...(base.PATH ?? '').split(delimiter).filter(Boolean)].join(
        delimiter,
      ),
    },
    readable: KRN_PARTS.map((p) => join(root, p)).filter((p) => existsSync(p)),
  };
}

export interface ArmCOptions extends ArmOptions {
  /** Proposals earlier units of this repository left (memory.ts); served in arm C only, as trial records. */
  memory?: readonly EvidenceProposal[];
}

/** Adopts KRN into the checkout and commits the adoption, so the session's change is the only uncommitted work. */
export function adoptKrn(wt: string, log: string): void {
  const r = spawnSync(process.execPath, [krnEntry, 'adopt', wt], {
    encoding: 'utf8',
    // Adoption of a large checkout took 96 s on 2026-11-17 (t-1182p41).
    timeout: 600_000,
  });
  appendFileSync(log, `adopt: exit ${r.status}\n${r.stdout}${r.stderr}`);
  if (r.status !== 0)
    throw new Error(`krn adopt exited ${r.status}: ${r.stderr.trim()}`);
  commitPreparation(wt, 'chore: adopt krn');
}

/**
 * Claims the unit's task in the adopted checkout, as `krn lane start` does for a lane: SessionStart serves the standards
 * of the claimed task only, so a session without a claim would run C with nothing served.
 */
export function claimUnitTask(wt: string, { unit }: LiveUnit): void {
  mkdirSync(join(wt, 'tasks'), { recursive: true });
  writeFileSync(
    join(wt, 'tasks', `${unit.id}.json`),
    `${JSON.stringify({
      id: unit.id,
      status: 'open',
      resolution: null,
      created: new Date().toISOString().slice(0, 10),
      priority: 2,
      title: unit.task.title,
      after: [],
      body: [unit.task.body],
    })}\n`,
  );
  mkdirSync(join(wt, '.krn', 'task-claims'), { recursive: true });
  writeFileSync(
    join(wt, '.krn', 'task-claims', `${unit.id}.json`),
    `${JSON.stringify({
      id: unit.id,
      actor: 'krn-eval',
      worktree: wt,
      branch: outsideGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      claimed: new Date().toISOString(),
      reason: null,
    })}\n`,
  );
  commitPreparation(wt, 'chore: claim task');
}

/** One arm-C session on a KRN-adopted checkout with its task claimed, and its grade; the row attests the injected tokens. */
export async function armCRow(
  unit: LiveUnit,
  o: ArmCOptions,
  rep = 1,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<Row> {
  const krn = krnOnPath(o.env ?? process.env, o.scratch);
  const sandboxed: ArmCOptions = {
    ...o,
    env: krn.env,
    readable: [...(o.readable ?? []), ...krn.readable],
  };
  const { row, note } = await armRow(
    ARMS.C,
    unit,
    sandboxed,
    rep,
    (wt, log) => {
      if (seedMemory(wt, o.memory ?? []) > 0)
        commitPreparation(wt, 'chore: remembered records');
      const injection = injectionTokens(
        [...inForceRecords(wt, asOf), ...memoryRecords(o.memory ?? [])],
        wt,
        unit.unit.id,
        promptOf(unit.unit),
        asOf,
      );
      adoptKrn(wt, log);
      claimUnitTask(wt, unit);
      return injection;
    },
  );
  return note === undefined ? row : { ...row, injection: note };
}
