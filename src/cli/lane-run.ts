import { parseLaneRequest } from './lane-run/args.ts';
import { prepareLane } from './lane-run/prepare.ts';
import { sessionStage } from './lane-run/session.ts';
import {
  defaultSteps,
  type LaneRunSteps,
  type LaneVerdict,
} from './lane-run/steps.ts';
import { laneVerdict } from './lane-run/verdict.ts';

export type { LaneRunSteps, LaneVerdict };

/** The lane run is four stages: parse the request, prepare the lane, run the session, read the verdict. */
export async function laneRunCommand(
  args: string[],
  steps: LaneRunSteps = defaultSteps,
): Promise<LaneVerdict> {
  const request = parseLaneRequest(args);
  const lane = await prepareLane(request, steps);
  if ('line' in lane) return lane;
  return laneVerdict(lane, sessionStage(lane), steps);
}
