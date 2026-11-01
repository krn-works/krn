import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractDeclarations } from '../src/flow/repository.ts';

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

// Review's own parser judges every branch commit, so preflight refuses what review would.
export function checkBranchContracts(base, head, cwd = process.cwd()) {
  const { declarations, errors } = contractDeclarations(cwd, base, head);
  if (errors.length)
    throw new Error(errors.map((error) => error.summary).join('\n'));
  return declarations;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    checkHeadTrailers(git(['log', '-1', '--format=%B']));
    checkBranchContracts(
      git(['merge-base', 'HEAD', 'refs/remotes/origin/main']),
      git(['rev-parse', 'HEAD']),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
