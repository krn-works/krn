import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as recordOwner from '../../src/flow/record.ts';
import { type NewReviewRecord, panelRoles } from '../../src/flow/types.ts';

export function reviewEvidence(base: string, head: string) {
  return {
    schemaVersion: 1,
    headSha: head,
    base,
    createdAt: '2026-10-26T10:00:00Z',
    panelVerdict: 'PASS',
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    lensSha256: 'a'.repeat(64),
    toolSha: base,
    redFirst: [],
    judges: panelRoles.map((role) => ({
      state: 'complete',
      role,
      model: `fixture-${role}`,
      reasoningEffort: 'high',
      verdict: 'PASS',
      findings: [],
      sessionId: `fixture-${role}`,
      finalMessage: 'PASS',
    })),
  } satisfies NewReviewRecord;
}

export async function writeReviewEvidence(
  root: string,
  base: string,
  head: string,
  record: unknown = reviewEvidence(base, head),
  pr = 27,
) {
  const directory = join(root, '.krn', 'runs', 'review', head);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'record.json');
  if (typeof record === 'object' && record !== null) {
    const reserve: unknown = Reflect.get(recordOwner, 'reserveReviewAttempt');
    assert.equal(
      typeof reserve,
      'function',
      'PR evidence needs the series reservation owner',
    );
    if (typeof reserve !== 'function')
      throw new Error('reservation owner unavailable');
    let attempt: unknown = 'attempt' in record ? record.attempt : undefined;
    if (existsSync(path)) {
      const prior: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof prior === 'object' && prior !== null && 'attempt' in prior)
        attempt = prior.attempt;
    }
    attempt ??= reserve(
      root,
      { schemaVersion: 1, repository: 'krn-works/krn', pr, baseRef: 'main' },
      base,
      head,
    );
    Object.assign(record, { attempt });
  }
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function gateCheck(id = 1) {
  return {
    id,
    name: 'gate',
    app: { slug: 'github-actions' },
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/krn-works/krn/actions/runs/${id}`,
    started_at: '2026-10-26T10:00:00Z',
    completed_at: '2026-10-26T10:01:00Z',
  };
}
