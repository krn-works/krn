import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shipCommand } from '../../src/ci/ship.ts';
import { REQUIRED_CHECK_APP_ID } from '../../src/repo/ci-admission-contract.ts';
import type { CheckFact } from '../../src/repo/required-check.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const title = 'feat(ci): ship with configured branch checks (t-1234567)';
const body = '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n';
/** Runs a ship against a ruleset, the head's check-runs and run list; reports the merge request and the exit code. */
export async function shipWith(
  t: { after: (fn: () => void) => void },
  options: {
    required: { context: string; integration_id?: number | null }[];
    checks: CheckFact[];
    /** The run list answer: rows, or the error `gh run list` fails with. */
    runs?: object[] | Error;
  },
) {
  const scratch = mkdtempSync(join(tmpdir(), 'krn-identity-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const main = join(scratch, 'main');
  const wt = join(main, '.krn', 'worktrees', 'feat-x');
  let time = 0;
  let mergeRequested = false;
  const gh = async (a: string[]): Promise<string> => {
    if (a[0] === 'api' && a[1]?.includes('/rules/branches/'))
      return JSON.stringify([
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: options.required },
        },
      ]);
    if (a[0] === 'api' && a[1]?.includes('/branches/'))
      return JSON.stringify({ protection: {} });
    if (a[0] === 'api' && a[1]?.includes('/check-runs'))
      return JSON.stringify(options.checks);
    if (a[0] === 'run' && a[1] === 'list') {
      if (options.runs instanceof Error) throw options.runs;
      return JSON.stringify(options.runs);
    }
    if (a[0] === 'pr' && a[1] === 'list') return '';
    if (a[0] === 'pr' && a[1] === 'create')
      return 'https://github.com/o/r/pull/7\n';
    if (a[0] === 'pr' && a[1] === 'merge') {
      mergeRequested = true;
      return '';
    }
    if (a[0] === 'pr' && a[1] === 'view')
      return JSON.stringify({
        state: mergeRequested ? 'MERGED' : 'OPEN',
        headRefOid: head,
        mergeable: 'MERGEABLE',
        mergeCommit: mergeRequested ? { oid: 'c'.repeat(40) } : null,
        statusCheckRollup: [],
      });
    throw new Error(`unexpected gh ${a.join(' ')}`);
  };
  const run = (_cmd: string, args: string[]) => {
    const line = args.join(' ');
    const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (line === 'rev-parse --abbrev-ref HEAD') return out('feat-x\n');
    if (line === 'rev-parse --show-toplevel') return out(`${wt}\n`);
    if (args.includes('--git-common-dir')) return out(`${main}/.git\n`);
    if (line === 'rev-parse HEAD') return out(`${head}\n`);
    if (line === 'rev-parse origin/main') return out(`${base}\n`);
    if (args[0] === 'diff') return out('src/x.ts\n');
    return out('');
  };
  const result = await shipCommand(
    ['--title', title, '--body-file', 'body.md', '--repo', 'o/r'],
    {
      cwd: wt,
      run,
      gh,
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      readBody: () => body,
    },
  ).then(
    () => ({ exitCode: 0 }),
    (error: unknown) => ({
      exitCode: (error as { exitCode?: number }).exitCode,
    }),
  );
  return { ...result, mergeRequested };
}

export const pinned = {
  context: 'ci / Check',
  integration_id: REQUIRED_CHECK_APP_ID,
};
export const product: CheckFact = {
  id: 10,
  name: pinned.context,
  appId: REQUIRED_CHECK_APP_ID,
  startedAt: '2026-11-20T08:00:00Z',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://github.com/o/r/actions/runs/9/job/1',
};
