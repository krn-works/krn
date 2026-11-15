// `krn repo contract`: print the repo contract (krn.json merged over detection) as JSON.
import { resolve } from 'node:path';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ContractError, resolveContract } from '../repo/contract.ts';
import { FormatError } from '../repo/formats.ts';
import {
  crawlSite,
  diffGoldenMaster,
  GoldenMasterError,
  goldenVerdict,
  writeGoldenMaster,
} from '../repo/golden-master.ts';

const GOLDEN_USAGE =
  'krn repo golden record|check --url BASE_URL [--declare PATH]... [--root DIR]  HTTP golden master of the sitemap pages';

async function goldenCommand(verb: string, rest: string[]): Promise<void> {
  let root = process.cwd();
  let url: string | undefined;
  const declared: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const need = () =>
      flagValue(rest, i++, () => new CliUsageError(`${flag} needs a value`));
    if (flag === '--root') root = resolve(need());
    else if (flag === '--url') url = need();
    else if (flag === '--declare') declared.push(need());
    else throw new CliUsageError(`krn repo golden: unknown flag ${flag}`);
  }
  if (url === undefined || (verb !== 'record' && verb !== 'check'))
    throw new CliUsageError(GOLDEN_USAGE);
  try {
    const pages = await crawlSite(root, url);
    if (verb === 'record') {
      const count = writeGoldenMaster(root, pages);
      process.stdout.write(`golden recorded ${count} pages\n`);
      return;
    }
    const verdict = goldenVerdict(diffGoldenMaster(root, pages), declared);
    for (const line of verdict.lines) process.stdout.write(`${line}\n`);
    process.stdout.write(
      verdict.ok ? `golden ok: ${pages.size} pages\n` : 'golden FAIL\n',
    );
    if (!verdict.ok) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof GoldenMasterError)) throw error;
    process.stderr.write(`krn repo golden: ${error.message}\n`);
    process.exitCode = 65;
  }
}

export function repoCommand(args: string[]): Promise<void> | void {
  const [verb, ...rest] = args;
  if (verb === 'golden') return goldenCommand(rest[0] ?? '', rest.slice(1));
  if (verb !== 'contract')
    throw new CliUsageError(
      `krn repo contract [--root DIR]  print the repo contract as JSON\n${GOLDEN_USAGE}`,
    );
  let root = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--root')
      root = resolve(
        flagValue(rest, i++, () => new CliUsageError('--root needs DIR')),
      );
    else throw new CliUsageError(`krn repo contract: unknown flag ${flag}`);
  }
  try {
    const resolved = resolveContract(root);
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof ContractError || error instanceof FormatError))
      throw error;
    process.stderr.write(`krn repo contract: ${error.message}\n`);
    process.exitCode = error instanceof FormatError ? error.exitCode : 65;
  }
}
