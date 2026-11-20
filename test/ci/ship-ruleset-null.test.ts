import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const title =
  'feat(ci): honor ruleset context when sibling has null integration_id (t-1234567)';
const body = '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n';

test('D2: shipCommand honors required context ci / Check when another ruleset check has integration_id: null', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'krn-d2-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const main = join(scratch, 'main');
  const wt = join(main, '.krn', 'worktrees', 'feat-x');
  let time = 0;
  let merged = false;
  const gh = async (a: string[]): Promise<string> => {
    if (a[0] === 'api' && a[1]?.includes('/rules/branches/'))
      return JSON.stringify([
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'any-source-check', integration_id: null },
              { context: 'ci / Check', integration_id: 15368 },
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
      ]);
    if (a[0] === 'run' && a[1] === 'list')
      return JSON.stringify([{ status: 'completed' }]);
    if (a[0] === 'pr' && a[1] === 'list') return '';
    if (a[0] === 'pr' && a[1] === 'create')
      return 'https://github.com/o/r/pull/7\n';
    if (a[0] === 'pr' && a[1] === 'merge') {
      merged = true;
      return '';
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      return JSON.stringify({
        state: merged ? 'MERGED' : 'OPEN',
        headRefOid: head,
        mergeable: 'MERGEABLE',
        mergeCommit: merged ? { oid: merge } : null,
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

  const out = await shipCommand(
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
  );
  assert.match(out, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});
