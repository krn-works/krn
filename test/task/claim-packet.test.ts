import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tokens } from '../../src/brain/packet.ts';
import {
  fixtureRepo,
  git,
  runCli,
  task,
  useScratch,
} from './claims-fixture.ts';

useScratch();

const clause = (id: string, text: string) => ({
  id,
  type: 'standard',
  text,
  audience: 'all',
  tier: 'reflex',
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  enforcement: { kind: 'advisory' },
  provenance: { origin: 'test', evidence: [], proposals: [] },
  status: 'accepted',
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
});

async function widgetRepo(): Promise<string> {
  const repo = await fixtureRepo('claim-packet-', [
    task('T-1', {
      title: 'Cache the widget renderer',
      stack: ['node'],
      area: 'widgets',
      body: [
        'Outcome: the widget renderer caches each rendered widget\nFiles: src/widget.ts',
      ],
    }),
  ]);
  await mkdir(join(repo, 'test'), { recursive: true });
  await mkdir(join(repo, '.krn'), { recursive: true });
  await writeFile(join(repo, 'test', 'widget.test.ts'), '// widget renderer\n');
  await writeFile(
    join(repo, '.krn', 'conventions.json'),
    JSON.stringify([
      clause('r-widget', 'Every widget renderer change carries a cache test.'),
      clause('r-unrelated', 'Release notes name the operator.'),
    ]),
  );
  git(repo, 'add', 'test');
  git(repo, 'commit', '-qm', 'add widget test');
  return repo;
}

test('claim prints the matching clause and top precedent within 400 tokens and stores the clause ids', async () => {
  const repo = await widgetRepo();
  try {
    const claim = await runCli(repo, ['claim', 'T-1', '--actor', 'worker'], {
      spawn: true,
    });
    assert.equal(claim.status, 0, claim.stderr);
    const lines = claim.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'T-1');
    assert.match(claim.stdout, /\[r-widget\] Every widget renderer change/u);
    assert.doesNotMatch(claim.stdout, /r-unrelated/u);
    assert.match(claim.stdout, /Precedent .*`test\/widget\.test\.ts`/u);
    assert.ok(tokens(lines.slice(1).join('\n')) <= 400);
    const stored = JSON.parse(
      readFileSync(join(repo, '.krn', 'task-claims', 'T-1.clauses'), 'utf8'),
    ) as { id: string; clauses: string[] };
    assert.deepEqual(stored.clauses, ['r-widget']);
    assert.equal(stored.id, 'T-1');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the packet stays within 400 tokens however many clauses match', async () => {
  const repo = await widgetRepo();
  try {
    await writeFile(
      join(repo, '.krn', 'conventions.json'),
      JSON.stringify(
        Array.from({ length: 60 }, (_, index) =>
          clause(
            `r-many-${index}`,
            `Widget renderer rule ${index}: ${'cache the rendered widget '.repeat(6)}`,
          ),
        ),
      ),
    );
    const claim = await runCli(repo, ['claim', 'T-1', '--actor', 'worker'], {
      spawn: true,
    });
    assert.equal(claim.status, 0, claim.stderr);
    const printed = claim.stdout.trimEnd().split('\n').slice(1).join('\n');
    assert.match(printed, /\[r-many-/u);
    assert.ok(tokens(printed) <= 400, `${tokens(printed)} tokens`);
    const stored = JSON.parse(
      readFileSync(join(repo, '.krn', 'task-claims', 'T-1.clauses'), 'utf8'),
    ) as { clauses: string[] };
    assert.ok(stored.clauses.length >= 1 && stored.clauses.length < 60);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a claim in a repository without records or siblings prints only the id', async () => {
  const repo = await fixtureRepo('claim-packet-bare-', [task('T-9')]);
  try {
    const claim = await runCli(repo, ['claim', 'T-9', '--actor', 'worker'], {
      spawn: true,
    });
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(claim.stdout, 'T-9\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
