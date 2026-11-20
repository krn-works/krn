/** One `Ticket:` or `Refs:` line of a message with the task ids its comma or space list names. */
export type TicketLine = { key: 'Ticket' | 'Refs'; ids: string[] };

const trailerLine = /^[A-Za-z][\w-]*:[ \t]+\S/u;
const ticketLine = /^(ticket|refs):[ \t]*(.*)$/iu;

/** Joins each indented continuation line to the line above it, as git unfolds a folded trailer. */
function unfold(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const last = out.length - 1;
    if (last >= 0 && /^[ \t]+\S/u.test(line))
      out[last] = `${out[last]} ${line.trim()}`;
    else out.push(line.trimEnd());
  }
  return out;
}

function ticketLinesOf(lines: string[]): TicketLine[] {
  const found: TicketLine[] = [];
  for (const line of unfold(lines)) {
    const match = ticketLine.exec(line);
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
 * The `Ticket:`/`Refs:` lines of a commit or pull request message, in order. A key starts in
 * column 0 (an indented example in prose is not a trailer) and an indented line continues the one
 * above it. It follows git's trailer block (the trailing paragraphs made only of `Key: value`
 * lines, so a Co-Authored-By paragraph below a Ticket paragraph still counts) and, when that
 * block names none, falls back to any such line of the message.
 */
export function parseTickets(message: string): TicketLine[] {
  const text = message.replace(/\r\n?/gu, '\n');
  const block: string[] = [];
  for (const paragraph of text
    .trim()
    .split(/\n[ \t]*\n/u)
    .reverse()) {
    const lines = unfold(paragraph.split('\n'));
    if (!lines.every((line) => trailerLine.test(line))) break;
    block.unshift(...paragraph.split('\n'));
  }
  const inBlock = ticketLinesOf(block);
  return inBlock.length > 0 ? inBlock : ticketLinesOf(text.split('\n'));
}
