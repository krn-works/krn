// FR-40 arm material for one convention task (ADR 0014 D32): `node evals/fr40/packets.ts`
// prints it. The experiment's material, not the product's: `krn brain` is retired.
// Shadow packets are agent state under .krn/; nothing here injects them into a brief or prompt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Arm,
  BUDGET,
  brainPacket,
  type Packet,
  parseRecords,
  staticPacket,
} from '../../src/brain/packet.ts';
import { BASE_DATE, generate } from './tasks.ts';

export { BUDGET };

export const usage =
  'usage: node evals/fr40/packets.ts packet <fr40-task-id> [--arm brain|static] [--write] [--json]';

class UsageError extends Error {
  readonly exitCode = 64;
}

const material = new URL('./', import.meta.url);

export function fr40Packet(id: string, arm: Arm): Packet {
  const task = generate().find((candidate) => candidate.id === id);
  if (task === undefined)
    throw new UsageError(`fr40 packet: unknown FR-40 task ${id}`);
  if (arm === 'static')
    return staticPacket({
      task: id,
      standards: readFileSync(new URL('standards.md', material), 'utf8'),
      asOf: BASE_DATE,
      budget: BUDGET,
    });
  return brainPacket({
    task: id,
    query: task.prompt,
    records: parseRecords(
      JSON.parse(readFileSync(new URL('records.json', material), 'utf8')),
    ),
    asOf: BASE_DATE,
    budget: BUDGET,
  });
}

function parse(args: readonly string[]): {
  id: string;
  arm: Arm;
  write: boolean;
  json: boolean;
} {
  const [verb, id, ...rest] = args;
  if (verb !== 'packet' || id === undefined || id.startsWith('-'))
    throw new UsageError(usage);
  let arm: Arm = 'brain';
  let write = false;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--write') write = true;
    else if (flag === '--json') json = true;
    else if (flag === '--arm') {
      const value = rest[++i];
      if (value !== 'brain' && value !== 'static') throw new UsageError(usage);
      arm = value;
    } else throw new UsageError(usage);
  }
  return { id, arm, write, json };
}

export async function brainCommand(args: string[]): Promise<void> {
  const options = parse(args);
  const packet = fr40Packet(options.id, options.arm);
  let path: string | undefined;
  if (options.write) {
    const dir = join(process.cwd(), '.krn', 'runs', 'fr40', 'packets');
    mkdirSync(dir, { recursive: true });
    path = join(dir, `${packet.task}.${packet.arm}.json`);
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${[
      `task=${packet.task}`,
      `arm=${packet.arm}`,
      `as-of=${packet.asOf}`,
      `tokens=${packet.tokens}/${packet.budget}`,
      `records=${packet.records.join(',') || '-'}`,
      `sha256=${packet.sha256}`,
      ...(path === undefined ? [] : [`written=${path}`]),
    ].join('\n')}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  brainCommand(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = error instanceof UsageError ? error.exitCode : 1;
  });
