import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  accessOf,
  contaminated,
  scanRows,
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

test('a refused gh beside a curl that returned the fix still counts; so does a second gh that worked', () => {
  const both = scanTranscript(
    session(
      {
        command:
          'gh pr view 1 -R o/r 2>&1; curl -s https://api.github.com/repos/o/r/pulls/1',
      },
      'To get started with GitHub CLI, please run:  gh auth login\n{"title":"Fix root package.json"}',
    ),
  );
  assert.deepEqual(
    both.map((h) => [h.kind, h.failed]),
    [
      ['gh', true],
      ['http', false],
    ],
  );
  const twice = scanTranscript(
    session(
      { command: 'gh pr list 2>&1; gh pr view 1 -R o/r' },
      'no git remotes found\ntitle: Fix root package.json',
    ),
  );
  assert.equal(contaminated(twice), true);
});

test('upstream text quoting a failure does not clear the call that fetched it', () => {
  const hits = scanTranscript(
    session(
      { command: 'gh issue view 16 -R o/r' },
      'title: install fails\nbody: the script says `sh: curl: command not found` and HTTP 404 on the mirror',
    ),
  );
  assert.equal(contaminated(hits), true);
});

test('a fetch nested in sh -c, eval, python or node is a call', () => {
  assert.equal(
    accessOf('Bash', { command: "bash -c 'gh pr diff 1 -R o/r'" }),
    'gh',
  );
  assert.equal(
    accessOf('Bash', { command: 'eval "curl -s https://x.org/a"' }),
    'http',
  );
  assert.equal(
    accessOf('Bash', {
      command:
        'python3 -c "import urllib.request as u; print(u.urlopen(\'https://api.github.com/repos/o/r/pulls/1\').read())"',
    }),
    'http',
  );
  assert.equal(
    accessOf('Bash', { command: 'grep -rn "github.com/o/r/pkg" go.mod' }),
    undefined,
  );
});

test('a subagent transcript under the session directory is scanned with its session', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'contam-'));
  try {
    const id = '466fcb95-567c-4f2f-ac05-0db218bdf2cf';
    const dir = join(scratch, 'claude-config', 'projects', '-session');
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '');
    writeFileSync(
      join(dir, id, 'subagents', 'agent-a1.jsonl'),
      session({ command: 'gh pr diff 1 -R o/r' }, '-fix\n+fixed'),
    );
    writeFileSync(join(scratch, 't-aaaaaaa-1.log'), `{"session_id":"${id}"}`);
    const rows = join(scratch, 'rows.jsonl');
    writeFileSync(
      rows,
      `${JSON.stringify({ unit: 't-aaaaaaa', arm: 'A', rep: 1, pass: true, cost: 0, harness: 'h' })}\n`,
    );
    const [r] = scanRows(rows, scratch);
    assert.equal(r?.transcript, true);
    assert.equal(contaminated(r?.hits ?? []), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('--screen --report prints the contamination line for a transcript that fetched the upstream fix', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'contam-report-'));
  try {
    const id = '466fcb95-567c-4f2f-ac05-0db218bdf2cf';
    const dir = join(scratch, 'claude-config', 'projects', '-session');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), fixture('t-1d7k0sg'));
    writeFileSync(join(scratch, 't-1d7k0sg-1.log'), `{"session_id":"${id}"}`);
    const rows = join(scratch, 'rows.jsonl');
    writeFileSync(
      rows,
      `${JSON.stringify({ unit: 't-1d7k0sg', arm: 'A', rep: 1, pass: true, cost: 0, harness: 'h' })}\n${JSON.stringify({ unit: 't-1bfdvot', arm: 'A', rep: 1, pass: false, cost: 0, harness: 'h' })}\n`,
    );
    const r = spawnSync(
      'node',
      [
        'evals/replay/run.ts',
        '--screen',
        '--report',
        '--rows',
        rows,
        '--scratch',
        scratch,
      ],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^t-1d7k0sg\/1 pass=true gh /m);
    assert.match(
      r.stdout,
      /^contamination: 1 flagged of 2 rows \(passes 1, fails 0\); transcripts missing 1$/m,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
