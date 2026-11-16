// The edit-standards route's light front: edit-standards.ts pulls in the brain (about 250 ms of module
// load), so a Bash call that names no file never loads it.
import { hookStdin } from '../harness/claude.ts';

/** Path-like words of a shell command: a name with an extension, optionally behind directories. */
export const PATH_WORD = /[\w@.+-]*(?:\/[\w@.+-]+)*\.[A-Za-z0-9]+/gu;

/** True when the payload can name a file: any file tool, or a Bash command with a path-like word. */
export function mayNameFile(payload: unknown): boolean {
  const call = payload as {
    tool_name?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  if (call?.tool_name !== 'Bash') return true;
  const command = call.tool_input?.command;
  return typeof command === 'string' && new RegExp(PATH_WORD).test(command);
}

export async function main(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
  } catch {
    return;
  }
  if (mayNameFile(payload)) (await import('./edit-standards.ts')).main();
}
