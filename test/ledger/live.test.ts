import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadLiveContract } from '../../src/ledger/live.ts';
import { writeLiveContract } from '../helpers/live-contract.ts';

const origin = 'https://github.com/fixture/repo.git';

async function fixture() {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'local-contract-'));
  return { root, path: await writeLiveContract(root, 't-example') };
}

test('live contract loads local JSON and preserves delivery metadata', async () => {
  const f = await fixture();
  try {
    await writeLiveContract(f.root, 't-example', {
      description: 'Delivery requirements\nR1-task: none',
    });
    const contract = await loadLiveContract(f.path, 't-example', {
      origin: 'git@github.com:Fixture/Repo.git',
      revision: '2026-10-18T18:00:00.000Z',
    });
    assert.equal(contract.issueId, 't-example');
    assert.equal(contract.description, 'Delivery requirements\nR1-task: none');
    assert.deepEqual(contract.checks, ['gate']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const candidate of [
  {
    name: 'issue identity',
    issue: 't-other',
    options: { origin },
    error: /issueId mismatch/u,
  },
  {
    name: 'requested revision',
    issue: 't-example',
    options: { origin, revision: 'stale' },
    error: /revision mismatch/u,
  },
  {
    name: 'target repository',
    issue: 't-example',
    options: { origin: 'https://github.com/other/repo.git' },
    error: /targetRepo mismatch/u,
  },
  {
    name: 'malformed origin',
    issue: 't-example',
    options: { origin: 'invalid' },
    error: /unable to parse origin/u,
  },
]) {
  test(`live contract refuses mismatched ${candidate.name}`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        loadLiveContract(f.path, candidate.issue, candidate.options),
        candidate.error,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const candidate of [
  { name: 'missing checks', changes: { checks: undefined } },
  { name: 'duplicate checks', changes: { checks: ['gate', 'gate'] } },
  { name: 'invalid check ID', changes: { checks: ['../gate'] } },
  { name: 'oversized description', changes: { description: 'x'.repeat(8193) } },
  { name: 'unknown fields', changes: { transport: 'remote' } },
  {
    name: 'duplicate work references',
    changes: { description: 'R1-task: none\nR1-task: R1-23' },
  },
]) {
  test(`live contract refuses ${candidate.name}`, async () => {
    const f = await fixture();
    try {
      const valid = await loadLiveContract(f.path, 't-example', { origin });
      await writeFile(
        f.path,
        JSON.stringify({ ...valid, ...candidate.changes }),
      );
      await assert.rejects(loadLiveContract(f.path, 't-example', { origin }));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('live contract refuses missing files and invalid JSON', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      loadLiveContract(join(f.root, 'missing.json'), 't-example', { origin }),
      { code: 'ENOENT' },
    );
    await writeFile(f.path, '{');
    await assert.rejects(
      loadLiveContract(f.path, 't-example', { origin }),
      SyntaxError,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
