// A failed lane proposes one edit to the worker rules its brief carries; the edit is accepted only
// when an offline replay over recorded lanes shows no regression and a gain on the failing case.
// Pure: the caller loads the recorded lanes and the records; nothing here runs a model.
import { type BrainRecord, brainPacket } from './packet.ts';

/** One recorded lane run, as the replay needs it. */
export type RecordedLane = {
  readonly task: string;
  readonly arm: 'A' | 'B';
  /** The convention the lane's scorer checks; it names the worker rule the lane needed. */
  readonly template: string;
  /** The id of the worker rule that convention is taught by. */
  readonly rule: string;
  /** The brief the lane received, without any carrier. */
  readonly brief: string;
  readonly passed: boolean;
  /** The scorer's reason when the lane failed. */
  readonly reason: string;
  /** The packet text the lane received; empty for arm A. */
  readonly packet: string;
  readonly asOf: string;
  readonly budget: number;
};

/** A proposed replacement or addition of one worker rule. */
export type LaneProposal = {
  readonly task: string;
  readonly template: string;
  readonly record: BrainRecord;
  readonly evidence: string;
};

/** The scorer's reason without the task id, cut before its first quote or colon-detail and at a word. */
const DETAIL_CHARS = 40;
const detail = (reason: string): string => {
  const text = (reason.replace(/^fail \S+?: /u, '').split(/ "|: /u)[0] ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= DETAIL_CHARS) return text;
  const cut = text.slice(0, DETAIL_CHARS + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).trimEnd();
};

/** The rule cut at a word so that rule plus `tail` is no longer than the rule was. */
function within(base: string, tail: string): string {
  const room = base.length - tail.length - 2;
  if (room >= base.length) return base;
  const cut = base.slice(0, Math.max(room, 0) + 1);
  const head = cut
    .slice(0, Math.max(cut.lastIndexOf(' '), 0))
    .replace(/[,;:\s]+$/u, '');
  return `${head}. ${tail}`.trim();
}

/**
 * One proposal for a failed lane: the rule of the lane's convention, restated within its own length, with the
 * way this lane broke it. Null for a passing lane.
 */
export function proposeEdit(
  lane: RecordedLane,
  records: readonly BrainRecord[],
): LaneProposal | null {
  if (lane.passed) return null;
  const id = lane.rule;
  const current = records.find((record) => record.id === id);
  const base = current?.text.trim() ?? '';
  const seen = `Lanes failed this: ${detail(lane.reason)}.`;
  const text = base === '' ? seen : within(base, seen);
  const record: BrainRecord = current
    ? { ...current, text }
    : {
        id,
        type: 'rule',
        text,
        recorded_at: lane.asOf,
        valid_from: lane.asOf,
        valid_to: null,
        source: `lane ${lane.task}`,
      };
  return {
    task: lane.task,
    template: lane.template,
    record,
    evidence: `${lane.task} arm ${lane.arm}: ${lane.reason}`,
  };
}

export type ReplayVerdict = {
  readonly verdict: 'accept' | 'reject';
  readonly lanes: number;
  /** Passing arm-B lanes whose packet loses a rule it carried, other than the edited one. */
  readonly regressions: readonly string[];
  /** Failed lanes whose packet now carries the proposed rule text it lacked. */
  readonly gains: readonly string[];
  /** Whether the failing case itself gains. */
  readonly failingCaseGains: boolean;
};

const lineOf = (record: BrainRecord) => `- [${record.id}] ${record.text}`;

/** Ids of the rules a recorded packet text carries. */
export function packetIds(text: string): string[] {
  return [...text.matchAll(/^- \[([^\]]+)\]/gmu)].map((m) => m[1] ?? '');
}

/**
 * Replays every recorded lane with the proposed rule in place. A lane with a carrier is rebuilt from
 * the records; an arm-A lane has no carrier, so the template cannot change its prompt and it only
 * counts toward `lanes`. Accept needs no regression and a gain on the failing case.
 */
export function replayProposal(
  proposal: LaneProposal,
  records: readonly BrainRecord[],
  lanes: readonly RecordedLane[],
): ReplayVerdict {
  const edited = [
    ...records.filter((record) => record.id !== proposal.record.id),
    proposal.record,
  ];
  const regressions: string[] = [];
  const gains: string[] = [];
  let failingCaseGains = false;
  for (const lane of lanes) {
    const rebuilt = brainPacket({
      task: lane.task,
      query: lane.brief,
      records: edited,
      asOf: lane.asOf,
      budget: lane.budget,
    });
    if (lane.arm === 'B' && lane.passed) {
      const kept = new Set(rebuilt.records);
      if (
        packetIds(lane.packet).some(
          (id) => id !== proposal.record.id && !kept.has(id),
        )
      )
        regressions.push(lane.task);
    }
    const isFailingCase = lane.task === proposal.task;
    const carries = rebuilt.text.includes(lineOf(proposal.record));
    if (
      !lane.passed &&
      carries &&
      !lane.packet.includes(lineOf(proposal.record))
    ) {
      gains.push(lane.task);
      if (isFailingCase) failingCaseGains = true;
    }
  }
  const accept = regressions.length === 0 && failingCaseGains;
  return {
    verdict: accept ? 'accept' : 'reject',
    lanes: lanes.length,
    regressions,
    gains,
    failingCaseGains,
  };
}

/** The one-line verdict the replay harness prints. */
export function renderVerdict(
  proposal: LaneProposal,
  result: ReplayVerdict,
): string {
  return `proposal ${proposal.record.id} from ${proposal.task}: replay lanes=${result.lanes} regressions=${result.regressions.length} gains=${result.gains.length} failing-case=${result.failingCaseGains ? 'gain' : 'no-gain'} verdict=${result.verdict}`;
}
