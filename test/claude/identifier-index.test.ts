import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, scoreTranscript } from '../../evals/compact-index/run.ts';
import {
  blockLimit,
  buildIndex,
  compactIndex,
  extractIdentifiers,
  mentionsBeforeLastBoundary,
  parseTranscript,
  rankIdentifiers,
  renderPaths,
} from '../../scripts/claude/identifier-index.ts';

const root = '/repo';

// Entries in the shape Claude Code writes to `transcript_path`.
const call = (input: Record<string, unknown>) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Bash', input }],
  },
});
const result = (text: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', content: [{ type: 'text', text }] }],
  },
});
const boundary = { type: 'system', subtype: 'compact_boundary' };
const summary = (text: string) => ({
  type: 'user',
  isCompactSummary: true,
  message: { role: 'user', content: text },
});
const jsonl = (entries: unknown[]) =>
  entries.map((entry) => JSON.stringify(entry)).join('\n');

test('extracts task ids, PRs, short SHAs, normalized paths and error types', () => {
  const ids = extractIdentifiers(
    'gh pr view 403 for t-7dk0vgk at 411b9c45481ceb1a; read /repo/.krn/worktrees/x/scripts/a.ts and ./docs/b.md and ~/.codex/c.toml; TypeError then ENOENT: no file; #12 https://x.io/a/b.md 1234567',
    root,
  ).map((id) => `${id.kind}:${id.value}`);
  assert.deepEqual(ids, [
    'pr:403',
    'task:t-7dk0vgk',
    'sha:411b9c4',
    'path:scripts/a.ts',
    'path:docs/b.md',
    'path:~/.codex/c.toml',
    'error:TypeError',
    'error:ENOENT',
    'pr:12',
  ]);
});

test('ranks what the agent acted on above tool-result noise and caps each kind at 40', () => {
  const listing = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`).join(
    '\n',
  );
  const entries = [
    call({ command: 'cat scripts/keep.ts' }),
    result(listing),
    boundary,
    call({ command: 'cat scripts/after.ts' }),
  ];
  const ranked = rankIdentifiers(mentionsBeforeLastBoundary(entries), root);
  assert.deepEqual(ranked[0], { kind: 'path', value: 'scripts/keep.ts' });
  assert.equal(ranked.filter((id) => id.kind === 'path').length, 40);
  assert.ok(!ranked.some((id) => id.value === 'scripts/after.ts'));
});

test('renders paths as a brace tree and keeps the block within its byte budget', () => {
  assert.equal(
    renderPaths([
      'scripts/claude/a.ts',
      'scripts/claude/b.ts',
      'scripts/c.ts',
      '/abs/d.md',
    ]),
    'scripts/{claude/{a.ts,b.ts},c.ts} /abs/d.md',
  );
  const many = Array.from({ length: 40 }, (_, i) => ({
    kind: 'path' as const,
    value: `deep/directory/name/number-${i}/file-with-a-long-name-${i}.ts`,
  }));
  const { text, chosen } = buildIndex(many);
  assert.ok(Buffer.byteLength(text) <= blockLimit);
  assert.ok(chosen.length > 0 && chosen.length < many.length);
  assert.equal(buildIndex([]).text, '');
});

test('a missing or torn transcript degrades to no block', () => {
  assert.equal(compactIndex('/nonexistent/transcript.jsonl', root), '');
  assert.equal(parseTranscript('{"type":"user"}\n{torn').length, 1);
});

test('the evaluator scores index and summary recall of identifiers reused after a boundary', () => {
  const raw = jsonl([
    call({ command: 'git show 411b9c4 -- scripts/a.ts' }),
    call({ command: 'krn task claim t-7dk0vgk' }),
    boundary,
    summary('Working on t-7dk0vgk.'),
    call({ command: 'cat scripts/a.ts' }),
    call({ command: 'git show 411b9c4' }),
    call({ command: 'krn task close t-7dk0vgk' }),
  ]);
  const scores = scoreTranscript(raw, root);
  assert.equal(scores.length, 1);
  assert.deepEqual(aggregate(scores), {
    boundaries: 1,
    targets: 3,
    indexRecall: 1,
    summaryRecall: 1 / 3,
    maxBlockBytes: scores[0]?.blockBytes,
  });
  // Fewer than three calls after a boundary is not a scorable boundary.
  assert.equal(
    scoreTranscript(jsonl([call({ command: 'x' }), boundary, call({})]), root)
      .length,
    0,
  );
});
