// fast-covers: src/brain/evidence-proposals.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeExposure } from '../../src/brain/close-exposure.ts';
import {
  ciFailures,
  closeFailures,
  evidenceProposals,
  renderEvidenceProposals,
  reviewFindings,
  trialRecord,
} from '../../src/brain/evidence-proposals.ts';
import { readExposures } from '../../src/brain/exposures.ts';
import { parseUnified } from '../../src/brain/record.ts';
import { proposalsFromEvidence } from '../../src/cli/standards-ledger.ts';
import { gateTotals } from '../../src/outcome/ledger.ts';

// KRN-12: the check runs, the review record and the operator inbox rows are verbatim captures; the
// close rows come from the real writer of `krn task close`.
const fixtures = join(import.meta.dirname, '../fixtures');
const capture = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(join(fixtures, path), 'utf8'));
const lines = async (path: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(fixtures, path), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const empty = {
  ci: [],
  exposures: [],
  reviews: [],
  inbox: [],
  dispositions: [],
};

function closeRows(
  hidden: string | null,
  ci: string | null,
  pr: number | null,
) {
  const main = mkdtempSync(join(tmpdir(), 'krn-close-'));
  closeExposure(main, { task: 't-aaaaaaa', clauses: [], pr, ci, hidden });
  return readExposures(main);
}

test('a rerun of the required check in a captured check-runs answer is one ci proposal naming the PR', async () => {
  const gate = gateTotals([
    await capture('outcome-ledger/check-runs-rerun.json'),
  ]);
  assert.equal(gate.reruns, 1);
  const [draft] = ciFailures([{ number: 181, prGate: gate }]);
  assert.equal(draft?.evidence_kind, 'ci');
  assert.deepEqual(draft?.evidence, ['#181']);
  assert.match(draft?.text ?? '', /#181 check run 127549243386/u);
  assert.deepEqual(ciFailures([{ number: 7, prGate: { failed: [] } }]), []);
});

const checkRun = (id: number, conclusion: string | null) => ({
  id,
  name: 'Check',
  app: { id: 15368 },
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  started_at: '2026-11-18T10:00:00Z',
  completed_at: conclusion === null ? null : '2026-11-18T10:05:00Z',
});
const gateOf = (...conclusions: (string | null)[]) =>
  gateTotals([{ check_runs: conclusions.map((c, i) => checkRun(i + 1, c)) }]);

test('two successes, cancelled then success, or no conclusion yield no ci proposal; a red before success yields one naming PR and run', () => {
  for (const gate of [
    gateOf('success', 'success'),
    gateOf('cancelled', 'success'),
    gateOf(null),
    gateOf('skipped', 'success'),
  ])
    assert.deepEqual(ciFailures([{ number: 17, prGate: gate }]), []);
  const [draft] = ciFailures([
    { number: 17, prGate: gateOf('failure', 'success') },
  ]);
  assert.deepEqual(draft?.evidence, ['#17']);
  assert.match(draft?.text ?? '', /#17 check run 1\b/u);
});

test('a close row with a failed hidden test proposes one hidden-test record; a passing or unknown one proposes none', () => {
  const [draft] = closeFailures(closeRows('fail', 'success', 1140));
  assert.equal(draft?.evidence_kind, 'hidden-test');
  assert.equal(draft?.subject, 'hidden-test:t-aaaaaaa');
  assert.deepEqual(draft?.evidence, ['#1140']);
  assert.deepEqual(closeFailures(closeRows('pass', 'success', 1140)), []);
  assert.deepEqual(closeFailures(closeRows(null, null, null)), []);
});

test('a close row whose Check failed is a ci failure', () => {
  const [draft] = closeFailures(closeRows(null, 'failure', 1141));
  assert.equal(draft?.evidence_kind, 'ci');
});

test('a Stop refusal in a proof line is not a source', () => {
  const [row] = closeRows('fail', null, null);
  assert.ok(row);
  const refused = {
    ...row,
    channel: 'stop',
    proof: 'Stop refusals: 3',
    evidence: { pr: 1, ci: 'failure', hidden: 'fail' },
  };
  assert.deepEqual(closeFailures([refused]), []);
});

test('a captured review record yields its blocking findings, one subject per path, with the PR', async () => {
  const record = await capture('outcome-ledger/review-record.json');
  const drafts = reviewFindings([record]);
  assert.equal(drafts.length, 3);
  assert.equal(
    evidenceProposals({ ...empty, reviews: [record] }, new Map(), '2026-11-16')
      .length,
    1,
  );
  assert.equal(drafts[0]?.evidence_kind, 'review');
  assert.equal(
    drafts[0]?.subject,
    'review:infra/ci/controller/library/src/ci/Controller.groovy',
  );
  assert.deepEqual(drafts[0]?.evidence, ['#240']);
  assert.doesNotMatch(drafts[0]?.text ?? '', /^\[/u);
});

test('an operator prompt filed as memory is quoted verbatim; launcher and harness rows are not corrections', async () => {
  const inbox = await lines('operator-inbox/inbox.jsonl');
  const dispositions = [
    ...(await lines('operator-inbox/dispositions.jsonl')),
    { hash: 'b0e600f7fe36', kind: 'memory', ref: 'launcher' },
    { hash: 'h1', kind: 'memory', ref: 'harness' },
  ];
  const harness = {
    hash: 'h1',
    text: '<task-notification>\n<task-id>a9e853e5b65d4173a</task-id>',
  };
  const proposals = evidenceProposals(
    { ...empty, inbox: [...inbox, harness], dispositions },
    new Map(),
    '2026-11-16',
  );
  assert.deepEqual(
    proposals.map((p) => [p.evidence_kind, p.subject, p.text]),
    [
      [
        'operator-verbatim',
        'operator:speed-quality-blanket-grant',
        'Jasne, decyduj i leć, o nic mnie nie pytaj',
      ],
      [
        'operator-verbatim',
        'operator:krn-only-scope',
        'no nie no - nie musisz robic pod to specjalnych założeń - po prostu zacznij realizować dalszy rozwój krn - skup się na aktualnym stanie',
      ],
    ],
  );
  assert.deepEqual(proposals[0]?.evidence, [
    '.krn/operator/inbox.jsonl#98d1e334a229',
  ]);
});

test('a subject held by a record in force makes a supersede proposal, otherwise an add', async () => {
  const sources = { ...empty, ci: [{ number: 181, prGate: { failed: [1] } }] };
  const [add] = evidenceProposals(sources, new Map(), '2026-11-16');
  assert.equal(add?.action, 'add');
  const [sup] = evidenceProposals(
    sources,
    new Map([['ci:required-check-rerun', 'r-old']]),
    '2026-11-16',
  );
  assert.equal(sup?.action, 'supersede');
  assert.equal(sup?.supersedes, 'r-old');
  assert.match(
    renderEvidenceProposals([add, sup].filter((p) => p !== undefined)).at(-1) ??
      '',
    /^proposals: 2 \(ci 2\)$/u,
  );
});

test('a proposal becomes a trial record the record schema accepts, with subject, evidence kind and review date', async () => {
  const [p] = evidenceProposals(
    { ...empty, ci: [{ number: 181, prGate: { failed: [1] } }] },
    new Map([['ci:required-check-rerun', 'r-old']]),
    '2026-11-16',
  );
  assert.ok(p);
  const [record] = parseUnified([trialRecord(p)]);
  assert.equal(record?.status, 'trial');
  assert.equal(record?.subject, 'ci:required-check-rerun');
  assert.equal(record?.evidence_kind, 'ci');
  assert.deepEqual(record?.supersedes, ['r-old']);
  assert.equal(record?.review_by, '2026-12-16');
});

test('the readers find the review records, inbox and exposures of a repository and list one line per proposal with its evidence kind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-evidence-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const series = join(root, '.krn/archive/review-series-abc/records');
  mkdirSync(series, { recursive: true });
  cpSync(
    join(fixtures, 'outcome-ledger/review-record.json'),
    join(series, '1.json'),
  );
  mkdirSync(join(root, '.krn/operator'), { recursive: true });
  cpSync(
    join(fixtures, 'operator-inbox/inbox.jsonl'),
    join(root, '.krn/operator/inbox.jsonl'),
  );
  cpSync(
    join(fixtures, 'operator-inbox/dispositions.jsonl'),
    join(root, '.krn/operator/dispositions.jsonl'),
  );
  closeExposure(root, {
    task: 't-aaaaaaa',
    clauses: [],
    pr: 9,
    ci: 'success',
    hidden: 'fail',
  });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents/records.json'),
    JSON.stringify([
      {
        id: 'r-scope',
        type: 'standard',
        text: 'Stay in KRN.',
        recorded_at: '2026-11-01',
        valid_from: '2026-11-01',
        valid_to: null,
        source: 'test',
        subject: 'operator:krn-only-scope',
      },
    ]),
  );
  const proposals = await proposalsFromEvidence(
    root,
    async () => [{ number: 181, prGate: { failed: [1] } }] as never,
    '2026-11-16',
  );
  const report = renderEvidenceProposals(proposals);
  assert.deepEqual(
    report.at(-1),
    'proposals: 5 (ci 1, hidden-test 1, review 1, operator-verbatim 2)',
  );
  assert.match(
    report.join('\n'),
    /evidence_kind=operator-verbatim subject=operator:krn-only-scope action=supersede supersedes=r-scope/u,
  );
});
