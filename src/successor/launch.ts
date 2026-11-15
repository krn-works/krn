// Successor launch.

import { claudeAgent } from '../harness/claude.ts';
import { SESSION_CLASS_VARIABLE } from '../memory/operator-inbox-store.ts';
import { exitFailure, run } from './command.ts';
import {
  APP_CACHE_DIRECTORY,
  agentFlags,
  appCredentialEnvironment,
  checkAppCredential,
  detectHarness,
  EXIT_UNAVAILABLE,
  launcherPrompt,
  tabEnvironment,
} from './compose.ts';
import { logLaunch } from './launch-log.ts';
import {
  parseArgs,
  START_SECONDS,
  type SuccessorLaunchOptions,
} from './options.ts';
import { retireMode, retirePredecessors } from './retire.ts';
import {
  announcement,
  awaitAgent,
  isFailure,
  type ScopeRef,
  selectHost,
} from './terminal-host.ts';

// The successor launch: open a Herdr tab running the next agent, wait for it to show, retire the caller.
// Without Herdr a Claude lead falls back to `claude --bg`; Codex has no background mode and fails.

export function main(
  args: string[],
  doctor?: (args: string[]) => { text: string; exitCode: number },
): number {
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

  // An unattended successor with no App token or a short vault session dies mid-slice; refuse before opening a tab.
  if (options.unattended) {
    const report = doctor?.(['--unattended']) ?? {
      text: 'no unattended doctor wired',
      exitCode: 1,
    };
    if (report.exitCode !== 0) {
      process.stderr.write(
        `unattended launch refused: ${report.text.trim()}\n`,
      );
      return report.exitCode;
    }
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

  const host = selectHost();
  const paneId = host.self();
  let unavailable = host.status();
  let workspaceId: ScopeRef | undefined;

  if (!unavailable && paneId) {
    workspaceId = host.place(paneId).scope;
    if (!workspaceId) unavailable = 'caller pane unavailable';
  }

  if (harness !== claudeAgent && (options.model || options.effort)) {
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
    logLaunch(options.cwd, {
      name: options.name,
      agent: harness,
      via: 'background',
    });
    process.stdout.write(
      `successor: claude --bg (herdr unavailable: ${unavailable})\n`,
    );
    return 0;
  }

  const predecessorSession =
    paneId && workspaceId ? host.agent(paneId).sessionId : undefined;
  const created = host.open({
    scope: workspaceId,
    cwd: options.cwd,
    label: options.name,
    env: tabEnvironment({
      options,
      agent,
      prompt,
      appCredential,
      predecessor:
        paneId && predecessorSession
          ? { paneId, sessionId: predecessorSession }
          : undefined,
    }),
  });
  if (isFailure(created)) {
    process.stderr.write(created.stderr);
    return created.exit;
  }
  const ids = created;

  const started = host.type(ids.session, [
    '"$KRN_SUCCESSOR_AGENT"',
    ...flags,
    // Codex has no session-name flag; the Herdr tab label carries the name.
    ...(harness !== 'codex' ? ['-n', '"$KRN_SUCCESSOR_NAME"'] : []),
    '"$KRN_SUCCESSOR_PROMPT"',
  ]);
  if (started) {
    process.stderr.write(started.stderr);
    return started.exit;
  }

  // Herdr names claude and codex itself; an override's binary may be a
  // wrapper, so only Herdr's own kinds are matched by name.
  logLaunch(options.cwd, {
    name: options.name,
    agent: harness,
    via: 'herdr',
    tab_id: ids.tab,
    pane_id: ids.session,
  });

  const expected = harness === 'other' ? undefined : harness;
  const seconds = options.startSeconds ?? START_SECONDS;
  const successor = awaitAgent(
    () => host.agent(ids.session),
    expected,
    seconds,
  );
  if (!successor) {
    process.stderr.write(
      `successor not started: ${host.name} pane ${ids.session} shows no ${expected ? `${expected} ` : ''}agent after ${seconds} s; tab ${ids.tab} kept for inspection\n`,
    );
    return 1;
  }

  process.stdout.write(
    `${announcement(host, ids, successor.agent ?? '', successor.status ?? 'unknown')}\n`,
  );
  // A startup dialog (folder trust, an MCP approval, a login) holds a live
  // successor before its prompt. Failing the launch would invite a duplicate
  // successor, so the handoff stands and the operator learns the pane.
  if (successor.status === 'blocked')
    process.stderr.write(
      `successor waits on a startup dialog: answer it in ${host.name} pane ${ids.session} (tab ${ids.tab})\n`,
    );
  if (paneId) retirePredecessors(options, paneId, host);
  return 0;
}
