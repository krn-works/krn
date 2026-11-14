import { main } from '../../src/successor/probe.ts';

// Prove a successor-launch change against the live Herdr: run by hand from a lead pane.
// The logic lives in src/successor/probe.ts; this entry passes argv and the exit code.
process.exitCode = await main(process.argv.slice(2));
