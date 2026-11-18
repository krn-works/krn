import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
  checkConclusion,
  deliveries,
  killShim,
  mergedPull,
} from '../../evals/adoption/recovery-live.ts';

// Verbatim shape of `gh pr list --state merged --json number,title,headRefName,mergeCommit` on the
// pilot repository: the record PR of a task names its id as well as the delivery PR.
const listed = `[
  {"headRefName":"numeric-entities","mergeCommit":{"oid":"8350c9c8ba871679dc1c09d929f2a5c32ff3caa9"},"number":92,"title":"fix(html): leave invalid numeric character references undecoded (t-h2yjgx3)"},
  {"headRefName":"task-records-t-h2yjgx3","mergeCommit":{"oid":"e36585d9f72ff2193c0b9cf8aba0c0169ec46d29"},"number":91,"title":"chore(tasks): 1 task record (t-h2yjgx3)"},
  {"headRefName":"self-link","mergeCommit":{"oid":"2f74787d34ada8b748b2b4134602a4da04ab07f0"},"number":90,"title":"fix(findings): ignore self-links when finding orphan pages (t-rge9n9y)"}
]`;

test('the live oracle counts the delivery PR of a task once and never its record PR', () => {
  const pulls = JSON.parse(listed).map((pull: unknown) =>
    mergedPull.parse(pull),
  );
  assert.deepEqual(
    deliveries(pulls, 't-h2yjgx3').map((pull) => pull.number),
    [92],
  );
  assert.deepEqual(deliveries(pulls, 't-absent0'), []);
});

test('live acceptance reads the completed ci / Check run of the merge commit', () => {
  assert.equal(
    checkConclusion([
      { name: 'ci / Test (1/1)', status: 'completed', conclusion: 'failure' },
      { name: 'ci / Check', status: 'completed', conclusion: 'success' },
    ]),
    'success',
  );
  assert.equal(
    checkConclusion([
      { name: 'ci / Check', status: 'in_progress', conclusion: null },
    ]),
    undefined,
  );
  assert.equal(checkConclusion([]), undefined);
});

function shimRig() {
  const base = mkdtempSync(join(tmpdir(), 'krn-recovery-shim-'));
  const shim = join(base, 'shim');
  const real = join(base, 'real');
  mkdirSync(shim);
  mkdirSync(real);
  writeFileSync(join(shim, 'gh'), killShim);
  chmodSync(join(shim, 'gh'), 0o755);
  // The next gh on PATH: merges succeed, the PR reads MERGED.
  writeFileSync(
    join(real, 'gh'),
    '#!/bin/sh\nif [ "$2" = view ]; then echo MERGED; fi\necho "real $*" >> "$(dirname "$0")/calls"\n',
  );
  chmodSync(join(real, 'gh'), 0o755);
  return { base, shim, real };
}

async function runShim(
  rig: ReturnType<typeof shimRig>,
  kill: string,
  args: string[],
): Promise<{ killed: boolean; groupDied: boolean }> {
  const group = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const died = new Promise<boolean>((resolve) =>
    group.on('exit', (_code, signal) => resolve(signal === 'SIGKILL')),
  );
  const marker = join(rig.base, 'killed');
  spawnSync(join(rig.shim, 'gh'), args, {
    env: {
      ...process.env,
      PATH: `${rig.shim}:${rig.real}:${process.env.PATH ?? ''}`,
      RECOVERY_KILL: kill,
      RECOVERY_KILLED: marker,
      RECOVERY_PGID: String(group.pid),
    },
  });
  const groupDied = await Promise.race([
    died,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (!groupDied) group.kill('SIGKILL');
  return { killed: existsSync(marker), groupDied };
}

test('the gh shim passes through and cuts the batch only after a merge, once, when armed at d', async () => {
  const rig = shimRig();
  try {
    assert.deepEqual(await runShim(rig, 'd', ['pr', 'view', '7']), {
      killed: false,
      groupDied: false,
    });
    assert.deepEqual(await runShim(rig, '', ['pr', 'merge', '7']), {
      killed: false,
      groupDied: false,
    });
    assert.deepEqual(await runShim(rig, 'd', ['pr', 'merge', '7']), {
      killed: true,
      groupDied: true,
    });
    assert.equal(readFileSync(join(rig.base, 'killed'), 'utf8'), 'd 7\n');
    assert.deepEqual(await runShim(rig, 'd', ['pr', 'merge', '8']), {
      killed: true,
      groupDied: false,
    });
    assert.match(
      readFileSync(join(rig.real, 'calls'), 'utf8'),
      /real pr merge 8/u,
    );
  } finally {
    rmSync(rig.base, { recursive: true, force: true });
  }
});
