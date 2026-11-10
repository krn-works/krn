import {
  collectLedger,
  type LedgerOptions,
  renderLedger,
} from '../outcome/ledger.ts';
import {
  collectWindow,
  renderWindow,
  type WindowOptions,
} from '../outcome/window.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export async function ledgerCommand(args: string[]): Promise<void> {
  const options: LedgerOptions = {};
  const window: WindowOptions = {};
  let json = false;
  let windowMode = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--window') {
      const from = args[++i];
      const to = args[++i];
      if (
        !from ||
        !to ||
        [from, to].some((v) => !Number.isFinite(Date.parse(v)))
      )
        throw new CliUsageError('--window needs <fromISO> <toISO>');
      window.from = from;
      window.to = to;
      windowMode = true;
      continue;
    }
    if (
      ![
        '--last',
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
    if (flag === '--last') {
      if (!/^\d+$/.test(value) || Number(value) < 1)
        throw new CliUsageError('Invalid --last');
      window.last = Number(value);
      windowMode = true;
    } else if (flag === '--pr' || flag === '--limit') {
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
  if (windowMode) {
    const report = await collectWindow({ ...window, ...options });
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : renderWindow(report),
    );
    return;
  }
  const report = await collectLedger(options);
  process.stdout.write(
    json ? `${JSON.stringify(report)}\n` : renderLedger(report),
  );
}
