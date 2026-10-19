import type {
  ReadonlyTraceEvent,
  ReadonlyTraceSnapshot,
} from '../trace/index.ts';

export type GitFacts = Readonly<{
  headSha: string | null;
  isDirty: boolean | null;
}>;

export type JourneyRefusalCode =
  | 'invalid_arguments'
  | 'trace_unavailable'
  | 'git_unavailable'
  | 'invalid_snapshot'
  | 'invalid_git_facts'
  | 'malformed_trace_tail'
  | 'invalid_event_data'
  | 'missing_job_outcome'
  | 'cleanup_unconfirmed'
  | 'missing_interruption'
  | 'missing_resumed_completion'
  | 'missing_commit'
  | 'head_mismatch'
  | 'incomplete_final_outcome';

export type JourneyCheck = Readonly<{
  id: string;
  ok: boolean;
  evidence?: string;
}>;

type TraceFacts = Readonly<{
  sha256: string;
  byteLength: number;
  malformedTail: boolean;
  finalRowUnterminated: boolean;
}>;

type OutcomeFact = Readonly<{
  key: string;
  exitCode: number;
  signal: string | null;
  cleanup: 'verified' | 'unconfirmed';
  reason: string;
  outcomeKind?: string;
}>;

type SessionFact = Readonly<{
  intent: string;
  sessionId: string;
  started: boolean;
  ended: boolean;
  exitCode?: number | null;
  signal?: string | null;
  reasonKind?: string;
  usage: SessionUsageFact;
  usageMeasured: boolean;
  usageReason?: SessionUsageReason;
}>;

type SessionUsageFact = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  observation?: Readonly<{
    turnsStarted?: number;
    turnsCompleted?: number;
    invalidFields?: number;
  }>;
}>;

type SessionUsageReason =
  | 'stopped_run'
  | 'missing_outcome'
  | 'session_unended'
  | 'incomplete_observation'
  | 'invalid_usage'
  | 'session_total_overflow'
  | 'session_counter_saturated';

export type JourneyFacts = Readonly<{
  jobId: string;
  trace: TraceFacts;
  git: GitFacts;
  jobOutcomes: readonly OutcomeFact[];
  sessions: readonly SessionFact[];
  interruption: Readonly<{ signal: string; exitCode: number }> | null;
  resumed: Readonly<{
    intent: string;
    sessionId: string;
    commitSha: string;
  }> | null;
  usage: Readonly<{
    totalTokens: number | null;
    unknownSessions: readonly string[];
    unknownReason?:
      | 'stopped_run'
      | 'incomplete_observation'
      | 'session_total_overflow'
      | 'session_counter_saturated'
      | 'aggregate_overflow'
      | 'no_sessions';
    affectedSessions?: readonly string[];
  }>;
  operatorWindow: Readonly<{
    closedWindows: number | null;
    interventions: number | null;
    reconstructionPrompts: number | null;
  }>;
  escapedDefects: null;
}>;

type CompletedJourneyFacts = Omit<JourneyFacts, 'interruption' | 'resumed'> &
  Readonly<{
    interruption: Exclude<JourneyFacts['interruption'], null>;
    resumed: Exclude<JourneyFacts['resumed'], null>;
  }>;

export type JourneyReport =
  | Readonly<{
      schemaVersion: 1;
      kind: 'journey';
      facts: CompletedJourneyFacts;
      checks: readonly JourneyCheck[];
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'refusal';
      code: JourneyRefusalCode;
      facts: JourneyFacts;
      checks: readonly JourneyCheck[];
    }>;

type Outcome = OutcomeFact & { readonly index: number };
type Session = {
  readonly intent: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly startedIndex: number;
  readonly startedAt: string;
  endedIndex?: number;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  reasonKind?: string;
  usage: SessionUsageFact;
  usageMeasured: boolean;
  usageReason?: SessionUsageReason;
  tokenTotal?: number;
  runOutcome?: Outcome;
  usageEvaluation?: UsageEvaluation;
};
type UsageEvaluation = {
  facts: SessionUsageFact;
  total?: number;
  reason?: Exclude<
    SessionUsageReason,
    'stopped_run' | 'missing_outcome' | 'session_unended'
  >;
};
type Completion = Readonly<{
  intent: string;
  sessionId: string;
  commitSha: string;
  session: Session;
  endIndex: number;
  checkpointIndex: number;
  commitIndex: number;
}>;

const signalValues = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'wall-timeout']);
const reasonValues = new Set([
  'completed',
  'stopped',
  'wall-timeout',
  'runjob-error',
  'cleanup-unconfirmed',
  'trace-error',
]);
const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isJobId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}

function baseFacts(
  snapshot: ReadonlyTraceSnapshot | null,
  gitFacts: GitFacts | null,
): JourneyFacts {
  return {
    jobId: snapshot?.jobId ?? '',
    trace: snapshot
      ? {
          sha256: snapshot.sha256,
          byteLength: snapshot.byteLength,
          malformedTail: snapshot.malformedTail,
          finalRowUnterminated: snapshot.finalRowUnterminated,
        }
      : {
          sha256: '',
          byteLength: 0,
          malformedTail: false,
          finalRowUnterminated: false,
        },
    git: gitFacts ?? { headSha: null, isDirty: null },
    jobOutcomes: [],
    sessions: [],
    interruption: null,
    resumed: null,
    usage: {
      totalTokens: null,
      unknownSessions: [],
      unknownReason: 'no_sessions',
    },
    operatorWindow: {
      closedWindows: null,
      interventions: null,
      reconstructionPrompts: null,
    },
    escapedDefects: null,
  };
}

function refusal(
  code: JourneyRefusalCode,
  facts: JourneyFacts,
  checks: readonly JourneyCheck[],
): JourneyReport {
  return { schemaVersion: 1, kind: 'refusal', code, facts, checks };
}

export function refusalReport(code: JourneyRefusalCode): JourneyReport {
  const facts = baseFacts(null, null);
  return refusal(code, facts, [{ id: 'inputs', ok: false, evidence: code }]);
}

function validSnapshot(snapshot: ReadonlyTraceSnapshot): boolean {
  return (
    isRecord(snapshot) &&
    isJobId(snapshot.jobId) &&
    Array.isArray(snapshot.events) &&
    typeof snapshot.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(snapshot.sha256) &&
    isSafeCounter(snapshot.byteLength) &&
    typeof snapshot.malformedTail === 'boolean' &&
    typeof snapshot.finalRowUnterminated === 'boolean' &&
    snapshot.events.every(
      (event) =>
        isRecord(event) &&
        typeof event.key === 'string' &&
        typeof event.kind === 'string' &&
        typeof event.at === 'string' &&
        isRecord(event.data),
    )
  );
}

function validGitFacts(gitFacts: GitFacts): boolean {
  return (
    isRecord(gitFacts) &&
    (gitFacts.headSha === null ||
      (typeof gitFacts.headSha === 'string' &&
        /^[a-f0-9]{40,64}$/iu.test(gitFacts.headSha))) &&
    (gitFacts.isDirty === null || typeof gitFacts.isDirty === 'boolean')
  );
}

function parseOutcome(
  event: ReadonlyTraceEvent,
  index: number,
): Outcome | null {
  const data = event.data;
  if (
    !isSafeCounter(data.exitCode) ||
    data.exitCode > 255 ||
    !(
      data.signal === null ||
      (typeof data.signal === 'string' && signalValues.has(data.signal))
    ) ||
    (data.cleanup !== 'verified' && data.cleanup !== 'unconfirmed') ||
    typeof data.reason !== 'string' ||
    !reasonValues.has(data.reason) ||
    (data.outcomeKind !== undefined && typeof data.outcomeKind !== 'string')
  )
    return null;
  return {
    index,
    key: event.key,
    exitCode: data.exitCode,
    signal: data.signal,
    cleanup: data.cleanup,
    reason: data.reason,
    ...(typeof data.outcomeKind === 'string'
      ? { outcomeKind: data.outcomeKind }
      : {}),
  };
}

function matchingSession(
  sessions: readonly Session[],
  intent: string,
  sessionId: string,
): Session | undefined {
  return sessions.find(
    (session) => session.intent === intent && session.sessionId === sessionId,
  );
}

function observeUsage(
  sessions: readonly Session[],
  malformedStartMarkers: readonly string[],
): {
  totalTokens: number | null;
  unknownSessions: string[];
  unknownReason?: NonNullable<JourneyFacts['usage']['unknownReason']>;
  affectedSessions?: string[];
} {
  const unknownSessions = [...malformedStartMarkers];
  const stoppedSessions: string[] = [];
  const saturatedSessions: string[] = [];
  const sessionOverflowSessions: string[] = [];
  const measuredSessions: string[] = [];
  const incompleteSessions = [...malformedStartMarkers];
  let total = 0n;
  for (const session of sessions) {
    if (!session.usageMeasured || session.tokenTotal === undefined) {
      unknownSessions.push(session.sessionId);
      if (session.usageReason === 'stopped_run')
        stoppedSessions.push(session.sessionId);
      else if (session.usageReason === 'session_counter_saturated')
        saturatedSessions.push(session.sessionId);
      else if (session.usageReason === 'session_total_overflow')
        sessionOverflowSessions.push(session.sessionId);
      else incompleteSessions.push(session.sessionId);
      continue;
    }
    measuredSessions.push(session.sessionId);
    total += BigInt(session.tokenTotal);
  }
  if (total > maxSafe)
    return {
      totalTokens: null,
      unknownSessions,
      unknownReason: 'aggregate_overflow',
      affectedSessions: [...new Set(measuredSessions)],
    };
  if (unknownSessions.length > 0) {
    const reason = saturatedSessions.length
      ? 'session_counter_saturated'
      : sessionOverflowSessions.length
        ? 'session_total_overflow'
        : stoppedSessions.length
          ? 'stopped_run'
          : 'incomplete_observation';
    const affectedSessions =
      saturatedSessions.length > 0
        ? saturatedSessions
        : sessionOverflowSessions.length > 0
          ? sessionOverflowSessions
          : reason === 'stopped_run'
            ? stoppedSessions
            : incompleteSessions;
    return {
      totalTokens: null,
      unknownSessions,
      unknownReason: reason,
      affectedSessions,
    };
  }
  return {
    totalTokens:
      sessions.length > 0 && unknownSessions.length === 0
        ? Number(total)
        : null,
    unknownSessions,
    ...(sessions.length === 0 ? { unknownReason: 'no_sessions' as const } : {}),
  };
}

function observeOperatorWindow(events: readonly ReadonlyTraceEvent[]): {
  closedWindows: number | null;
  interventions: number | null;
  reconstructionPrompts: number | null;
} {
  const open = new Map<string, number>();
  const windows: Array<readonly [number, number]> = [];
  let valid = true;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    if (event.kind !== 'operator_start' && event.kind !== 'operator_stop')
      continue;
    const operator = event.data.operator;
    if (typeof operator !== 'string' || operator.length === 0) {
      valid = false;
      continue;
    }
    if (event.kind === 'operator_start') {
      if (open.has(operator)) valid = false;
      else open.set(operator, index);
      continue;
    }
    const start = open.get(operator);
    if (start === undefined) valid = false;
    else {
      windows.push([start, index]);
      open.delete(operator);
    }
  }
  if (!valid || open.size > 0 || windows.length === 0)
    return {
      closedWindows: null,
      interventions: null,
      reconstructionPrompts: null,
    };

  let interventions = 0;
  let reconstructionPrompts = 0;
  for (const [index, event] of events.entries()) {
    if (
      !windows.some(([start, stop]) => index > start && index < stop) ||
      event.kind !== 'lead_intervention'
    )
      continue;
    if (event.data.kind === 'intervention') interventions += 1;
    else if (event.data.kind === 'reconstruction_prompt')
      reconstructionPrompts += 1;
    else
      return {
        closedWindows: null,
        interventions: null,
        reconstructionPrompts: null,
      };
  }
  return {
    closedWindows: windows.length,
    interventions,
    reconstructionPrompts,
  };
}

function isVerifiedStop(outcome: Outcome): boolean {
  return (
    (outcome.reason === 'stopped' &&
      (outcome.signal === 'SIGINT' ||
        outcome.signal === 'SIGTERM' ||
        outcome.signal === 'SIGHUP') &&
      outcome.exitCode === 130) ||
    (outcome.reason === 'wall-timeout' &&
      outcome.signal === 'wall-timeout' &&
      outcome.exitCode === 124)
  );
}

function safeCounter(value: unknown): number | undefined {
  return isSafeCounter(value) ? value : undefined;
}

function usageFacts(end: Record<string, unknown>): UsageEvaluation {
  const usage = end.usage;
  const observation = end.usageObservation;
  const inputTokens = isRecord(usage)
    ? safeCounter(usage.inputTokens)
    : undefined;
  const outputTokens = isRecord(usage)
    ? safeCounter(usage.outputTokens)
    : undefined;
  const totalTokens = isRecord(usage)
    ? safeCounter(usage.totalTokens)
    : undefined;
  const turnsStarted = isRecord(observation)
    ? safeCounter(observation.turnsStarted)
    : undefined;
  const turnsCompleted = isRecord(observation)
    ? safeCounter(observation.turnsCompleted)
    : undefined;
  const invalidFields = isRecord(observation)
    ? safeCounter(observation.invalidFields)
    : undefined;
  const observationFacts = {
    ...(turnsStarted === undefined ? {} : { turnsStarted }),
    ...(turnsCompleted === undefined ? {} : { turnsCompleted }),
    ...(invalidFields === undefined ? {} : { invalidFields }),
  };
  const facts: SessionUsageFact = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(Object.keys(observationFacts).length === 0
      ? {}
      : { observation: observationFacts }),
  };
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined ||
    turnsStarted === undefined ||
    turnsCompleted === undefined ||
    invalidFields === undefined
  )
    return { facts, reason: 'invalid_usage' };
  if (invalidFields !== 0 || turnsStarted !== turnsCompleted)
    return { facts, reason: 'incomplete_observation' };
  const sum = BigInt(inputTokens) + BigInt(outputTokens);
  if (sum > maxSafe) return { facts, reason: 'session_total_overflow' };
  if (
    [
      inputTokens,
      outputTokens,
      totalTokens,
      turnsStarted,
      turnsCompleted,
      invalidFields,
    ].some((counter) => counter === Number.MAX_SAFE_INTEGER)
  )
    return { facts, reason: 'session_counter_saturated' };
  if (totalTokens !== Number(sum)) return { facts, reason: 'invalid_usage' };
  return { facts, total: totalTokens };
}

function getCompletion(
  events: readonly ReadonlyTraceEvent[],
  sessions: readonly Session[],
  stopIndex: number,
  finalOutcomeIndex: number,
): Completion | undefined {
  const candidates: Completion[] = [];
  for (const session of sessions) {
    if (session.startedIndex <= stopIndex || session.endedIndex === undefined)
      continue;
    const endIndex = session.endedIndex;
    if (endIndex >= finalOutcomeIndex) continue;
    const checkpoint = events.findIndex(
      (event, index) =>
        index > endIndex &&
        index < finalOutcomeIndex &&
        event.kind === 'checkpoint' &&
        event.data.intent === session.intent &&
        event.data.sessionId === session.sessionId &&
        event.data.next === 'done',
    );
    if (checkpoint < 0) continue;
    const commitIndex = events.findIndex(
      (event, index) =>
        index > checkpoint &&
        index < finalOutcomeIndex &&
        event.kind === 'commit' &&
        event.data.intent === session.intent &&
        event.data.sessionId === session.sessionId &&
        typeof event.data.sha === 'string' &&
        /^[a-f0-9]{40,64}$/iu.test(event.data.sha),
    );
    if (commitIndex < 0) continue;
    const commit = events[commitIndex];
    if (!commit || typeof commit.data.sha !== 'string') continue;
    candidates.push({
      intent: session.intent,
      sessionId: session.sessionId,
      commitSha: commit.data.sha,
      session,
      endIndex,
      checkpointIndex: checkpoint,
      commitIndex,
    });
  }
  return candidates.at(-1);
}

function isJourneyWork(event: ReadonlyTraceEvent): boolean {
  return (
    event.kind === 'intent' ||
    event.kind === 'session_started' ||
    event.kind === 'session_ended' ||
    event.kind === 'session_lost' ||
    event.kind === 'checkpoint' ||
    event.kind === 'commit'
  );
}

function isCompletedOutcome(outcome: Outcome): boolean {
  return (
    outcome.reason === 'completed' &&
    outcome.exitCode === 0 &&
    outcome.signal === null &&
    outcome.cleanup === 'verified'
  );
}

function completionIsCovered(
  completion: Completion,
  outcomes: readonly Outcome[],
  finalOutcome: Outcome,
  events: readonly ReadonlyTraceEvent[],
): boolean {
  const owningOutcome = completion.session.runOutcome;
  if (!owningOutcome || !isCompletedOutcome(owningOutcome)) return false;
  if (owningOutcome.index > finalOutcome.index) return false;
  if (
    events
      .slice(owningOutcome.index + 1, finalOutcome.index)
      .some(isJourneyWork)
  )
    return false;
  return outcomes
    .filter(
      (outcome) =>
        outcome.index > owningOutcome.index &&
        outcome.index <= finalOutcome.index,
    )
    .every(isCompletedOutcome);
}

export function deriveJourneyReport(
  snapshot: ReadonlyTraceSnapshot,
  gitFacts: GitFacts,
): JourneyReport {
  if (!validSnapshot(snapshot)) return refusalReport('invalid_snapshot');
  const initialFacts = baseFacts(snapshot, gitFacts);
  if (!validGitFacts(gitFacts))
    return refusal('invalid_git_facts', initialFacts, [
      { id: 'git-facts', ok: false },
    ]);
  const checks: JourneyCheck[] = [];
  const events = snapshot.events;
  const outcomes: Outcome[] = [];
  const sessions: Session[] = [];
  const malformedStartMarkers: string[] = [];
  let invalidData = false;

  for (const [index, event] of events.entries()) {
    if (event.kind === 'job_outcome') {
      const outcome = parseOutcome(event, index);
      if (!outcome) invalidData = true;
      else outcomes.push(outcome);
    }
    if (event.kind !== 'session_started') continue;
    const intent = event.data.intent;
    const sessionId = event.data.sessionId;
    const jobId = event.data.jobId;
    if (
      typeof intent !== 'string' ||
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      !isJobId(jobId) ||
      jobId !== snapshot.jobId ||
      matchingSession(sessions, intent, sessionId)
    ) {
      invalidData = true;
      malformedStartMarkers.push(`event-${index + 1}`);
      continue;
    }
    sessions.push({
      intent,
      sessionId,
      jobId,
      startedIndex: index,
      startedAt: event.at,
      usage: {},
      usageMeasured: false,
    });
  }

  for (const [index, event] of events.entries()) {
    if (event.kind !== 'session_ended') continue;
    const intent = event.data.intent;
    const sessionId = event.data.sessionId;
    if (typeof intent !== 'string' || typeof sessionId !== 'string') {
      invalidData = true;
      continue;
    }
    const session = matchingSession(sessions, intent, sessionId);
    const end = event.data.end;
    if (
      !session ||
      session.endedIndex !== undefined ||
      index <= session.startedIndex ||
      !isRecord(end) ||
      !(
        end.exitCode === null ||
        (typeof end.exitCode === 'number' && Number.isInteger(end.exitCode))
      ) ||
      !(end.signal === null || typeof end.signal === 'string') ||
      typeof end.reasonKind !== 'string'
    ) {
      invalidData = true;
      continue;
    }
    session.endedIndex = index;
    session.endedAt = event.at;
    session.exitCode = end.exitCode;
    session.signal = end.signal;
    session.reasonKind = end.reasonKind;
    session.usageEvaluation = usageFacts(end);
    session.usage = session.usageEvaluation.facts;
  }

  for (const session of sessions) {
    const runOutcome = outcomes.find(
      (outcome) => outcome.index > session.startedIndex,
    );
    if (runOutcome) session.runOutcome = runOutcome;
    if (
      session.runOutcome &&
      session.endedIndex !== undefined &&
      session.endedIndex > session.runOutcome.index
    ) {
      invalidData = true;
    }
    if (session.endedIndex === undefined) {
      session.usageReason = 'session_unended';
      continue;
    }
    if (!session.runOutcome) {
      session.usageReason = 'missing_outcome';
      continue;
    }
    if (isVerifiedStop(session.runOutcome)) {
      session.usageReason = 'stopped_run';
      continue;
    }
    const evaluation = session.usageEvaluation;
    if (!evaluation || evaluation.total === undefined) {
      session.usageReason = evaluation?.reason ?? 'invalid_usage';
      continue;
    }
    session.usageMeasured = true;
    session.tokenTotal = evaluation.total;
  }

  const usage = observeUsage(sessions, malformedStartMarkers);
  const operatorWindow = observeOperatorWindow(events);
  const facts: JourneyFacts = {
    ...initialFacts,
    jobOutcomes: outcomes.map(({ index: _index, ...outcome }) => outcome),
    sessions: sessions.map((session) => ({
      intent: session.intent,
      sessionId: session.sessionId,
      started: true,
      ended: session.endedIndex !== undefined,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      ...(session.signal === undefined ? {} : { signal: session.signal }),
      ...(session.reasonKind === undefined
        ? {}
        : { reasonKind: session.reasonKind }),
      usage: session.usage,
      usageMeasured: session.usageMeasured,
      ...(session.usageReason === undefined
        ? {}
        : { usageReason: session.usageReason }),
    })),
    usage,
    operatorWindow,
  };

  if (invalidData)
    return refusal('invalid_event_data', facts, [
      { id: 'event-data', ok: false },
    ]);
  if (snapshot.malformedTail)
    return refusal('malformed_trace_tail', facts, [
      { id: 'trace-tail', ok: false, evidence: 'malformed final row ignored' },
    ]);
  if (outcomes.length === 0) {
    checks.push({ id: 'job-outcome', ok: false });
    return refusal('missing_job_outcome', facts, checks);
  }
  checks.push({ id: 'job-outcome', ok: true });
  if (
    outcomes.some(
      (outcome) =>
        outcome.cleanup !== 'verified' ||
        outcome.reason === 'cleanup-unconfirmed',
    ) ||
    events.some((event) => event.kind === 'teardown_unconfirmed')
  ) {
    checks.push({ id: 'cleanup', ok: false });
    return refusal('cleanup_unconfirmed', facts, checks);
  }
  checks.push({ id: 'cleanup', ok: true });

  const finalOutcome = outcomes.at(-1);
  if (!finalOutcome || !isCompletedOutcome(finalOutcome)) {
    checks.push({ id: 'final-outcome', ok: false });
    return refusal('incomplete_final_outcome', facts, checks);
  }
  if (events.slice(finalOutcome.index + 1).some(isJourneyWork)) {
    checks.push({ id: 'final-outcome', ok: false });
    return refusal('incomplete_final_outcome', facts, checks);
  }
  checks.push({ id: 'final-outcome', ok: true });

  const stop = outcomes
    .filter(
      (outcome) =>
        outcome.index < finalOutcome.index && isVerifiedStop(outcome),
    )
    .at(-1);
  if (!stop) {
    checks.push({ id: 'interruption', ok: false });
    return refusal('missing_interruption', facts, checks);
  }
  const previousOutcome = outcomes
    .filter((outcome) => outcome.index < stop.index)
    .at(-1);
  const interruptedSession = sessions.find(
    (session) =>
      session.startedIndex > (previousOutcome?.index ?? -1) &&
      session.startedIndex < stop.index &&
      session.endedIndex !== undefined &&
      session.endedIndex < stop.index &&
      session.runOutcome?.index === stop.index,
  );
  if (!interruptedSession) {
    checks.push({ id: 'interruption', ok: false });
    return refusal('missing_interruption', facts, checks);
  }
  checks.push({ id: 'interruption', ok: true });

  const completion = getCompletion(
    events,
    sessions,
    stop.index,
    finalOutcome.index,
  );
  if (!completion) {
    const resumedSessions = sessions.filter(
      (session) =>
        session.startedIndex > stop.index && session.endedIndex !== undefined,
    );
    const hasDone = resumedSessions.some((session) =>
      events.some(
        (event, index) =>
          index > (session.endedIndex ?? Number.MAX_SAFE_INTEGER) &&
          event.kind === 'checkpoint' &&
          event.data.intent === session.intent &&
          event.data.sessionId === session.sessionId &&
          event.data.next === 'done',
      ),
    );
    checks.push({
      id: 'resumed-completion',
      ok: false,
      evidence: hasDone ? 'commit missing' : 'completed checkpoint missing',
    });
    return refusal(
      hasDone ? 'missing_commit' : 'missing_resumed_completion',
      facts,
      checks,
    );
  }
  if (
    !completionIsCovered(completion, outcomes, finalOutcome, events) ||
    events
      .slice(completion.commitIndex + 1, finalOutcome.index)
      .some(isJourneyWork)
  ) {
    checks.push({ id: 'final-outcome', ok: false });
    return refusal('missing_resumed_completion', facts, checks);
  }
  const completedFacts: CompletedJourneyFacts = {
    ...facts,
    resumed: {
      intent: completion.intent,
      sessionId: completion.sessionId,
      commitSha: completion.commitSha,
    },
    interruption: { signal: stop.signal ?? '', exitCode: stop.exitCode },
  };
  checks.push({ id: 'resumed-completion', ok: true });
  checks.push({ id: 'commit', ok: true });
  if (gitFacts.headSha?.toLowerCase() !== completion.commitSha.toLowerCase()) {
    checks.push({ id: 'head-match', ok: false });
    return refusal('head_mismatch', completedFacts, checks);
  }
  checks.push({ id: 'head-match', ok: true });
  return {
    schemaVersion: 1,
    kind: 'journey',
    facts: completedFacts,
    checks,
  };
}
