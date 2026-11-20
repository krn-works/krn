/** One `Ticket:` or `Refs:` line of a message with the task ids its comma or space list names. */
export type TicketLine = { key: 'Ticket' | 'Refs'; ids: string[] };

const trailerLine = /^[A-Za-z][\w-]*:[ \t]+\S/u;
const ticketLine = /^(ticket|refs):[ \t]*(.*)$/iu;

function ticketLinesOf(lines: string[]): TicketLine[] {
  const found: TicketLine[] = [];
  for (const line of lines) {
    const match = ticketLine.exec(line.trim());
    if (match === null) continue;
    const ids = (match[2] ?? '').split(/[\s,]+/u).filter((id) => id !== '');
    if (ids.length > 0)
      found.push({
        key: (match[1] ?? '').toLowerCase() === 'ticket' ? 'Ticket' : 'Refs',
        ids,
      });
  }
  return found;
}

/**
 * The `Ticket:`/`Refs:` lines of a commit or pull request message, in order. It follows git's
 * trailer block (the trailing paragraphs made only of `Key: value` lines, so a Co-Authored-By
 * paragraph below a Ticket paragraph still counts) and, when that block names none, falls back
 * to any such line of the message.
 */
export function parseTickets(message: string): TicketLine[] {
  const paragraphs = message
    .replace(/\r\n?/gu, '\n')
    .trim()
    .split(/\n[ \t]*\n/u);
  const block: string[] = [];
  for (const paragraph of paragraphs.reverse()) {
    const lines = paragraph.split('\n').map((line) => line.trim());
    if (!lines.every((line) => trailerLine.test(line))) break;
    block.unshift(...lines);
  }
  const inBlock = ticketLinesOf(block);
  if (inBlock.length > 0) return inBlock;
  return ticketLinesOf(message.replace(/\r\n?/gu, '\n').split('\n'));
}
