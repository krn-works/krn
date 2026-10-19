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
        reasonKind: 'process_exit',
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

function withOutcome(
  input: TraceEvent[],
  key: string,
  data: Record<string, unknown>,
): TraceEvent[] {
  return input.map((event) =>
    event.key === key ? row(event.key, event.kind, data) : event,
  );
}

function withSessionEnd(
  input: TraceEvent[],
  key: string,
  end: Record<string, unknown>,
): TraceEvent[] {
  return input.map((event) => {
    if (event.key !== key) return event;
    const previousEnd = event.data.end as Record<string, unknown>;
    return row(event.key, event.kind, {
      ...event.data,
      end: { ...previousEnd, ...end },
    });
  });
}

function stopOutcome(signal: string, exitCode: number): TraceEvent {
  return row('job-outcome:later-stop', 'job_outcome', {
    exitCode,
    signal,
    cleanup: 'verified',
    reason: signal === 'wall-timeout' ? 'wall-timeout' : 'stopped',
    outcomeKind: 'stop',
  });
}

function insertBeforeOperatorWindow(
  input: TraceEvent[],
  rows: TraceEvent[],
): TraceEvent[] {
  const index = input.findIndex((event) => event.key === 'operator-start:1');
  assert.ok(index > 0);
  return [...input.slice(0, index), ...rows, ...input.slice(index)];
}

test('journey derivation keeps stopped-session usage unknown and counts only a closed window', () => {
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

test('journey usage preserves stopped-session observations without counting them', () => {
  const result = deriveJourneyReport(snapshot(), gitFacts);
  assert.equal(result.kind, 'journey');
  const sessionFacts = result.facts.sessions as unknown as Array<
    Record<string, unknown>
  >;
  const interrupted = sessionFacts.find(
    (session) => session.sessionId === 'interrupted-session',
  );
  assert.ok(interrupted);
  assert.equal(interrupted.usageMeasured, false);
  assert.deepEqual(interrupted.usage, {
    inputTokens: 11,
    outputTokens: 2,
    totalTokens: 13,
    observation: {
      turnsStarted: 1,
      turnsCompleted: 0,
      invalidFields: 0,
    },
  });
  assert.deepEqual(result.facts.usage.unknownSessions, ['interrupted-session']);
});

test('journey accepts supported stop outcomes using the outcome signal and exact exit pair', () => {
  const cases = [
    ['SIGINT', 130],
    ['SIGTERM', 130],
    ['SIGHUP', 130],
    ['wall-timeout', 124],
  ] as const;

  const results = cases.map(([signal, exitCode]) => {
    const input = withOutcome(events(), 'job-outcome:stop', {
      exitCode,
      signal,
      cleanup: 'verified',
      reason: signal === 'wall-timeout' ? 'wall-timeout' : 'stopped',
      outcomeKind: 'stop',
    });
    return deriveJourneyReport(snapshot(input), gitFacts);
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'journey'
        ? result.facts.interruption
        : { code: result.code },
    ),
    cases.map(([signal, exitCode]) => ({ signal, exitCode })),
  );

  const inconsistent = withOutcome(events(), 'job-outcome:stop', {
    exitCode: 143,
    signal: 'SIGTERM',
    cleanup: 'verified',
    reason: 'stopped',
  });
  const rejected = deriveJourneyReport(snapshot(inconsistent), gitFacts);
  assert.equal(rejected.kind, 'refusal');
  if (rejected.kind === 'refusal')
    assert.equal(rejected.code, 'missing_interruption');
});

test('journey requires an ended session from the latest supported stop run', () => {
  const noSession = insertBeforeOperatorWindow(events(), [
    stopOutcome('SIGINT', 130),
  ]);
  const noSessionResult = deriveJourneyReport(snapshot(noSession), gitFacts);

  const lostSession = insertBeforeOperatorWindow(events(), [
    row('intent:lost', 'intent', { jobId: 'journey-job', epoch: 3 }),
    row('intent:lost:started', 'session_started', {
      intent: 'intent:lost',
      jobId: 'journey-job',
      sessionId: 'lost-session',
      isolation: 'systemd_scope',
    }),
    row('intent:lost:lost', 'session_lost', { sessionId: 'lost-session' }),
    stopOutcome('SIGINT', 130),
  ]);
  const lostResult = deriveJourneyReport(snapshot(lostSession), gitFacts);
  assert.deepEqual(
    [noSessionResult, lostResult].map((result) =>
      result.kind === 'refusal' ? result.code : result.kind,
    ),
    ['missing_interruption', 'missing_interruption'],
  );
});

test('journey chooses the latest supported stop instead of an older valid session', () => {
  const latestEndedSession = insertBeforeOperatorWindow(events(), [
    row('intent:latest-stop', 'intent', {
      jobId: 'journey-job',
      epoch: 3,
    }),
    row('intent:latest-stop:started', 'session_started', {
      intent: 'intent:latest-stop',
      jobId: 'journey-job',
      sessionId: 'latest-stop-session',
      isolation: 'systemd_scope',
    }),
    row('intent:latest-stop:ended', 'session_ended', {
      intent: 'intent:latest-stop',
      sessionId: 'latest-stop-session',
      end: {
        exitCode: null,
        signal: 'SIGKILL',
        reasonKind: 'process_exit',
        claimsDone: false,
      },
    }),
    stopOutcome('SIGINT', 130),
  ]);
  const latestResult = deriveJourneyReport(
    snapshot(latestEndedSession),
    gitFacts,
  );
  assert.equal(latestResult.kind, 'journey');
  if (latestResult.kind === 'journey')
    assert.deepEqual(latestResult.facts.interruption, {
      signal: 'SIGINT',
      exitCode: 130,
    });
});

test('journey refuses a teardown-unconfirmed event even without an outcome row', () => {
  const withTeardownFailure = events();
  const finalOutcome = withTeardownFailure.pop();
  assert.ok(finalOutcome);
  withTeardownFailure.push(
    row('teardown-unconfirmed', 'teardown_unconfirmed', {
      detail: 'physical cleanup unconfirmed',
    }),
    finalOutcome,
  );
  const teardown = deriveJourneyReport(snapshot(withTeardownFailure), gitFacts);
  assert.equal(teardown.kind, 'refusal');
  if (teardown.kind === 'refusal')
    assert.equal(teardown.code, 'cleanup_unconfirmed');
});

test('journey refuses any cleanup-unconfirmed outcome reason', () => {
  const input = [
    row('job-outcome:cleanup-reason', 'job_outcome', {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'cleanup-unconfirmed',
      outcomeKind: 'error',
    }),
    ...events(),
  ];
  const result = deriveJourneyReport(snapshot(input), gitFacts);
  assert.equal(result.kind, 'refusal');
  if (result.kind === 'refusal')
    assert.equal(result.code, 'cleanup_unconfirmed');
});

test('malformed session starts make aggregate usage unknown without hiding valid sessions', () => {
  const valid = events().filter(
    (event) =>
      !event.key.startsWith('intent:1') &&
      event.key !== 'job-outcome:stop' &&
      !event.key.startsWith('operator-') &&
      !event.key.startsWith('lead-intervention:'),
  );
  const input = [
    row('malformed-start', 'session_started', {
      intent: 'intent:bad',
      jobId: 'journey-job',
      sessionId: '',
    }),
    ...valid,
  ];
  const result = deriveJourneyReport(snapshot(input), gitFacts);
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'invalid_event_data');
  assert.equal(result.facts.usage.totalTokens, null);
  assert.deepEqual(result.facts.usage.unknownSessions, ['event-1']);
  const observed = result.facts.sessions.find(
    (session) => session.sessionId === 'resumed-session',
  );
  assert.equal(observed?.usageMeasured, true);
  assert.equal(observed?.usage.totalTokens, 3);
});

test('journey refuses session and intent activity left after the final outcome', () => {
  const trailingEvents: TraceEvent[] = [
    row('intent:late', 'intent', { jobId: 'journey-job', epoch: 3 }),
    row('session:late', 'session_started', {
      intent: 'intent:late',
      jobId: 'journey-job',
      sessionId: 'late-session',
    }),
    row('session:late:lost', 'session_lost', {
      sessionId: 'late-session',
    }),
    row('checkpoint:late', 'checkpoint', {
      intent: 'intent:late',
      sessionId: 'late-session',
      next: 'done',
    }),
    row('commit:late', 'commit', {
      intent: 'intent:late',
      sessionId: 'late-session',
      sha: headSha,
    }),
  ];
  const trailing = deriveJourneyReport(
    snapshot([...events(), ...trailingEvents]),
    gitFacts,
  );
  assert.equal(trailing.kind, 'refusal');
  if (trailing.kind === 'refusal')
    assert.equal(trailing.code, 'incomplete_final_outcome');
});

test('journey permits an operator window to close after completion', () => {
  const operatorStop = events().find(
    (event) => event.key === 'operator-stop:1',
  );
  assert.ok(operatorStop);
  const closedAfterCompletion = [
    ...events().filter((event) => event.key !== 'operator-stop:1'),
    operatorStop,
  ];
  const allowedWindow = deriveJourneyReport(
    snapshot(closedAfterCompletion),
    gitFacts,
  );
  assert.equal(allowedWindow.kind, 'journey');
  if (allowedWindow.kind === 'journey')
    assert.equal(allowedWindow.facts.operatorWindow.interventions, 1);
});

test('journey covers a done checkpoint and commit regardless of host exit', () => {
  const hostExitAfterCheckpoint = withSessionEnd(
    events(),
    'intent:2:ended:resumed-session',
    {
      exitCode: null,
      signal: 'SIGTERM',
      reasonKind: 'agent_message',
      claimsDone: false,
    },
  );
  const completed = deriveJourneyReport(
    snapshot(hostExitAfterCheckpoint),
    gitFacts,
  );
  assert.equal(completed.kind, 'journey');
  if (completed.kind === 'journey')
    assert.equal(completed.facts.resumed.sessionId, 'resumed-session');
});

test('journey permits an empty idempotent completed invocation', () => {
  const emptyFinalRun = [
    ...events(),
    row('job-outcome:idempotent', 'job_outcome', {
      exitCode: 0,
      signal: null,
      cleanup: 'verified',
      reason: 'completed',
      outcomeKind: 'review',
    }),
  ];
  const idempotent = deriveJourneyReport(snapshot(emptyFinalRun), gitFacts);
  assert.equal(idempotent.kind, 'journey');
});

test('journey does not borrow completion evidence across uncovered work', () => {
  const uncoveredWork = [
    ...events(),
    row('intent:uncovered', 'intent', {
      jobId: 'journey-job',
      epoch: 3,
    }),
    row('job-outcome:uncovered-empty', 'job_outcome', {
      exitCode: 0,
      signal: null,
      cleanup: 'verified',
      reason: 'completed',
    }),
  ];
  const uncovered = deriveJourneyReport(snapshot(uncoveredWork), gitFacts);
  assert.equal(uncovered.kind, 'refusal');
  if (uncovered.kind === 'refusal')
    assert.equal(uncovered.code, 'missing_resumed_completion');
});

test('journey compares accepted SHA spelling without changing observed spelling', () => {
  const uppercase = headSha.toUpperCase();
  const trace = events().map((event) =>
    event.key === 'intent:2:commit:resumed-session'
      ? row(event.key, event.kind, { ...event.data, sha: uppercase })
      : event,
  );
  const result = deriveJourneyReport(snapshot(trace), gitFacts);
  assert.equal(result.kind, 'journey');
  if (result.kind === 'journey')
    assert.equal(result.facts.resumed.commitSha, uppercase);
});

test('journey makes a saturated per-session total explicitly unknown', () => {
  const perSessionSaturation = withSessionEnd(
    events(),
    'intent:2:ended:resumed-session',
    {
      usage: {
        inputTokens: Number.MAX_SAFE_INTEGER - 1,
        outputTokens: 2,
        totalTokens: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  const saturated = deriveJourneyReport(
    snapshot(perSessionSaturation),
    gitFacts,
  );
  assert.equal(saturated.kind, 'journey');
  assert.equal(saturated.facts.usage.totalTokens, null);
  assert.deepEqual(saturated.facts.usage.unknownSessions, [
    'interrupted-session',
    'resumed-session',
  ]);
  const usage = saturated.facts.usage as unknown as Record<string, unknown>;
  assert.equal(usage.unknownReason, 'session_total_overflow');
  assert.deepEqual(usage.affectedSessions, ['resumed-session']);

  const counterAtMaximum = withSessionEnd(
    events(),
    'intent:2:ended:resumed-session',
    {
      usage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        totalTokens: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  const saturatedCounter = deriveJourneyReport(
    snapshot(counterAtMaximum),
    gitFacts,
  );
  assert.equal(saturatedCounter.kind, 'journey');
  assert.equal(saturatedCounter.facts.usage.totalTokens, null);
  const saturatedUsage = saturatedCounter.facts.usage as unknown as Record<
    string,
    unknown
  >;
  assert.equal(saturatedUsage.unknownReason, 'session_counter_saturated');
  assert.deepEqual(saturatedUsage.affectedSessions, ['resumed-session']);
});

test('journey makes an unrepresentable aggregate total explicitly unknown', () => {
  const sixQuadrillion = 6_000_000_000_000_000;
  const twoMeasuredSessions = withSessionEnd(
    events(),
    'intent:2:ended:resumed-session',
    {
      usage: {
        inputTokens: sixQuadrillion,
        outputTokens: 0,
        totalTokens: sixQuadrillion,
      },
    },
  );
  const outcomeIndex = twoMeasuredSessions.findIndex(
    (event) => event.key === 'job-outcome:complete',
  );
  assert.ok(outcomeIndex > 0);
  twoMeasuredSessions.splice(
    outcomeIndex,
    0,
    row('intent:2:session:second', 'session_started', {
      intent: 'intent:2',
      jobId: 'journey-job',
      sessionId: 'resumed-session-2',
    }),
    row('intent:2:session:second:end', 'session_ended', {
      intent: 'intent:2',
      sessionId: 'resumed-session-2',
      end: {
        exitCode: 0,
        signal: null,
        reasonKind: 'exit',
        claimsDone: true,
        usage: {
          inputTokens: sixQuadrillion,
          outputTokens: 0,
          totalTokens: sixQuadrillion,
        },
        usageObservation: {
          turnsStarted: 1,
          turnsCompleted: 1,
          invalidFields: 0,
        },
      },
    }),
    row('intent:2:checkpoint:second', 'checkpoint', {
      intent: 'intent:2',
      sessionId: 'resumed-session-2',
      next: 'done',
    }),
    row('intent:2:commit:second', 'commit', {
      intent: 'intent:2',
      sessionId: 'resumed-session-2',
      sha: headSha,
    }),
  );
  const aggregate = deriveJourneyReport(
    snapshot(twoMeasuredSessions),
    gitFacts,
  );
  assert.equal(aggregate.kind, 'journey');
  assert.equal(aggregate.facts.usage.totalTokens, null);
  const aggregateUsage = aggregate.facts.usage as unknown as Record<
    string,
    unknown
  >;
  assert.equal(aggregateUsage.unknownReason, 'aggregate_overflow');
  assert.deepEqual(aggregateUsage.affectedSessions, [
    'resumed-session',
    'resumed-session-2',
  ]);
});

test('journey retains an exact measured zero for a clean session', () => {
  const clean = events().filter(
    (event) =>
      !event.key.startsWith('intent:1') &&
      event.key !== 'job-outcome:stop' &&
      !event.key.startsWith('operator-') &&
      !event.key.startsWith('lead-intervention:'),
  );
  const zero = withSessionEnd(clean, 'intent:2:ended:resumed-session', {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageObservation: {
      turnsStarted: 0,
      turnsCompleted: 0,
      invalidFields: 0,
    },
  });
  const result = deriveJourneyReport(snapshot(zero), gitFacts);
  assert.equal(result.kind, 'refusal');
  assert.equal(result.facts.usage.totalTokens, 0);
  assert.deepEqual(result.facts.usage.unknownSessions, []);
});
