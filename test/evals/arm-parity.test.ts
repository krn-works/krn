// Every replay arm reads its session through one rule and arm C holds a claim when SessionStart runs: one budget-capped
// session must be graded in A, B and C alike, and arm C's SessionStart must serve a packet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { armBRow } from '../../evals/replay/arm-b.ts';
import { armCRow } from '../../evals/replay/arm-c.ts';
import { type LiveUnit, screenUnit } from '../../evals/replay/live.ts';
import { commitDateOrder, RepoMemory } from '../../evals/replay/memory.ts';
import { trialId } from '../../src/brain/evidence-proposals.ts';
import { sessionContext } from '../../src/hook/session-start.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Verbatim shape of `claude -p --output-format json` stopped by --max-budget-usd: an error result that spent its budget. */
const budgetCapped =
  '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"duration_ms":91000,"num_turns":31,"total_cost_usd":1.02,"session_id":"00000000-0000-4000-8000-000000000001","modelUsage":{"claude-sonnet-5-5":{"costUSD":1.02}}}';

function fixture(root: string) {
  const clone = join(root, 'sources', 'o__r');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'n');
  writeFileSync(join(clone, 'a.txt'), '1\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'base');
  const base = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'fixed.txt'), 'x\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'fix');
  const reference = git(clone, 'rev-parse', 'HEAD');
  const dir = join(root, 'units', 't-aaaaaaa');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hidden.txt'), 'present\n');
  const unit = {
    id: 't-aaaaaaa',
    repo: 'o/r',
    base,
    reference,
    task: { title: 'Fix the test command', body: 'Why: npm test is broken' },
    spec: 's',
    hidden: { file: 'hidden.txt', dest: 'hidden.check' },
    install: 'true',
    test: 'test -f fixed.txt',
    committed: '2026-08-01',
    issue: 'https://github.com/o/r/issues/1',
  };
  writeFileSync(join(dir, 'unit.json'), JSON.stringify(unit));
  const stub = join(root, 'claude');
  writeFileSync(stub, `#!/bin/sh\necho '${budgetCapped}'\n`);
  chmodSync(stub, 0o755);
  const env = {
    ...process.env,
    KRN_EVAL_CLAUDE: stub,
    KRN_EVAL_SLOT_DIR: join(root, 'slots'),
  };
  return {
    live: { unit: unit as never, dir },
    options: {
      sources: join(root, 'sources'),
      scratch: join(root, 'scratch'),
      harness: 'h',
      env,
    },
  };
}

/** An adopted repository ships only enforced standards; the one advisory record is what SessionStart can serve. */
function seedAdvisoryStandard(wt: string): void {
  const file = join(wt, '.agents', 'standards.json');
  writeFileSync(
    file,
    JSON.stringify([
      ...(JSON.parse(readFileSync(file, 'utf8')) as unknown[]),
      {
        id: 's-test-command-works',
        type: 'standard',
        area: 'tests',
        layer: 'universal',
        audience: 'worker',
        tier: 'reflex',
        text: 'Fix the test command only after the failing test is reproduced.',
        why: 'A guessed fix costs a CI round.',
        provenance: { origin: 'test', evidence: ['a.txt'], proposals: [] },
        enforcement: { kind: 'advisory' },
        applies: { stacks: [], needs: [], paths: [], terms: [] },
        status: 'accepted',
        supersedes: [],
        recorded_at: '2026-01-01',
        valid_from: '2026-01-01',
        valid_to: null,
      },
    ]),
  );
}

test('one budget-capped session that ran no test and changed nothing is a no-attempt in arms A, B and C alike', async (t) => {
  requiresIsolation(t, 'live arm sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'arm-parity-'));
  try {
    const { live, options } = fixture(root);
    const a = await screenUnit(live, { ...options, rowsFile: join(root, 'r') });
    const b = (await armBRow(live, options)).row;
    const c = await armCRow(live, options);
    assert.deepEqual(
      [a, b, c].map((row) => [row.arm, row.pass, row.cost, row.verdict]),
      [
        ['A', null, 1.02, 'no-attempt'],
        ['B', null, 1.02, 'no-attempt'],
        ['C', null, 1.02, 'no-attempt'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('arm C claims its task before the session, so SessionStart serves a packet and the row attests the injection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-parity-'));
  try {
    const { live, options } = fixture(root);
    let served: string | undefined;
    const row = await armCRow(live, {
      ...options,
      session: async (wt) => {
        seedAdvisoryStandard(wt);
        served = sessionContext(wt, 'parity-session', {});
        return {
          result: { ok: false, detail: 'capped', cost: 1.02, capped: true },
          notStarted: false,
          timedOut: false,
          stdout: budgetCapped,
          stderr: '',
        };
      },
    });
    assert.match(served ?? '', /^Standards for this task \(\d+\):/u);
    assert.ok((row.injection ?? 0) > 0);
    assert.equal(
      row.verdict,
      'fail',
      'the session changed the tree: a fail, not a no-attempt',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a unit whose toolchain does not resolve is screened out and no session runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-parity-'));
  try {
    const { live, options } = fixture(root);
    let sessions = 0;
    const row = await screenUnit(live, {
      ...options,
      rowsFile: join(root, 'r'),
      preflight: async () => 1,
      session: async () => {
        sessions++;
        throw new Error('no session may run');
      },
    });
    assert.equal(sessions, 0);
    assert.equal(row.pass, null);
    assert.equal(row.verdict, 'screened');
    assert.match(row.screenedOut ?? '', /exit 1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scratch inside a git repository is refused before any session, not at the grade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-parity-'));
  try {
    const { live, options } = fixture(root);
    let sessions = 0;
    await assert.rejects(
      armCRow(live, {
        ...options,
        // The fixture clone is a git repository: a scratch inside it would abort the grade after a paid session.
        scratch: join(options.sources, 'o__r', 'scratch'),
        session: async () => {
          sessions++;
          throw new Error('no session may run');
        },
      }),
      /inside the git repository/u,
    );
    assert.equal(sessions, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("arm C serves the record unit 1's graded failure proposed to unit 2 of the repo; arms A and B never see it", async (t) => {
  requiresIsolation(t, 'live arm sandbox', ['bwrap']);
  const root = mkdtempSync(join(tmpdir(), 'arm-parity-'));
  try {
    const { live, options } = fixture(root);
    // Two units of one repository whose ids sort against their commit dates.
    const unit = (id: string, committed: string): LiveUnit => ({
      ...live,
      unit: {
        ...(live.unit as LiveUnit['unit']),
        id,
        committed,
      } as LiveUnit['unit'],
    });
    const later = unit('t-aaaaaaa', '2026-09-02');
    const earlier = unit('t-zzzzzzz', '2026-09-01');
    assert.deepEqual(
      commitDateOrder([later, earlier]).map((u) => u.unit.id),
      ['t-zzzzzzz', 't-aaaaaaa'],
    );
    const seen: Record<string, string> = {};
    const capped = {
      result: { ok: false, detail: 'capped', cost: 1.02, capped: true },
      notStarted: false,
      timedOut: false,
      stdout: budgetCapped,
      stderr: '',
    };
    const memory = new RepoMemory();
    const today = '2026-11-19';
    // Unit 1 in arm C: the session changes the tree, the hidden test stays red, the graded failure is remembered.
    const first = await armCRow(earlier, {
      ...options,
      memory: memory.forRepo(earlier.unit.repo),
      session: async (wt) => {
        // A change the hidden test (test -f fixed.txt) does not accept.
        writeFileSync(join(wt, 'changed.txt'), 'x\n');
        return capped;
      },
    });
    assert.equal(first.pass, false);
    memory.learn(earlier, first, today);
    const proposals = memory.forRepo('o/r');
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.evidence_kind, 'hidden-test');
    const id = trialId(proposals[0] as never);
    const session = (arm: string) => async (wt: string) => {
      const file = join(wt, '.krn', 'conventions.json');
      let records = '';
      try {
        records = readFileSync(file, 'utf8');
      } catch {}
      let claude = '';
      try {
        claude = readFileSync(join(wt, 'CLAUDE.md'), 'utf8');
      } catch {}
      seen[arm] = records + claude;
      if (arm === 'C')
        seen.served = sessionContext(wt, 'memory-session', {}) ?? '';
      writeFileSync(join(wt, 'changed.txt'), 'x\n');
      return capped;
    };
    await screenUnit(later, {
      ...options,
      rowsFile: join(root, 'r'),
      session: session('A'),
    });
    await armBRow(later, { ...options, session: session('B') });
    await armCRow(
      later,
      { ...options, memory: memory.forRepo('o/r'), session: session('C') },
      1,
      today,
    );
    assert.ok('A' in seen && 'B' in seen, 'the A and B sessions ran');
    assert.ok(seen.C?.includes(id), 'arm C checkout holds the record');
    assert.ok(!seen.A?.includes(id), 'arm A never sees it');
    assert.ok(!seen.B?.includes(id), 'arm B never sees it');
    assert.ok(
      seen.served?.includes(proposals[0]?.text ?? '?'),
      `SessionStart serves the remembered record: ${seen.served}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
