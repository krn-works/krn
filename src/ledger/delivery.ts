import type { Result } from '../core/index.ts';
import type { Contract } from './index.ts';

export type DeliveryTrailers = Readonly<{
  ticket?: string;
  r1Task?: string;
}>;

const ticketPattern = /^[A-Z][A-Z0-9]*-[1-9]\d*$/u;
const r1TaskLinePattern =
  /^R1-task:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:[ \t]+\([^\r\n]*\))?[ \t]*$/u;

export function parseR1TaskLine(line: string): string | undefined {
  return r1TaskLinePattern.exec(line)?.[1];
}

export function deliveryTrailers(
  contract: Pick<Contract, 'identifier' | 'description'>,
): Result<DeliveryTrailers, string> {
  const taskLines = contract.description
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('R1-task:'));
  if (taskLines.length > 1)
    return { ok: false, error: 'duplicate R1-task lines' };

  const trailers: { ticket?: string; r1Task?: string } = {};
  if (
    typeof contract.identifier === 'string' &&
    ticketPattern.test(contract.identifier)
  )
    trailers.ticket = contract.identifier;

  if (taskLines.length === 1) {
    const r1Task = parseR1TaskLine(taskLines[0] ?? '');
    if (r1Task === undefined)
      return { ok: false, error: 'malformed R1-task line' };
    trailers.r1Task = r1Task;
  }

  return { ok: true, value: trailers };
}
