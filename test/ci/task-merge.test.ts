import assert from 'node:assert/strict';
import test from 'node:test';
import { taskMerge } from '../../src/ci/task-merge.ts';
import { capture } from '../receivers/capture.ts';

// KRN-12: the real `gh pr list --head <branch> --state merged` answer of a lane slug that two
// tasks reused: #1013 delivered t-t76x6w0, #854 delivered t-12yk5za.
const reused =
  capture(
    'fixtures/gh',
    'pr-list-merged-reused-branch',
  ).streams.stdout?.toString('utf8') ?? '';
const onBase = () => true;

test('a reused branch name never attributes another task’s merge', () => {
  assert.equal(taskMerge(reused, 't-gnz6vfe', onBase), undefined);
});

test('the merged PR that names the task is found among older PRs of the branch', () => {
  assert.deepEqual(taskMerge(reused, 't-12yk5za', onBase), {
    pr: 854,
    sha: 'b6a0bea73ee18c1e525426d658a3e51745f98f69',
  });
});

test('a merge commit that is not on the base does not count', () => {
  assert.equal(
    taskMerge(
      reused,
      't-t76x6w0',
      (sha) => sha !== '049cc34981f5ad0196f772e21469a90ee13d3a66',
    ),
    undefined,
  );
});

test('a ship without a task id attributes no merge by branch', () => {
  assert.equal(taskMerge(reused, undefined, onBase), undefined);
});

test('a Refs trailer names the task as the title suffix does', () => {
  const listed = JSON.stringify([
    {
      number: 9,
      title: 'feat(x): first half',
      body: 'Text\n\nRefs: t-abcdefg\n',
      mergeCommit: { oid: 'a'.repeat(40) },
    },
  ]);
  assert.deepEqual(taskMerge(listed, 't-abcdefg', onBase), {
    pr: 9,
    sha: 'a'.repeat(40),
  });
});
