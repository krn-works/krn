import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkHeadTrailers(message, cwd = process.cwd()) {
  const parsed = spawnSync('git', ['interpret-trailers', '--parse'], {
    cwd,
    input: message,
    encoding: 'utf8',
  });
  if (parsed.status !== 0) throw new Error(parsed.stderr);
  const lines = parsed.stdout.trim().split(/\r?\n/u);
  const tickets = lines.filter((line) => /^Ticket:/iu.test(line));
  const declared = message.match(/^Change-contract:.*$/gimu) ?? [];
  const contracts = lines.filter((line) => /^Change-contract:/iu.test(line));
  const final =
    message
      .trimEnd()
      .split(/\r?\n\s*\r?\n/u)
      .at(-1) ?? '';
  if (
    tickets.length !== 1 ||
    !/^Ticket:\s*\S+\s*$/iu.test(tickets[0]) ||
    !final.split(/\r?\n/u).includes(tickets[0]) ||
    declared.length !== contracts.length ||
    declared.some((line) => !final.split(/\r?\n/u).includes(line))
  ) {
    throw new Error(
      'HEAD requires exactly one Ticket and every Change-contract in the same final trailer paragraph',
    );
  }
  return lines;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const head = spawnSync('git', ['log', '-1', '--format=%B'], {
      encoding: 'utf8',
    });
    if (head.status !== 0) throw new Error(head.stderr);
    checkHeadTrailers(head.stdout);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
