import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  accessOf,
  contaminated,
  scanTranscript,
} from '../../evals/replay/contamination.ts';

const fixture = (unit: string) =>
  readFileSync(
    new URL(`./fixtures/contamination/${unit}.jsonl`, import.meta.url),
    'utf8',
  );

// The fixtures are the S7 screen's recorded tool calls and results, trimmed to the gh calls (t-k7gv1wt).
test('the scan flags t-1d7k0sg, whose gh pr diff -R returned the upstream fix (t-k7gv1wt)', () => {
  const hits = scanTranscript(fixture('t-1d7k0sg'));
  assert.deepEqual(
    hits.map((h) => [h.kind, h.failed]),
    [['gh', false]],
  );
  assert.equal(contaminated(hits), true);
});

test('the scan does not flag t-1bfdvot, whose gh pr list found no remote (t-k7gv1wt)', () => {
  const hits = scanTranscript(fixture('t-1bfdvot'));
  assert.ok(hits.length > 0, 'the gh call is still seen');
  assert.ok(hits.every((h) => h.kind === 'gh' && h.failed));
  assert.equal(contaminated(hits), false);
});

const session = (input: unknown, result: string, name = 'Bash') =>
  [
    { message: { content: [{ type: 'tool_use', id: 'u1', name, input }] } },
    {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'u1', content: result }],
      },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');

test('a gh refused for want of a login is not contamination', () => {
  const hits = scanTranscript(
    session(
      { command: 'gh pr view 1 -R cli/cli' },
      'To get started with GitHub CLI, please run:  gh auth login',
    ),
  );
  assert.equal(hits.length, 1);
  assert.equal(contaminated(hits), false);
});

test('text that names gh or a repository is not a network call; a command substitution is', () => {
  assert.equal(
    accessOf('Bash', { command: 'grep -n "gh run\\|gh api" action.yml' }),
    undefined,
  );
  assert.equal(
    accessOf('Bash', {
      command: 'go test ./... -run TestImport # github.com/o/r/pkg',
    }),
    undefined,
  );
  assert.equal(
    accessOf('Bash', { command: 'echo "$(gh api search/issues -f q=x)"' }),
    'gh',
  );
  assert.equal(
    accessOf('Bash', { command: 'curl -sS http://localhost:3077/' }),
    undefined,
  );
  assert.equal(
    accessOf('Bash', { command: 'curl -s https://proxy.golang.org/x/@v/list' }),
    'http',
  );
});

test('a refused WebFetch is not contamination; one that returned a page is', () => {
  const url = { url: 'https://github.com/o/r/pull/1' };
  assert.equal(
    contaminated(
      scanTranscript(
        session(url, 'Permission to use WebFetch has been denied.', 'WebFetch'),
      ),
    ),
    false,
  );
  assert.equal(
    contaminated(
      scanTranscript(session(url, 'Fix root package.json', 'WebFetch')),
    ),
    true,
  );
});
