import {
  bindAgent,
  laneOfSession,
  mainOfSession,
  readManifest,
} from '../lane/manifest.ts';
import { programName, readShell, resolveCommand } from './shell-reader.ts';

/**
 * The lane id of a `krn lane start ... --lane <laneId>` command the shell reader recognises, else undefined.
 * A word the shell still expands names no id, so such a command leaves the worker unbound.
 */
export function laneStartId(command: string): string | undefined {
  for (const step of readShell(command)) {
    if (step.kind !== 'command') continue;
    const argv = resolveCommand(step.command.words)?.argv;
    if (argv === undefined || programName(argv[0]) !== 'krn') continue;
    if (argv[1]?.text !== 'lane' || argv[2]?.text !== 'start') continue;
    for (let at = 3; at < argv.length; at++) {
      const word = argv[at];
      const text = word?.text ?? '';
      const next = argv[at + 1];
      if (text === '--lane' && next !== undefined && !next.expands)
        return next.text;
      if (text.startsWith('--lane=') && !word?.expands)
        return text.slice('--lane='.length) || undefined;
    }
  }
  return undefined;
}

/**
 * Binds the calling `krn-lane` subagent to the lane its `krn lane start --lane <laneId>` names (ADR 0029
 * decision 2): the PreToolUse payload carries `agent_id`, so the id is appended to the manifest before the
 * start command runs. A command that names no reserved or started lane binds nothing.
 */
export function bindOnLaneStart(payload: unknown, projectDir: string): void {
  const fields = payload as {
    tool_name?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  if (fields?.tool_name !== 'Bash') return;
  const command = fields.tool_input?.command;
  if (typeof command !== 'string') return;
  const laneId = laneStartId(command);
  if (laneId === undefined) return;
  const caller = payload as { agent_type?: unknown; agent_id?: unknown };
  if (caller.agent_type !== 'krn-lane' || typeof caller.agent_id !== 'string')
    return;
  const main = mainOfSession(projectDir);
  const manifest = readManifest(main, laneId);
  if (
    manifest === undefined ||
    !['reserved', 'started'].includes(manifest.phase.kind)
  )
    return;
  // An agent bound to another live lane keeps it: the first start wins.
  if (laneOfSession(payload, {}, projectDir).kind === 'lane') return;
  bindAgent(main, laneId, caller.agent_id);
}
