import { planScoredShare, predictionScorecard } from '../brain/exposures.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import {
  collectAdvisorTrial,
  renderAdvisorTrial,
} from '../outcome/advisor-trial.ts';
import {
  BANDS,
  type BandName,
  collectContextGate,
  renderContextGate,
} from '../outcome/context-gate.ts';
import {
  collectFirstPushGreen,
  renderFirstPushGreen,
} from '../outcome/first-push-green.ts';
import {
  collectLedger,
  type LedgerOptions,
  renderLedger,
} from '../outcome/ledger.ts';
import {
  CEILING_WINDOW_PRS,
  collectWindow,
  nonDeliveryCeiling,
  renderWindow,
  type WindowOptions,
} from '../outcome/window.ts';

export async function ledgerCommand(args: string[]): Promise<void> {
  const options: LedgerOptions = {};
  const window: WindowOptions = {};
  let json = false;
  let windowMode = false;
  let checkCeiling = false;
  let predictions = false;
  let share = false;
  let firstPushGreen = false;
  let contextGate = false;
  let advisorTrial = false;
  let band: BandName | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--predictions') {
      predictions = true;
      continue;
    }
    if (flag === '--share') {
      share = true;
      continue;
    }
    if (flag === '--advisor-trial') {
      advisorTrial = true;
      continue;
    }
    if (flag === '--first-push-green') {
      firstPushGreen = true;
      continue;
    }
    if (flag === '--context-gate') {
      contextGate = true;
      continue;
    }
    if (flag === '--check-ceiling') {
      checkCeiling = true;
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
        '--band',
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
    if (flag === '--band') {
      const named = BANDS.find((b) => b.name === value);
      if (!named) throw new CliUsageError('Invalid --band');
      band = named.name;
    } else if (flag === '--last') {
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
  if (advisorTrial) {
    const report = await collectAdvisorTrial({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
    });
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : renderAdvisorTrial(report),
    );
    return;
  }
  if (contextGate) {
    const report = await collectContextGate({
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.transcripts === undefined
        ? {}
        : { transcripts: options.transcripts }),
      ...(band === undefined ? {} : { band }),
    });
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : renderContextGate(report),
    );
    return;
  }
  if (firstPushGreen) {
    const report = await collectFirstPushGreen({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
    });
    if (share) {
      process.stdout.write(`${(report.share ?? 0).toFixed(3)}\n`);
      return;
    }
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : renderFirstPushGreen(report),
    );
    return;
  }
  if (predictions && share) {
    process.stdout.write(
      `${planScoredShare(options.root ?? process.cwd()).toFixed(3)}\n`,
    );
    return;
  }
  if (predictions) {
    process.stdout.write(predictionScorecard(options.root ?? process.cwd()));
    return;
  }
  if (checkCeiling && !windowMode) {
    window.last = CEILING_WINDOW_PRS;
    windowMode = true;
  }
  if (windowMode) {
    const report = await collectWindow({ ...window, ...options });
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : renderWindow(report),
    );
    if (checkCeiling) {
      const c = nonDeliveryCeiling(report);
      if (!c) {
        process.stderr.write('ceiling: no priced window, cannot check\n');
        process.exitCode = 1;
      } else if (c.over) {
        process.stderr.write(
          `ceiling: non-delivery ${(c.share * 100).toFixed(0)}% is above ${(c.ceiling * 100).toFixed(0)}%; do not fan out research\n`,
        );
        process.exitCode = 1;
      }
    }
    return;
  }
  const report = await collectLedger(options);
  process.stdout.write(
    json ? `${JSON.stringify(report)}\n` : renderLedger(report),
  );
}
