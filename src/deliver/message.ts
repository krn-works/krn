import { redFirst } from '../flow/repository.ts';
import { checked, type Runner } from './transport.ts';

export function mergeMessage(
  title: string,
  parsed: string,
  pr: number,
  task?: string,
): string {
  if (
    !/^[a-z][a-z\d-]*(?:\([^)]+\))?!?: .+/u.test(title) ||
    /[\r\n]/u.test(title)
  )
    throw new Error('PR title must be a Conventional Commit subject');
  const lines = parsed.trim().split(/\r?\n/u);
  const tickets = lines.filter((line) => /^Ticket:/iu.test(line));
  if (tickets.length !== 1 || (task && tickets[0] !== `Ticket: ${task}`))
    throw new Error('head requires exactly one matching Ticket trailer');
  const contracts = lines.filter((line) => /^Change-contract:/iu.test(line));
  if (!contracts.length)
    throw new Error('head requires Change-contract trailers');
  if (
    contracts.some(
      (line) =>
        !/^Change-contract: (?:test\/[^\s:]+:red->green|none \(.+\))$/u.test(
          line,
        ),
    )
  )
    throw new Error(
      'merge contracts must declare red->green or none (<reason>)',
    );
  if (
    new Set(contracts).size !== contracts.length ||
    (contracts.some((line) => /^Change-contract: none /u.test(line)) &&
      contracts.length !== 1)
  )
    throw new Error('duplicate or mixed none Change-contract trailers');
  const authors = lines.filter((line) => /^Co-Authored-By:/iu.test(line));
  const withoutTask = title.replace(/ \(t-[a-z0-9]{7}\)$/u, '');
  const subject = withoutTask.endsWith(` (#${pr})`)
    ? withoutTask
    : `${withoutTask} (#${pr})`;
  // krn ship accepts only this subject shape (GLOBAL scripts/lib/ship/ship.mjs).
  if (
    Number(
      /^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: .+ \(#([1-9]\d*)\)$/u.exec(
        subject,
      )?.[1],
    ) !== pr
  )
    throw new Error('generated subject would be refused by krn ship');
  return `${subject}\n\nDeliver the reviewed change.\n\n${[...tickets, ...contracts, ...authors].join('\n')}\n`;
}

/** A synthetic commit makes existing red-first compare the merge tree to PR base. */
export async function checkMergeContracts(
  root: string,
  base: string,
  head: string,
  message: string,
  runner: Runner,
  evaluate: typeof redFirst = redFirst,
): Promise<void> {
  const git = (args: string[], input?: string) =>
    checked(runner('git', args, root, input));
  const tree = git(['merge-tree', '--write-tree', base, head]).split('\n')[0];
  if (!tree) throw new Error('merge tree unavailable');
  if (/^Change-contract: none /mu.test(message)) {
    const paths = git(['diff', '--name-only', base, tree])
      .split('\n')
      .filter(Boolean);
    if (paths.some((path) => !/^tasks\/[^/]+\.json$/u.test(path)))
      throw new Error('none is allowed only for tracker-only PRs');
    return;
  }
  const commit = git(['commit-tree', tree, '-p', base], message);
  const report = await evaluate(root, base, commit);
  if (
    !report.contracts?.length ||
    report.contracts?.some(
      (contract) =>
        !contract.proven || contract.red?.classification !== 'assertion',
    )
  )
    throw new Error(
      'merge contracts must fail by assertion at PR base and pass on merged tree',
    );
}
