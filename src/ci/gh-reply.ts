export type Gh = (args: string[]) => Promise<string>;

const transportExit = 71;

/** Replies gh must print: JSON for `api`, a URL for `pr create`, a name for `repo view`. */
function expectsReply(args: string[]): 'json' | 'text' | undefined {
  if (args[0] === 'api') return 'json';
  if ((args[0] === 'pr' && args[1] === 'create') || args[0] === 'repo')
    return 'text';
  return undefined;
}

function usable(kind: 'json' | 'text', reply: string): boolean {
  if (reply.trim() === '') return false;
  if (kind === 'text') return true;
  try {
    JSON.parse(reply);
    return true;
  } catch {
    return false;
  }
}

/**
 * An empty or truncated gh reply is a transport fault, not a verdict on the
 * Check: ask once more, then exit 71 naming the gh command.
 */
export function withReplyCheck(gh: Gh): Gh {
  return async (args) => {
    const kind = expectsReply(args);
    const first = await gh(args);
    if (kind === undefined || usable(kind, first)) return first;
    // A create is not repeated: gh would refuse a second PR for the branch.
    const second =
      args[0] === 'pr' && args[1] === 'create' ? first : await gh(args);
    if (usable(kind, second)) return second;
    throw Object.assign(
      new Error(
        `gh returned ${second.trim() === '' ? 'an empty' : 'a truncated'} reply to \`gh ${args.join(' ')}\` (transport fault, not a failed Check); rerun krn pr ship`,
      ),
      { exitCode: transportExit },
    );
  };
}
