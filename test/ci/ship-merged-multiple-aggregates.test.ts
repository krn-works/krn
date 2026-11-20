import assert from 'node:assert/strict';
import test from 'node:test';
import { shipCommand } from '../../src/ci/ship.ts';

test('ship recovers a merged PR when the target requires two Actions aggregates', async () => {
  const head = 'a'.repeat(40);
  const merge = 'b'.repeat(40);
  const cwd = '/repo/.krn/worktrees/feature';
  const result = await shipCommand(
    [
      '--title',
      'feat(ci): report the recorded merge (t-1234567)',
      '--body-file',
      'body.md',
      '--repo',
      'owner/repo',
    ],
    {
      cwd,
      readBody: () => '## Why\n\nx\n\n## Verified\n\ny\n\nTicket: t-1234567\n',
      run(command, args) {
        assert.equal(command, 'git');
        assert.notEqual(args[0], 'push');
        const answers = new Map([
          ['rev-parse --abbrev-ref HEAD', 'feature'],
          ['rev-parse --show-toplevel', cwd],
          ['rev-parse --path-format=absolute --git-common-dir', '/repo/.git'],
          ['rev-parse HEAD', head],
          ['status --porcelain', ''],
        ]);
        return {
          code: 0,
          stdout: answers.get(args.join(' ')) ?? '',
          stderr: '',
        };
      },
      async gh(args) {
        if (args[0] === 'api' && args[1]?.includes('/rules/branches/')) {
          return JSON.stringify([
            {
              type: 'required_status_checks',
              parameters: {
                required_status_checks: ['Check', 'ci / Check'].map(
                  (context) => ({
                    context,
                    integration_id: 15368,
                  }),
                ),
              },
            },
          ]);
        }
        if (args[0] === 'api' && args[1]?.includes('/branches/')) return '{}';
        if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged'))
          return `7 ${merge}\n`;
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            state: 'MERGED',
            headRefOid: head,
            mergeCommit: { oid: merge },
          });
        }
        throw new Error(`unexpected gh call ${args.join(' ')}`);
      },
    },
  );
  assert.match(result, new RegExp(`^verdict: merged ${merge}$`, 'mu'));
});
