// `krn repo contract`: print the repo contract (krn.json merged over detection) as JSON.
// `krn repo settings`: report (and with --apply set) the merge settings of the convention.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ciGateProblem } from '../adopt/workflow-gates.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ContractError, resolveContract } from '../repo/contract.ts';
import { FormatError } from '../repo/formats.ts';
import { rootGhEnv } from '../repo/gh.ts';
import {
  crawlSite,
  diffGoldenMaster,
  GoldenMasterError,
  goldenVerdict,
  writeGoldenMaster,
} from '../repo/golden-master.ts';
import {
  applyArgs,
  MergeSettingsError,
  mergeSettingGaps,
} from '../repo/merge-settings.ts';

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

export const SETTINGS_USAGE =
  'krn repo settings [--repo OWNER/NAME] [--root DIR] [--apply]  report the merge settings that differ from the convention (squash only, squash title PR_TITLE, body PR_BODY, delete branch on merge, auto-merge allowed) through gh; exit 1 on a gap; --apply sets them with one gh api PATCH';

function settingsCommand(rest: string[]): void {
  let root = process.cwd();
  let repo: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const need = () =>
      flagValue(rest, i++, () => new CliUsageError(`${flag} needs a value`));
    if (flag === '--root') root = resolve(need());
    else if (flag === '--repo') repo = need();
    else if (flag === '--apply') apply = true;
    else throw new CliUsageError(`${SETTINGS_USAGE}\nunknown flag ${flag}`);
  }
  const path = `repos/${repo ?? '{owner}/{repo}'}`;
  const env =
    repo === undefined
      ? rootGhEnv(root)
      : { ...process.env, KRN_APP_REPOSITORY: repo };
  const gh = (args: string[]) =>
    spawnSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
  const read = gh(['api', path]);
  if (read.status !== 0) {
    process.stderr.write(
      `krn repo settings: gh api ${path} failed: ${(read.stderr ?? '').trim()}\n`,
    );
    process.exitCode = 69;
    return;
  }
  let gaps: ReturnType<typeof mergeSettingGaps>;
  try {
    gaps = mergeSettingGaps(read.stdout);
  } catch (error) {
    if (!(error instanceof MergeSettingsError)) throw error;
    process.stderr.write(`krn repo settings: ${error.message}\n`);
    process.exitCode = 65;
    return;
  }
  for (const gap of gaps)
    process.stdout.write(
      `gap ${gap.key}: ${JSON.stringify(gap.have ?? null)}, want ${JSON.stringify(gap.want)}\n`,
    );
  if (gaps.length === 0) {
    process.stdout.write('PASS repo settings\n');
    return;
  }
  if (!apply) {
    process.stdout.write(
      `FAIL repo settings: ${gaps.length} gap${gaps.length === 1 ? '' : 's'}; --apply sets them\n`,
    );
    process.exitCode = 1;
    return;
  }
  const patch = gh(applyArgs(path, gaps));
  if (patch.status !== 0) {
    process.stderr.write(
      `krn repo settings: gh api -X PATCH ${path} failed: ${(patch.stderr ?? '').trim()}\n`,
    );
    process.exitCode = 69;
    return;
  }
  const left = mergeSettingGaps(patch.stdout);
  for (const gap of left)
    process.stdout.write(
      `still ${gap.key}: ${JSON.stringify(gap.have ?? null)}, want ${JSON.stringify(gap.want)}\n`,
    );
  process.stdout.write(
    left.length === 0
      ? `applied ${gaps.length} setting${gaps.length === 1 ? '' : 's'}\nPASS repo settings\n`
      : `FAIL repo settings: ${left.length} gap${left.length === 1 ? '' : 's'} after --apply\n`,
  );
  if (left.length > 0) process.exitCode = 1;
}

export function repoCommand(args: string[]): Promise<void> | void {
  const [verb, ...rest] = args;
  if (verb === 'golden') return goldenCommand(rest[0] ?? '', rest.slice(1));
  if (verb === 'settings') return settingsCommand(rest);
  if (verb !== 'contract' && verb !== 'ci-gates')
    throw new CliUsageError(
      `krn repo contract [--root DIR]  print the repo contract as JSON\nkrn repo ci-gates [--root DIR]  exit 1 when no pull request workflow runs every contract gate\n${SETTINGS_USAGE}\n${GOLDEN_USAGE}`,
    );
  let root = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--root')
      root = resolve(
        flagValue(rest, i++, () => new CliUsageError('--root needs DIR')),
      );
    else throw new CliUsageError(`krn repo ${verb}: unknown flag ${flag}`);
  }
  if (verb === 'ci-gates') {
    const problem = ciGateProblem(root);
    if (problem !== undefined) {
      process.stderr.write(`${problem}\n`);
      process.exitCode = 1;
    }
    return;
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
