// Successor launch.
import { SESSION_CLASS_VARIABLE } from '../memory/operator-inbox-store.ts';
import {
  APP_CACHE_DIRECTORY,
  agentFlags,
  appCredentialEnvironment,
  checkAppCredential,
  detectHarness,
  EXIT_UNAVAILABLE,
  launcherPrompt,
  tabCreateArgs,
} from './compose.ts';
import {
  agentInfo,
  awaitAgent,
  callerWorkspace,
  createdIds,
  exitFailure,
  herdrFailure,
  run,
  serverIsRunning,
} from './herdr.ts';
import {
  parseArgs,
  START_SECONDS,
  type SuccessorLaunchOptions,
} from './options.ts';
import { retireMode, retirePredecessors } from './retire.ts';

// The successor launch: open a Herdr tab running the next agent, wait for it to show, retire the caller.
// Without Herdr a Claude lead falls back to `claude --bg`; Codex has no background mode and fails.

export function main(args: string[]): number {
  if (args[0] === '--retire') return retireMode(args.slice(1));
  let options: SuccessorLaunchOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n`,
    );
    return 2;
  }

  const detected = detectHarness(process.env);
  if ('error' in detected) {
    process.stderr.write(`${detected.error}\n`);
    return 2;
  }
  const { agent, harness } = detected;

  // Operator 2026-11-10 (t-xyjfsjz): a launched session proposes with the
  // GitHub App credential; --operator-token keeps the operator's own.
  const appCredential = options.operatorToken
    ? undefined
    : appCredentialEnvironment(process.env);
  if (appCredential) {
    const failed = checkAppCredential({
      ...process.env,
      KRN_APP_CACHE_DIR: process.env.KRN_APP_CACHE_DIR || APP_CACHE_DIRECTORY,
    });
    if (failed) {
      process.stderr.write(
        `GitHub App credential unavailable (${failed}); fix it or pass --operator-token to launch with the operator's credential\n`,
      );
      return EXIT_UNAVAILABLE;
    }
  }

  const status = run('herdr', ['status']);
  const paneId = process.env.HERDR_PANE_ID;
  let unavailable: string | undefined;
  let workspaceId: string | undefined;

  if (status.error || status.status !== 0 || !serverIsRunning(status.stdout))
    unavailable = herdrFailure(status);
  else if (paneId) {
    workspaceId = callerWorkspace(paneId);
    if (!workspaceId) unavailable = 'caller pane unavailable';
  }

  if (harness !== 'claude' && (options.model || options.effort)) {
    process.stderr.write(
      '--model and --effort apply only to Claude successors\n',
    );
    return 2;
  }
  const flags = agentFlags(harness, options);
  const prompt = launcherPrompt(options);
  if (unavailable && harness === 'codex') {
    // Codex has no background mode; never start Claude in its place.
    process.stderr.write(
      `codex successor needs Herdr (${unavailable}); no background launch exists\n`,
    );
    return 1;
  }
  if (unavailable) {
    const fallback = run(
      agent,
      [...flags, '--bg', '-n', options.name, prompt],
      options.cwd,
      15000,
      {
        ...process.env,
        ...appCredential,
        [SESSION_CLASS_VARIABLE]: options.sessionClass,
      },
    );
    if (fallback.error || fallback.status !== 0) return exitFailure(fallback);
    process.stdout.write(
      `successor: claude --bg (herdr unavailable: ${unavailable})\n`,
    );
    return 0;
  }

  const predecessorSession =
    paneId && workspaceId
      ? agentInfo(run('herdr', ['agent', 'get', paneId])).sessionId
      : undefined;
  const createArgs = tabCreateArgs({
    options,
    agent,
    prompt,
    workspaceId,
    appCredential,
    predecessor:
      paneId && predecessorSession
        ? { paneId, sessionId: predecessorSession }
        : undefined,
  });
  const created = run('herdr', createArgs);
  if (created.error || created.status !== 0) return exitFailure(created);

  const ids = createdIds(created.stdout);
  if (!ids) {
    process.stderr.write('herdr tab create returned no tab or pane id\n');
    return 1;
  }

  const started = run('herdr', [
    'pane',
    'run',
    ids.paneId,
    '"$KRN_SUCCESSOR_AGENT"',
    ...flags,
    // Codex has no session-name flag; the Herdr tab label carries the name.
    ...(harness !== 'codex' ? ['-n', '"$KRN_SUCCESSOR_NAME"'] : []),
    '"$KRN_SUCCESSOR_PROMPT"',
  ]);
  if (started.error || started.status !== 0) return exitFailure(started);

  // Herdr names claude and codex itself; an override's binary may be a
  // wrapper, so only Herdr's own kinds are matched by name.
  const expected = harness === 'other' ? undefined : harness;
  const seconds = options.startSeconds ?? START_SECONDS;
  const successor = awaitAgent(
    () => agentInfo(run('herdr', ['agent', 'get', ids.paneId])),
    expected,
    seconds,
  );
  if (!successor) {
    process.stderr.write(
      `successor not started: herdr pane ${ids.paneId} shows no ${expected ? `${expected} ` : ''}agent after ${seconds} s; tab ${ids.tabId} kept for inspection\n`,
    );
    return 1;
  }

  process.stdout.write(
    `successor: herdr tab ${ids.tabId} pane ${ids.paneId} agent ${successor.agent} ${successor.status ?? 'unknown'}\n`,
  );
  // A startup dialog (folder trust, an MCP approval, a login) holds a live
  // successor before its prompt. Failing the launch would invite a duplicate
  // successor, so the handoff stands and the operator learns the pane.
  if (successor.status === 'blocked')
    process.stderr.write(
      `successor waits on a startup dialog: answer it in herdr pane ${ids.paneId} (tab ${ids.tabId})\n`,
    );
  if (paneId) retirePredecessors(options, paneId);
  return 0;
}
