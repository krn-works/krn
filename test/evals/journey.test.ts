import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveJourneyReport, type GitFacts } from '../../src/evals/journey.ts';
import type { ReadonlyTraceSnapshot } from '../../src/trace/index.ts';

type TraceEvent = ReadonlyTraceSnapshot['events'][number];

const headSha = 'a'.repeat(40);

function row(
  key: string,
  kind: string,
  data: Record<string, unknown>,
): TraceEvent {
  return { key, kind, at: '2026-10-19T00:00:00.000Z', data };
}

function events(): TraceEvent[] {
  return [
    row('intent:1', 'intent', { jobId: 'journey-job', epoch: 1 }),
    row('intent:1:session', 'session_started', {
      intent: 'intent:1',
      jobId: 'journey-job',
      sessionId: 'interrupted-session',
      isolation: 'systemd_scope',
    }),
    row('intent:1:ended:interrupted-session', 'session_ended', {
      intent: 'intent:1',
      sessionId: 'interrupted-session',
      end: {
        exitCode: null,
        signal: 'SIGTERM',
        reasonKind: 'interrupted',
        claimsDone: false,
        usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
        usageObservation: {
          turnsStarted: 1,
          turnsCompleted: 0,
          invalidFields: 0,
        },
      },
    }),
    row('job-outcome:stop', 'job_outcome', {
      exitCode: 130,
      signal: 'SIGTERM',
      cleanup: 'verified',
      reason: 'stopped',
      outcomeKind: 'stop',
    }),
    row('operator-start:1', 'operator_start', { operator: 'lead' }),
    row('lead-intervention:1', 'lead_intervention', {
      kind: 'intervention',
      note: 'bounded intervention',
    }),
    row('lead-intervention:2', 'lead_intervention', {
      kind: 'reconstruction_prompt',
      note: 'bounded reconstruction',
    }),
    row('operator-stop:1', 'operator_stop', { operator: 'lead' }),
    row('intent:2', 'intent', { jobId: 'journey-job', epoch: 2 }),
    row('intent:2:session', 'session_started', {
      intent: 'intent:2',
      jobId: 'journey-job',
      sessionId: 'resumed-session',
      isolation: 'systemd_scope',
    }),
    row('intent:2:ended:resumed-session', 'session_ended', {
      intent: 'intent:2',
      sessionId: 'resumed-session',
      end: {
        exitCode: 0,
        signal: null,
        reasonKind: 'exit',
        claimsDone: true,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        usageObservation: {
          turnsStarted: 1,
          turnsCompleted: 1,
          invalidFields: 0,
        },
      },
    }),
    row('intent:2:checkpoint:resumed-session', 'checkpoint', {
      intent: 'intent:2',
      sessionId: 'resumed-session',
      message: 'finished',
      next: 'done',
    }),
    row('intent:2:commit:resumed-session', 'commit', {
      intent: 'intent:2',
      sessionId: 'resumed-session',
      sha: headSha,
      message: 'feat: finish journey',
    }),
    row('job-outcome:complete', 'job_outcome', {
      exitCode: 0,
      signal: null,
      cleanup: 'verified',
      reason: 'completed',
      outcomeKind: 'review',
    }),
  ];
}

function snapshot(input = events()): ReadonlyTraceSnapshot {
  return {
    jobId: 'journey-job',
    events: input,
    sha256: 'b'.repeat(64),
    byteLength: 1024,
    malformedTail: false,
    finalRowUnterminated: false,
  };
}

const gitFacts: GitFacts = { headSha, isDirty: false };

test('journey derivation keeps incomplete usage unknown and counts only a closed window', () => {
  const result = deriveJourneyReport(snapshot(), gitFacts);
  assert.equal(result.kind, 'journey');
  if (result.kind !== 'journey') return;
  assert.equal(result.facts.resumed.sessionId, 'resumed-session');
  assert.equal(result.facts.resumed.commitSha, headSha);
  assert.equal(result.facts.git.headSha, headSha);
  assert.equal(result.facts.usage.totalTokens, null);
  assert.deepEqual(result.facts.usage.unknownSessions, ['interrupted-session']);
  assert.equal(result.facts.operatorWindow.interventions, 1);
  assert.equal(result.facts.operatorWindow.reconstructionPrompts, 1);
  assert.equal(result.facts.escapedDefects, null);
  assert.ok(Array.isArray(result.checks));
});

test('journey derivation returns distinct typed refusals for missing durable evidence', () => {
  const base = events();
  const withoutOutcomes = base.filter((event) => event.kind !== 'job_outcome');
  const withoutStop = base.filter((event) => event.key !== 'job-outcome:stop');
  const withoutDone = base.filter(
    (event) => event.key !== 'intent:2:checkpoint:resumed-session',
  );
  const withoutCommit = base.filter(
    (event) => event.key !== 'intent:2:commit:resumed-session',
  );
  const unconfirmed = base.map((event) =>
    event.key === 'job-outcome:stop'
      ? row(event.key, event.kind, { ...event.data, cleanup: 'unconfirmed' })
      : event,
  );
  const cases: Array<{
    name: string;
    snapshot: ReadonlyTraceSnapshot;
    git: GitFacts;
    code: string;
  }> = [
    {
      name: 'missing job outcome',
      snapshot: snapshot(withoutOutcomes),
      git: gitFacts,
      code: 'missing_job_outcome',
    },
    {
      name: 'unconfirmed cleanup',
      snapshot: snapshot(unconfirmed),
      git: gitFacts,
      code: 'cleanup_unconfirmed',
    },
    {
      name: 'missing interruption',
      snapshot: snapshot(withoutStop),
      git: gitFacts,
      code: 'missing_interruption',
    },
    {
      name: 'missing completed checkpoint',
      snapshot: snapshot(withoutDone),
      git: gitFacts,
      code: 'missing_resumed_completion',
    },
    {
      name: 'missing commit',
      snapshot: snapshot(withoutCommit),
      git: gitFacts,
      code: 'missing_commit',
    },
    {
      name: 'HEAD mismatch',
      snapshot: snapshot(),
      git: { headSha: 'c'.repeat(40), isDirty: false },
      code: 'head_mismatch',
    },
    {
      name: 'malformed trace tail',
      snapshot: { ...snapshot(), malformedTail: true },
      git: gitFacts,
      code: 'malformed_trace_tail',
    },
  ];

  for (const scenario of cases) {
    const result = deriveJourneyReport(scenario.snapshot, scenario.git);
    assert.equal(result.kind, 'refusal', scenario.name);
    if (result.kind === 'refusal')
      assert.equal(result.code, scenario.code, scenario.name);
  }
});

test('journey derivation reports open windows and measured zero separately', () => {
  const input = events().filter((event) => event.key !== 'operator-stop:1');
  const changedUsage = input.map((event) => {
    if (event.key !== 'intent:1:ended:interrupted-session') return event;
    const end = event.data.end as Record<string, unknown>;
    return row(event.key, event.kind, {
      ...event.data,
      end: {
        ...end,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        usageObservation: {
          turnsStarted: 0,
          turnsCompleted: 0,
          invalidFields: 0,
        },
      },
    });
  });
  const result = deriveJourneyReport(snapshot(changedUsage), gitFacts);
  assert.equal(result.kind, 'journey');
  if (result.kind !== 'journey') return;
  assert.equal(result.facts.usage.totalTokens, 3);
  assert.deepEqual(result.facts.usage.unknownSessions, []);
  assert.equal(result.facts.operatorWindow.interventions, null);
  assert.equal(result.facts.operatorWindow.reconstructionPrompts, null);
});
