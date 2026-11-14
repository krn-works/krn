// `krn lane run`: the verb that drives lane-run, kept apart from lane.ts that lane-run imports lazily.

import * as drain from './lane-run/drain.ts';
import { laneRunCommand } from './lane-run.ts';

async function drainCommand(args: string[]): Promise<void> {
  const request = drain.parseDrainRequest(args);
  const doctor = await drain.defaultDoctor();
  const result = await drain.drainReady(
    request,
    { ...drain.defaultDrainSeams, doctor },
    (line) => process.stdout.write(`${line}\n`),
  );
  process.exitCode = result.exitCode;
}

export async function laneRunVerb(rest: string[]): Promise<void> {
  if (rest.includes('--ready')) return drainCommand(rest);
  const verdict = await laneRunCommand(rest);
  process.stdout.write(`${verdict.line}\n`);
  process.exitCode = verdict.exitCode;
}
