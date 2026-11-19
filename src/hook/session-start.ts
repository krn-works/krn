// SessionStart hook of an adopted repository (`krn hook session`): serves the standards block of the
// brain that match the session's task and logs the exposure. Worker sessions already hold the
// packet in their brief and get nothing. Any failure leaves the session untouched.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { emitContext, hookInput } from '../harness/claude.ts';
import { isWorkerSession } from './session.ts';
import { sessionStandards } from './session-standards.ts';

/** The context for one session of `project`, or undefined when no standard matches or the session is a worker's. */
export function sessionContext(
  project: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  resumedTranscript?: string,
): string | undefined {
  if (isWorkerSession(env)) return undefined;
  const [commonDirectory = '', branch = ''] = execFileSync(
    'git',
    ['rev-parse', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
    .trim()
    .split('\n');
  const main = dirname(resolve(project, commonDirectory));
  return sessionStandards(
    project,
    main,
    sessionId,
    branch,
    undefined,
    resumedTranscript,
  );
}

export function main(): void {
  try {
    const input = hookInput(['SessionStart']);
    const block = sessionContext(
      input.project,
      input.sessionId,
      process.env,
      input.source === 'resume' ? input.transcriptPath : undefined,
    );
    if (block) emitContext(input.event, block);
  } catch {
    /* A missing brain is not a reason to interrupt a session. */
  }
}

if (import.meta.main) main();
