import { transcriptLines } from './transcripts.ts';

/** A transcript cut after one line, rewritten as a session of its own that `claude --resume` can continue. */
export type Prefix = {
  /** The kept lines: every non-sidechain line with a uuid, up to and including the cut line. */
  lines: string[];
  /** Kept user and assistant message lines. */
  messages: number;
  bytes: number;
  /** Uuid of the line the cut ended on, when that line carries one. */
  cutUuid: string | undefined;
  /** Role of the cut line's message: a replay must end on a user line. */
  cutRole: string | undefined;
  /** Parents the kept lines name that no kept line holds (the first line's parent is expected). */
  danglingParents: number;
};

/** The Claude project directory name of a working directory. */
export const projectSlug = (cwd: string): string =>
  cwd.replaceAll(/[^A-Za-z0-9]/gu, '-');

/** Keep lines 0..cut (0-based, inclusive) that belong to the main conversation, under `sessionId` when given. */
export function prefixOf(
  all: readonly string[],
  cut: number,
  sessionId?: string,
): Prefix {
  const lines: string[] = [];
  const uuids = new Set<string>();
  const parents: string[] = [];
  let messages = 0;
  let cutUuid: string | undefined;
  let cutRole: string | undefined;
  for (let i = 0; i <= cut && i < all.length; i++) {
    const raw = all[i];
    if (!raw) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.uuid !== 'string' || o.isSidechain === true) continue;
    if (sessionId !== undefined && 'sessionId' in o) o.sessionId = sessionId;
    const message = o.message as { role?: string } | undefined;
    if (o.type === 'user' || o.type === 'assistant') messages++;
    uuids.add(o.uuid);
    if (typeof o.parentUuid === 'string') parents.push(o.parentUuid);
    lines.push(sessionId === undefined ? raw : JSON.stringify(o));
    if (i === cut) {
      cutUuid = o.uuid;
      cutRole = message?.role;
    }
  }
  return {
    lines,
    messages,
    bytes: lines.reduce((n, l) => n + l.length + 1, 0),
    cutUuid,
    cutRole,
    danglingParents: parents.filter((p) => !uuids.has(p)).length,
  };
}

/** Read a transcript file and cut it; the one place a replay touches a recorded transcript. */
export async function readPrefix(
  path: string,
  cut: number,
  sessionId?: string,
): Promise<Prefix> {
  const all: string[] = [];
  let i = 0;
  for await (const line of transcriptLines(path)) {
    all.push(line);
    if (++i > cut) break;
  }
  return prefixOf(all, cut, sessionId);
}
