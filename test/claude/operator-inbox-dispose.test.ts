import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { allEntries, capture } from '../../src/memory/operator-inbox-store.ts';
import { run } from '../../src/successor/operator-inbox.ts';
import { addPendingTask } from '../../src/task/pending.ts';
import { serializeTask } from '../../src/task/record.ts';

const record = (id: string) =>
  serializeTask({
    id,
    status: 'open',
    resolution: null,
    created: '2026-11-20',
    priority: 1,
    title: 'Pending record',
    after: [],
    body: ['Outcome: exit 0', 'Proof: node --test a'],
  });

// Hook environment of an interactive session, so capture records the prompt.
const interactive = {
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
};

/** A main checkout with one published record, one pending record and one captured directive. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'inbox-dispose-'));
  const git = (...args: string[]) => {
    const out = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
  };
  git('init', '-q', '-b', 'main');
  // The pending ref is a commit, so the fixture names its own identity instead of the host's.
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@e.invalid');
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks', 't-pub0001.json'), record('t-pub0001'));
  addPendingTask(root, 't-pend001', record('t-pend001'));
  capture(
    root,
    '075c3201-76f7-4eb7-89ac-04c9d53234c3',
    'Please make CI work like T3 with sharded runners and one aggregate check',
    interactive,
  );
  const [entry] = allEntries(root);
  assert.ok(entry);
  return { root, hash: entry.hash };
}

async function inbox(root: string, ...args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(
    [...args, '--root', root],
    root,
    {},
    {
      stdin: () => '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  return { code, stdout, stderr };
}

test('dispose --task accepts an id the task store holds only as a pending record', async () => {
  const { root, hash } = fixture();
  try {
    const pending = await inbox(root, 'dispose', hash, '--task', 't-pend001');
    assert.equal(pending.code, 0, pending.stderr);
    assert.equal(pending.stdout, `disposed ${hash}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispose --task accepts a published record and refuses an id with no record', async () => {
  const { root, hash } = fixture();
  try {
    const absent = await inbox(root, 'dispose', hash, '--task', 't-nope000');
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /^FAIL t-nope000: no task record/u);
    const published = await inbox(root, 'dispose', hash, '--task', 't-pub0001');
    assert.equal(published.code, 0, published.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('search reads a record the task store holds only as a pending record', async () => {
  const { root } = fixture();
  try {
    const found = await inbox(root, 'search', 'Pending', '--memory', root);
    assert.equal(found.code, 0, found.stderr);
    assert.match(found.stdout, /^1\/1 pending tasks\/t-pend001\.json$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
