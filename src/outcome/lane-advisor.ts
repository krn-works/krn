// The advisor trial arm of a lane: the brief opts in, the PR body records it, the report groups by it.
import { LANE_MARKER } from './lane-marker.ts';

/** The PR body line `krn pr body --lane` writes after the lane marker: `fable` or `none`. */
export const ADVISOR_ARM_PREFIX = 'Advisor arm: ';

export type AdvisorArm = 'advisor' | 'none';

/** The advisor model a brief asks for with `lane-advisor: fable` (or the older `Advisor: on`), else undefined. */
export function laneAdvisor(prompt: string): 'fable' | undefined {
  return /^(?:lane-advisor: fable|Advisor: on)\s*$/mu.test(prompt)
    ? 'fable'
    : undefined;
}

/** The arm a lane PR body records, or undefined for a PR that is not a lane PR. */
export function advisorArm(body: string): AdvisorArm | undefined {
  if (!body.includes(LANE_MARKER)) return undefined;
  const line = new RegExp(`^${ADVISOR_ARM_PREFIX}(\\S+)\\s*$`, 'mu').exec(body);
  return line?.[1] === 'none' || line === null ? 'none' : 'advisor';
}
