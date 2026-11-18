// Recall of the records a change violated, at each retrieval moment (ADR 0020).
// Usage: node evals/retrieval/run.ts [--metric recall-at-5-task-start|recall-at-5-query|recall-at-5-edit]
// Without --metric it prints one line per moment; with it, the one number of that moment.
// A case maps (task text, files) to the record ids a mined change violated (cases.json). A moment is
// scored over the violated records it can carry at all: the lane packet omits enforced records
// (the check teaches them), the query and the edit moment omit lead records, and the edit moment
// serves only records with stack or path keys, so a violated record without them is not scored there.
// The report prints both denominators: the reachable one (recall) and the total one (recall of all).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnified } from '../../src/brain/record.ts';
import { readPack, readProject } from '../../src/brain/standards-cli.ts';
import {
  editRecords,
  laneCandidates,
  lanePacket,
  queryStandards,
} from '../../src/brain/worker-packet.ts';
import { editRecordsFor } from '../../src/hook/edit-standards.ts';
import { contractConventions } from '../../src/repo/contract.ts';

export const RECALL_AT = 5;

export type Case = {
  readonly id: string;
  readonly source: string;
  readonly audience: 'worker' | 'lead';
  readonly task: string;
  readonly files: readonly string[];
  readonly violated: readonly string[];
};

export type Moment = 'task-start' | 'query' | 'edit';
export const MOMENTS: readonly Moment[] = ['task-start', 'query', 'edit'];

export type Score = {
  readonly moment: Moment;
  readonly cases: number;
  readonly hits: number;
  /** Violated records the moment can reach: the denominator of recall. */
  readonly total: number;
  /** Every violated record of every case the moment applies to, reachable or not. */
  readonly labels: number;
  /** Cases the moment applies to, including those with no reachable violated record. */
  readonly applicable: number;
  readonly recall: number;
  /** Hits over every violated record, so an unreachable label counts as a miss. */
  readonly recallOfAll: number;
};

export type Casefile = { readonly asOf: string; readonly cases: Case[] };

/** The first RECALL_AT record ids a moment serves for one case, and every id it could serve. */
function served(
  moment: Moment,
  root: string,
  asOf: string,
  item: Case,
): { top: string[]; reachable: Set<string> } {
  const text = [item.task, ...item.files].join('\n');
  if (moment === 'task-start') {
    const reachable = new Set(
      laneCandidates(root, item.audience).map((record) => record.id),
    );
    const packet = lanePacket(
      root,
      text,
      asOf,
      'retrieval-eval',
      undefined,
      false,
      item.audience,
    );
    return { top: (packet?.records ?? []).slice(0, RECALL_AT), reachable };
  }
  if (moment === 'query') {
    const hits = queryStandards(root, {
      text: item.task,
      files: item.files,
      asOf,
    });
    return {
      top: hits.slice(0, RECALL_AT).map((hit) => hit.id),
      reachable: new Set(
        queryStandards(root, {
          text: item.task,
          files: item.files,
          asOf,
          budget: Number.MAX_SAFE_INTEGER,
        }).map((hit) => hit.id),
      ),
    };
  }
  const top = new Set<string>();
  const reachable = new Set<string>();
  for (const file of item.files) {
    const records = editRecordsFor(root, file, asOf, item.task);
    for (const record of records) reachable.add(record.id);
    for (const record of records.slice(0, RECALL_AT)) top.add(record.id);
  }
  return { top: [...top], reachable };
}

/** Recall@5 of one moment over the cases it can serve: hits over violated records, summed. */
export function scoreMoment(
  moment: Moment,
  root: string,
  file: Casefile,
): Score {
  let hits = 0;
  let total = 0;
  let cases = 0;
  let labels = 0;
  let applicable = 0;
  for (const item of file.cases) {
    if (item.audience === 'lead' && moment !== 'task-start') continue;
    applicable += 1;
    labels += item.violated.length;
    if (moment === 'edit' && item.files.length === 0) continue;
    const { top, reachable } = served(moment, root, file.asOf, item);
    const wanted = item.violated.filter((id) => reachable.has(id));
    if (wanted.length === 0) continue;
    cases += 1;
    total += wanted.length;
    hits += wanted.filter((id) => top.includes(id)).length;
  }
  return {
    moment,
    cases,
    hits,
    total,
    labels,
    applicable,
    recall: total === 0 ? 0 : hits / total,
    recallOfAll: labels === 0 ? 0 : hits / labels,
  };
}

export function readCases(root: string): Casefile {
  return JSON.parse(
    readFileSync(`${root}/evals/retrieval/cases.json`, 'utf8'),
  ) as Casefile;
}

/** Why the edit moment cannot serve record `id` for `files`: the one reason that keeps it out of every file's scope list. */
export function unreachableReason(
  root: string,
  id: string,
  files: readonly string[],
): string {
  const conventions = join(root, contractConventions(root));
  const record = [
    ...readPack(),
    ...readProject(root),
    ...(existsSync(conventions)
      ? parseUnified(JSON.parse(readFileSync(conventions, 'utf8')))
      : []),
  ].find((standard) => standard.id === id);
  if (record === undefined) return 'no record of this id exists in the pools';
  if (record.audience === 'lead' || record.audience === 'adopt')
    return `addressed to ${record.audience}, never served at an edit`;
  const { stacks, paths } = record.applies;
  if (stacks.length === 0 && paths.length === 0)
    return 'names no stack or path key, so it is session-start material';
  return `scoped to ${[...stacks, ...paths].join(' ')}, which none of ${files.join(' ')} matches`;
}

/** One line per unreachable edit label with its reason, the label's cases listed. */
export function unreachableLines(root: string, file: Casefile): string[] {
  const reasons = new Map<string, { why: string; cases: string[] }>();
  for (const item of file.cases) {
    if (item.audience === 'lead' || item.files.length === 0) continue;
    const reach = new Set(
      item.files.flatMap((path) =>
        editRecords(root, path, file.asOf).map((record) => record.id),
      ),
    );
    for (const id of item.violated) {
      if (reach.has(id)) continue;
      const entry = reasons.get(id) ?? {
        why: unreachableReason(root, id, item.files),
        cases: [],
      };
      entry.cases.push(item.id);
      reasons.set(id, entry);
    }
  }
  const lines = [...reasons].map(
    ([id, { why, cases }]) =>
      `unreachable edit ${id} (${cases.join(' ')}): ${why}`,
  );
  const blind = file.cases.filter(
    (item) => item.audience !== 'lead' && item.files.length === 0,
  );
  if (blind.length > 0)
    lines.push(
      `unreachable edit ${blind.flatMap((item) => item.violated).length} labels of ${blind.length} cases that name no file (${blind.map((item) => item.id).join(' ')}): no edited file to scope by`,
    );
  return lines;
}

export function line(score: Score): string {
  return `recall@${RECALL_AT} ${score.moment} ${score.recall.toFixed(2)} (${score.hits}/${score.total} reachable violated records, ${score.cases} cases); of all ${score.labels} violated records ${score.recallOfAll.toFixed(2)} (${score.hits}/${score.labels}, ${score.applicable} cases)`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const flag = process.argv.indexOf('--metric');
  const metric = flag < 0 ? undefined : process.argv[flag + 1];
  const file = readCases(root);
  if (metric !== undefined) {
    const moment = MOMENTS.find(
      (name) => `recall-at-${RECALL_AT}-${name}` === metric,
    );
    if (moment === undefined) {
      console.error(
        `unknown metric ${metric}: expected recall-at-${RECALL_AT}-<${MOMENTS.join('|')}>`,
      );
      process.exit(64);
    }
    console.log(scoreMoment(moment, root, file).recall.toFixed(2));
  } else {
    for (const moment of MOMENTS)
      console.log(line(scoreMoment(moment, root, file)));
    for (const text of unreachableLines(root, file)) console.log(text);
  }
}
