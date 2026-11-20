import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const title = 'feat(ci): scope all gh api calls (t-1234567)';
const body = '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n';

test('D1: shipCommand scopes every gh api call with KRN_APP_REPOSITORY for --repo', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'krn-d1-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const main = join(scratch, 'main');
  const wt = join(main, '.krn', 'worktrees', 'feat-x');
  const unscopedGh: string[] = [];
  let merged = false;
  const run = (command: string, args: string[]) => {
    const isEnvGh = command === 'env' && args[1] === 'gh';
    if (command === 'gh') unscopedGh.push(args.join(' '));
    const ghArgs = isEnvGh ? args.slice(2) : command === 'gh' ? args : null;
    if (ghArgs !== null) {
      if (ghArgs[0] === 'api' && ghArgs[1]?.includes('/rules/branches/'))
        return { code: 0, stdout: '[]', stderr: '' };
      if (ghArgs[0] === 'api' && ghArgs[1]?.includes('/branches/'))
        return { code: 0, stdout: '{}', stderr: '' };
      if (ghArgs[0] === 'api' && ghArgs[1]?.includes('/check-runs'))
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: 1,
              name: 'Check',
              appId: 15368,
              startedAt: '2026-11-20T08:00:00Z',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              detailsUrl:
                'https://github.com/outside/priv/actions/runs/9/job/1',
            },
          ]),
          stderr: '',
        };
      if (ghArgs[0] === 'pr' && ghArgs[1] === 'list')
        return { code: 0, stdout: '', stderr: '' };
      if (ghArgs[0] === 'pr' && ghArgs[1] === 'create')
        return {
          code: 0,
          stdout: 'https://github.com/outside/priv/pull/7\n',
          stderr: '',
        };
      if (ghArgs[0] === 'pr' && ghArgs[1] === 'merge') {
        merged = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (ghArgs[0] === 'pr' && ghArgs[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: merged ? 'MERGED' : 'OPEN',
            headRefOid: head,
            mergeable: 'MERGEABLE',
            mergeCommit: merged ? { oid: merge } : null,
            statusCheckRollup: [],
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '[]', stderr: '' };
    }
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
    ['--title', title, '--body-file', 'body.md', '--repo', 'outside/priv'],
    {
      cwd: wt,
      run,
      sleep: async () => {},
      hasFile: () => false,
      readBody: () => body,
    },
  );
  assert.deepEqual(
    unscopedGh,
    [],
    `gh calls ran without KRN_APP_REPOSITORY=outside/priv: ${unscopedGh.join(' | ')}`,
  );
});
