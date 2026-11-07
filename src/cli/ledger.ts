import {
  collectLedger,
  type LedgerOptions,
  renderLedger,
} from '../outcome/ledger.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export async function ledgerCommand(args: string[]): Promise<void> {
  const options: LedgerOptions = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (
      ![
        '--since',
        '--pr',
        '--limit',
        '--repo',
        '--root',
        '--transcripts',
      ].includes(flag ?? '')
    )
      throw new CliUsageError(`Unknown ledger flag: ${flag}`);
    const value = flagValue(
      args,
      i++,
      () => new CliUsageError(`Missing value for ${flag}`),
    );
    if (flag === '--pr' || flag === '--limit') {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw new CliUsageError(`Invalid ${flag}`);
      if (flag === '--pr') options.pr = Number(value);
      else options.limit = Number(value);
    } else if (flag === '--since') {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new CliUsageError('Invalid --since date');
      options.since = value;
    } else if (flag === '--repo') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value))
        throw new CliUsageError('Invalid --repo');
      options.repo = value;
    } else if (flag === '--root') options.root = value;
    else options.transcripts = value;
  }
  const report = await collectLedger(options);
  process.stdout.write(
    json ? `${JSON.stringify(report)}\n` : renderLedger(report),
  );
}
