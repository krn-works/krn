import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const title = 'feat(ci): check both required aggregates (t-1234567)';
const body = '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n';

test('ship does not request merge when the unrestricted required Check was skipped', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'krn-multi-'));
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
          parameters: {
            required_status_checks: [
              { context: 'ci / Check', integration_id: 15368 },
              { context: 'Check', integration_id: null },
            ],
          },
        },
      ]);
    if (a[0] === 'api' && a[1]?.includes('/branches/'))
      return JSON.stringify({ protection: {} });
    if (a[0] === 'api' && a[1]?.includes('/check-runs'))
      return JSON.stringify([
        {
          id: 10,
          name: 'ci / Check',
          appId: 15368,
          startedAt: '2026-11-20T08:00:00Z',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/o/r/actions/runs/9/job/1',
        },
        {
          id: 11,
          name: 'Check',
          appId: 15368,
          startedAt: '2026-11-20T08:00:00Z',
          status: 'COMPLETED',
          conclusion: 'SKIPPED',
          detailsUrl: 'https://github.com/o/r/actions/runs/10/job/2',
        },
      ]);
    if (a[0] === 'run' && a[1] === 'list')
      return JSON.stringify([{ status: 'completed' }]);
    if (a[0] === 'pr' && a[1] === 'list') return '';
    if (a[0] === 'pr' && a[1] === 'create')
      return 'https://github.com/o/r/pull/7\n';
    if (a[0] === 'pr' && a[1] === 'merge') {
      mergeRequested = true;
      return '';
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      return JSON.stringify({
        state: mergeRequested ? 'MERGED' : 'OPEN',
        headRefOid: head,
        mergeable: 'MERGEABLE',
        mergeCommit: mergeRequested ? { oid: 'c'.repeat(40) } : null,
        statusCheckRollup: [],
      });
    }
    throw new Error(`unexpected gh ${a.join(' ')}`);
  };
  const run = (_cmd: string, args: string[]) => {
    const line = args.join(' ');
    if (line === 'rev-parse --abbrev-ref HEAD')
      return { code: 0, stdout: 'feat-x\n', stderr: '' };
    if (line === 'status --porcelain')
      return { code: 0, stdout: '', stderr: '' };
    if (line === 'rev-parse --show-toplevel')
      return { code: 0, stdout: `${wt}\n`, stderr: '' };
    if (args.includes('--git-common-dir'))
      return { code: 0, stdout: `${main}/.git\n`, stderr: '' };
    if (line === 'rev-parse HEAD')
      return { code: 0, stdout: `${head}\n`, stderr: '' };
    if (line === 'rev-parse origin/main')
      return { code: 0, stdout: `${base}\n`, stderr: '' };
    if (args[0] === 'diff')
      return { code: 0, stdout: 'src/x.ts\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  await shipCommand(
    ['--title', title, '--body-file', 'body.md', '--repo', 'o/r'],
    {
      cwd: wt,
      run,
      gh,
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      hasFile: () => false,
      readBody: () => body,
    },
  ).catch((error: unknown) => {
    assert.equal((error as { exitCode?: number }).exitCode, 74);
  });
  assert.equal(
    mergeRequested,
    false,
    'ship requested merge despite a skipped required aggregate',
  );
});
