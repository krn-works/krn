// Routing report: dollars per accepted merge per role and model, counting every assigned task's spend (retries, reviewers, abandoned work).
import {
  collectAllAttempts,
  renderAllAttempts,
} from '../../src/outcome/dollars.ts';
import type { LedgerOptions } from '../../src/outcome/ledger.ts';

const USAGE =
  'usage: node evals/routing/report.ts --all-attempts [--json] [--root <dir>] [--transcripts <dir>] [--repo <owner/name>] [--limit <n>]\n';
const args = process.argv.slice(2);
if (!args.includes('--all-attempts')) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const options: LedgerOptions = { limit: 300 };
const root = value('--root');
if (root !== undefined) options.root = root;
const transcripts = value('--transcripts');
if (transcripts !== undefined) options.transcripts = transcripts;
const repo = value('--repo');
if (repo !== undefined) options.repo = repo;
const limit = value('--limit');
if (limit !== undefined) options.limit = Number(limit);
const report = await collectAllAttempts(options);
process.stdout.write(
  args.includes('--json')
    ? `${JSON.stringify(report)}\n`
    : renderAllAttempts(report),
);
