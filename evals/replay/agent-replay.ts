// Usage: node evals/replay/agent-replay.ts --suite --dry-run [--verify]
//        node evals/replay/agent-replay.ts --suite [--case <id>] [--reps <1..5>] [--model sonnet] [--harness <rev>] [--no-memory]
// AgentReplay: resume a recorded KRN lead session cut just before a confirmed wrong decision, under the checkout's
// current harness, and grade by a regex whether the session repeats it. --dry-run lists each case with its cut point and
// reads no transcript unless --verify is given (then a case whose cut line moved fails with exit 1; a missing transcript
// is reported and skipped). The live run clones the repository at --harness (default HEAD) with no remote, runs each rep
// in the replay sandbox (private config, no GitHub identity, no real checkout mounted) and prints the repeat rate per case.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  projectSlug,
  readPrefix,
} from '../../src/harness/transcript-prefix.ts';
import { withSessionSlot } from '../session-slot.ts';
import { requireSandbox } from '../units/sandbox.ts';
import {
  REPLAY_CASES,
  type ReplayCase,
  transcriptDir,
} from './agent-replay-cases.ts';
import { repeats, replayEvents } from './agent-replay-grade.ts';
import { sandboxedSession } from './arm-session.ts';
import { ARMS } from './arms.ts';
import { isolatedEnv } from './live.ts';
import { sessionRan } from './session.ts';

export const MAX_REPS = 5;

/** One listing line: the case, its cut point and what a repeat looks like. */
export const caseLine = (c: ReplayCase): string =>
  `${c.id}\t${c.transcript}\tcut=${c.cut}\tgrader=${c.grader.on}:/${c.grader.pattern}/${c.grader.unlessBefore ? ` unless /${c.grader.unlessBefore}/` : ''}\tprevention=${c.prevention}`;

/** Prefix facts of a case from its transcript, or undefined when the transcript is absent. */
export async function verifyCase(c: ReplayCase, dir = transcriptDir()) {
  const path = join(dir, c.transcript);
  if (!existsSync(path)) return undefined;
  const p = await readPrefix(path, c.cut);
  const ok = p.cutUuid === c.cutUuid && p.cutRole === 'user';
  return {
    ok,
    messages: p.messages,
    bytes: p.bytes,
    dangling: p.danglingParents,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

async function dryRun(cases: readonly ReplayCase[], verify: boolean) {
  let bad = 0;
  for (const c of cases) {
    console.log(caseLine(c));
    if (!verify) continue;
    const v = await verifyCase(c);
    if (!v) console.log(`  transcript absent: ${c.transcript}`);
    else {
      console.log(
        `  prefix: ${v.messages} messages, ~${Math.round(v.bytes / 4)} tokens upper bound, cut line ${v.ok ? 'matches' : 'MOVED'}, dangling parents ${v.dangling}`,
      );
      if (!v.ok) bad++;
    }
  }
  console.log(`suite: ${cases.length} cases`);
  return bad === 0 ? 0 : 1;
}

async function liveRep(
  c: ReplayCase,
  scratch: string,
  o: { model: string; harness: string; memory: boolean },
): Promise<boolean | undefined> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const wt = join(scratch, 'checkout');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', root, wt]);
  execFileSync('git', ['checkout', '-q', o.harness], { cwd: wt });
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: wt });
  // The checkout's own hooks import its dependencies; without them every Stop fails and the session chases the error.
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: wt,
    stdio: 'ignore',
  });
  const env = isolatedEnv(scratch, process.env);
  const sessionId = crypto.randomUUID();
  const project = join(
    env.CLAUDE_CONFIG_DIR as string,
    'projects',
    projectSlug(wt),
  );
  mkdirSync(project, { recursive: true });
  const prefix = await readPrefix(
    join(transcriptDir(), c.transcript),
    c.cut,
    sessionId,
  );
  if (prefix.cutUuid !== c.cutUuid || prefix.cutRole !== 'user')
    throw new Error(`${c.id}: the cut line moved`);
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    `${prefix.lines.join('\n')}\n`,
  );
  const memory = join(transcriptDir(), 'memory');
  if (o.memory && existsSync(memory))
    cpSync(memory, join(project, 'memory'), { recursive: true });
  const s = await withSessionSlot(() =>
    sandboxedSession(ARMS.A, wt, c.prompt, env, {
      model: o.model,
      budgetUsd: 1,
      sessionMs: 8 * 60_000,
      resume: sessionId,
    }),
  );
  if (!sessionRan(s)) return undefined;
  return repeats(c.grader, replayEvents(s.stdout));
}

async function suite(argv: string[]) {
  requireSandbox();
  const only = flag(argv, '--case');
  const reps = Math.min(Number(flag(argv, '--reps') ?? 1), MAX_REPS);
  const model = flag(argv, '--model') ?? 'sonnet';
  const harness = flag(argv, '--harness') ?? 'HEAD';
  const memory = !argv.includes('--no-memory');
  const cases = REPLAY_CASES.filter((c) => only === undefined || c.id === only);
  if (cases.length === 0) throw new Error(`unknown case: ${only}`);
  const base = resolve('.krn/tmp');
  mkdirSync(base, { recursive: true });
  let anyNoRun = false;
  for (const c of cases) {
    if (c.liveSkip) {
      console.log(`${c.id}\tskipped: ${c.liveSkip}`);
      continue;
    }
    let ran = 0;
    let repeated = 0;
    for (let r = 1; r <= reps; r++) {
      const scratch = mkdtempSync(join(base, 'agent-replay-'));
      const v = await liveRep(c, scratch, { model, harness, memory });
      if (v === undefined) continue;
      ran++;
      if (v) repeated++;
    }
    if (ran < reps) anyNoRun = true;
    console.log(
      `${c.id}\trepeat ${repeated}/${ran}\tharness=${harness}\tmemory=${memory}\tmodel=${model}`,
    );
  }
  return anyNoRun ? 65 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--suite')) {
    console.error('usage: agent-replay.ts --suite [--dry-run] [--verify]');
    process.exit(64);
  }
  const code = argv.includes('--dry-run')
    ? await dryRun(REPLAY_CASES, argv.includes('--verify'))
    : await suite(argv);
  process.exit(code);
}
