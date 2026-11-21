import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';
import type { CheckFact } from '../../src/repo/required-check.ts';
import { capture } from '../receivers/capture.ts';

const head = '7a908ffa0dc0db23ea70d797096430ebe992eb2e';
const base = 'b'.repeat(40);
const title = 'feat(ci): check both required aggregates (t-1234567)';
const body = '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n';
const ours = 44781928074;
const other = 44785000000;
const url = (run: number, job: number) =>
  `https://github.com/krn-works/krn/actions/runs/${run}/job/${job}`;
const row = (over: CheckFact): CheckFact => ({
  appId: 15368,
  startedAt: '2026-11-20T08:00:00Z',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  ...over,
});

/** `gh run list --commit <head> --json workflowDatabaseId,databaseId,status,headSha`, real output of PR #1551's head. */
const captured = () =>
  JSON.parse(
    capture('fixtures/gh', 'run-list-1551-reruns').streams.stdout?.toString(
      'utf8',
    ) ?? '',
  ) as {
    databaseId: number;
    workflowDatabaseId: number;
    status: string;
    headSha: string;
  }[];

/** The run list as the old query read it: a display name shared by every workflow called `CI`. */
const named = (runs: object[]) =>
  runs.map((run) => ({ ...run, workflowName: 'CI' }));

/** Runs a ship against a ruleset, the head's check-runs and run list; reports the merge request and the exit code. */
async function shipWith(
  t: { after: (fn: () => void) => void },
  options: {
    required: { context: string; integration_id: number | null }[];
    checks: CheckFact[];
    runs: object[];
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
    if (a[0] === 'run' && a[1] === 'list') return JSON.stringify(options.runs);
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

const pinned = [{ context: 'ci / Check', integration_id: 15368 }];
const failedCheck = row({
  id: 10,
  name: 'ci / Check',
  conclusion: 'FAILURE',
  detailsUrl: url(ours, 1),
});

test('an unfinished job of the same name in another workflow does not hide a failed required aggregate', async (t) => {
  const result = await shipWith(t, {
    required: pinned,
    checks: [
      failedCheck,
      row({ id: 8, name: 'Lint', detailsUrl: url(ours, 8) }),
      row({
        id: 11,
        name: 'Lint',
        status: 'IN_PROGRESS',
        conclusion: '',
        detailsUrl: url(other, 11),
      }),
    ],
    runs: named([
      ...captured().filter((run) => run.databaseId === ours),
      {
        ...captured()[0],
        databaseId: other,
        workflowDatabaseId: 1,
        status: 'in_progress',
      },
    ]),
  });
  assert.equal(result.exitCode, 74);
  assert.equal(result.mergeRequested, false);
});

test('a queued run of another workflow with the same display name does not hide a failed required aggregate', async (t) => {
  const result = await shipWith(t, {
    required: pinned,
    checks: [failedCheck],
    runs: named([
      ...captured().filter((run) => run.databaseId === ours),
      {
        ...captured()[0],
        databaseId: other,
        workflowDatabaseId: 1,
        status: 'queued',
      },
    ]),
  });
  assert.equal(result.exitCode, 74);
  assert.equal(result.mergeRequested, false);
});

test('a queued run of the same workflow on another head does not hide a failed required aggregate', async (t) => {
  const result = await shipWith(t, {
    required: pinned,
    checks: [failedCheck],
    runs: named([
      ...captured().filter((run) => run.databaseId === ours),
      {
        ...captured()[0],
        databaseId: other,
        headSha: 'd'.repeat(40),
        status: 'queued',
      },
    ]),
  });
  assert.equal(result.exitCode, 74);
});

test('ship merges after both required aggregates succeeded on the head', async (t) => {
  const result = await shipWith(t, {
    required: [...pinned, { context: 'Check', integration_id: null }],
    checks: [
      row({ id: 10, name: 'ci / Check', detailsUrl: url(9, 1) }),
      row({ id: 11, name: 'Check', detailsUrl: url(10, 2) }),
    ],
    runs: [],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.mergeRequested, true);
});
