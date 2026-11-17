// The effort policy of a lane: low by default, high for the fix turn after a red required Check; the PR body records every turn's effort and the report groups by it.
import { LANE_MARKER } from './lane-marker.ts';

export type LaneEffort = 'low' | 'high';

/** The PR body line `krn pr body --lane` writes after the lane marker: the effort of each lane turn, comma separated. */
export const EFFORT_PREFIX = 'Lane effort: ';

/** The effort of a lane turn: high only when the previous turn's ship ended in a red Check (exit 74), low otherwise. */
export function laneEffort(afterRedCheck: boolean): LaneEffort {
  return afterRedCheck ? 'high' : 'low';
}

/** The efforts of every turn of a lane so far, this turn last: a first turn starts a new history, a rerun after a red Check appends. */
export function effortHistory(
  previous: readonly string[],
  afterRedCheck: boolean,
): string[] {
  return [...(afterRedCheck ? previous : []), laneEffort(afterRedCheck)];
}

export type EffortArm = 'before-policy' | 'under-policy';

/** The turn efforts a lane PR body records, or undefined when it carries no such line. */
export function recordedEfforts(body: string): string[] | undefined {
  const line = new RegExp(`^${EFFORT_PREFIX}(\\S+)\\s*$`, 'mu').exec(body);
  return line?.[1]?.split(',').filter(Boolean);
}

/** A lane PR is under the policy when its body records the effort of its turns; an older lane PR is before it; a non-lane PR has no arm. */
export function effortArm(body: string): EffortArm | undefined {
  if (!body.includes(LANE_MARKER)) return undefined;
  return recordedEfforts(body) === undefined ? 'before-policy' : 'under-policy';
}
