import { spawnSync } from 'node:child_process';

/** One `Ticket:` or `Refs:` trailer of a message with the task ids its comma or space list names. */
export type TicketLine = { key: 'Ticket' | 'Refs'; ids: string[] };

/** More trailing trailer paragraphs than this are never one commit's footer. */
const MAX_TRAILER_PARAGRAPHS = 8;

/** The trailers git itself finds in the last paragraph of `message`, unfolded, one per line. */
function trailersOf(message: string): string[] {
  const parsed = spawnSync(
    'git',
    ['interpret-trailers', '--only-trailers', '--only-input', '--unfold'],
    {
      input: message,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
  if (parsed.status !== 0) return [];
  return parsed.stdout.split('\n').filter((line) => line.trim() !== '');
}

/**
 * The `Ticket:`/`Refs:` trailers of a commit or pull request message.
 * Git decides what a trailer is (`git interpret-trailers --parse`: key case, a space before the
 * colon, folded values, prose, fenced and indented examples); a Co-Authored-By paragraph below
 * the Ticket paragraph is peeled off so the paragraph above it is read too. A ticket outside a
 * trailer block is not a ticket. Values split on commas and spaces.
 */
export function parseTickets(message: string): TicketLine[] {
  let text = message.replace(/\r\n?/gu, '\n').trimEnd();
  const found: TicketLine[] = [];
  for (let paragraph = 0; paragraph < MAX_TRAILER_PARAGRAPHS; paragraph += 1) {
    const trailers = trailersOf(`${text}\n`);
    if (trailers.length === 0) break;
    const lines: TicketLine[] = [];
    for (const trailer of trailers) {
      const match = /^(ticket|refs)\s*:\s*(.*)$/iu.exec(trailer);
      if (match === null) continue;
      const ids = (match[2] ?? '').split(/[\s,]+/u).filter((id) => id !== '');
      if (ids.length > 0)
        lines.push({
          key: (match[1] ?? '').toLowerCase() === 'ticket' ? 'Ticket' : 'Refs',
          ids,
        });
    }
    found.unshift(...lines);
    const cut = text.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/u);
    if (cut < 0) break;
    text = text.slice(0, cut).trimEnd();
  }
  return found;
}
