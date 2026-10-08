# 2. Durable temporal brain v2

Date: 2026-10-08

## Status

Proposed for E3 design. The Wizard-of-Oz evaluation gates implementation and
the model-quality claim; it does not change the operator's selected scope or
client-isolation policy.

## Context

KRN needs durable, reusable knowledge for standards, procedures, course
distillations, decisions, patterns, pitfalls, preferences, project and host
facts, and examples. Continuity capsules remain task handoff state; they are
not the authority for reusable knowledge. Each client must have an isolated
brain repository. The operator selected a temporal brain, rights-aware
distillation, and operator-controlled promotion in the charter and product
spine.

R13 recommends Git-versioned semantic records with a rebuildable local SQLite
FTS5 index, and separates event capture from reviewed knowledge. The pinned
`krn.memory/v1` source provides useful precedent for scoped JSON records,
source provenance, status, and supersession links, but does not implement this
ADR's bitemporal fields or establish the proposed packet's benefit. R13 also
found no local evidence that retrieval improves model quality: the inspected
`llm-wiki` benchmark did not inject retrieved material into the model prompt.

This ADR separates selected **POLICY** from **Evidence** and **Hypothesis**.
Design rules below do not assert copyright clearance or measured quality gains.
Its source basis is the lead's `product-spine.md` §4, `reports/R13-memory-brain.md`,
the 2026-10-08 operator decisions in `charter.md`, and the pinned
`krn-memory` `SCHEMA.md` and `PROMOTION.md`.

## Decision

Propose one authority boundary: accepted semantic knowledge lives as reviewed,
Git-versioned JSON records in a brain repository; a local SQLite database with
FTS5 is a disposable, rebuildable retrieval index. Raw source material stays
in an authorized local source store and is not committed to the brain
repository. Do not combine raw event capture, provisional episodes, and
accepted semantic records into one authority layer.

### Records and time

Each record has a stable ID, type, concise claim in the author's own words,
`apply_when`, scope, owner, intended consumer, status, review date,
provenance, rights metadata, and usage/violation statistics. Types are:

- `standard`, `procedure`, and `pitfall` for reusable practice and failure
  handling;
- `decision` and `preference` for choices and working preferences;
- `fact` for project, repository, or host facts;
- `pattern` for reusable approaches;
- `distillation` for source-grounded concepts and learning material;
- `exemplar` for a small, original example tied to an accepted outcome.

**POLICY:** An accepted record includes `valid_from` and nullable `valid_to`
for when it applies in the world, plus immutable `recorded_at` for when this
revision was accepted. A Git revision records the full accepted state. The
derived index may calculate a transaction end from the next accepted
superseding revision's `recorded_at`; it must not silently rewrite history.
Queries can therefore ask both what applied at valid time T and what the
repository had accepted as of recorded time R.

Supersession is an append-only chain: retain the prior record, link its
`superseded_by` to the successor, and link the successor's `supersedes` to the
prior ID. Record the reason and effective date (`rationale_ref`,
`valid_to`/`valid_from`). A correction or conflict never deletes the old
record. Similarity alone cannot invalidate a record; subject and scope must
match and a reviewer must resolve the conflict. `review_by` means review is
due, not that the claim became false. A stale, disputed, or out-of-validity
record is withheld from normal packets.

**Evidence:** R13 reports that the pinned v1 schema already has scope,
provenance, status and reciprocal supersession links, but its accepted model
uses review/validity dates and Git history rather than explicit transaction
time. R13's recommendation for explicit bitemporal query support is a design
recommendation, not an implemented capability.

### Scope and client isolation

**POLICY:** Use a separate Git brain repository and separate local index per
client. A task is bound to one client/repository scope before retrieval.
Client A records are never candidates for client B, even when their text is
identical. Within a brain, records may use `global` (global within that
client's brain), stack, repository, host, or client-local scopes. Narrower
scopes do not implicitly inherit broader records; inheritance must be
declared by the task's scope contract. Deny by default when the scope is
missing or ambiguous.

**Evidence:** The operator's 2026-10-08 charter decision selects a separate
brain repository per client by default. R13 recommends hard scope matching;
the no-cross-client rule is POLICY.

### Provenance, rights, and ingestion

Every source-derived record carries provenance sufficient to review its
origin: source URI or local source ID, source revision/date, exact locator,
content hash where available, and the extraction/distillation version. An
exemplar also identifies its task or accepted commit, relevant verdict, and
acceptance evidence. Rights metadata records the basis (`license`,
`permission`, `personal-licensed`, `public-domain`, or another reviewed basis),
scope/conditions, whether raw retention is authorized, and any expiry or
attribution requirement. Missing or unclear rights basis blocks admission.
These fields document review; they do not make a legal determination.

The ingestion path is:

1. **Admit source:** record rights and retention basis. Keep raw material only
   in the authorized local source store, outside Git. Do not ingest
   transcripts or copy source corpora into records.
2. **Extract and distill:** produce candidate claims with exact source
   locators, then concise summaries in original wording and one or two small,
   original exemplars where useful. Prefer accepted KRN outcomes for code
   examples.
3. **Run deterministic checks:** validate the schema and scope; detect
   duplicates; compare proposed text with its source using a copy detector;
   and mark same-scope, same-subject conflicts disputed. A detector hit sends
   the candidate back for rejection or rewrite, not automatic promotion. Any
   numeric detector threshold is a conservative POLICY setting, not a legal
   safe harbor.
4. **Fidelity review:** an independent fidelity judge checks each claim
   against its cited locator, may abstain, and cannot promote its own work.
5. **Operator review and promotion:** present proposals in an inbox. Only
   explicit operator approval promotes records, through a reviewed PR to the
   client brain repository. Bind the proposal and generated index to the
   approved Git revision; rebuild the local index from that revision.

**Evidence:** R13 supports preserving exact locators, rights metadata,
source-bound review, original wording, copy detection, fidelity review, and
operator promotion. It cites copyright guidance that protects expression,
distinguishes facts and ideas, and treats fair use as fact-specific; this ADR
sets a conservative workflow and makes no legal conclusion. The pinned v1
schema and promotion guide are precedent for validated provenance and
PR-based review, not proof that this new ingestion path exists.

### Derived index and retrieval packet

SQLite with FTS5 is local, disposable, and entirely derived from a specific
brain repository revision. Store that revision in the index metadata. Rebuild
it deterministically; never treat index rows as authoritative records. Use
FTS5/BM25 for text ranking after hard applicability filters.

For a task, construct a deterministic packet of at most **2,000 tokens**.
Filter first by the bound client and declared scope, active status, valid
interval, and verified source/provenance. Rank applicable records by task and
changed-path match, observed violations after prior retrieval, then BM25
relevance to the task contract. Include record IDs, applicability cues,
content, and enforcement route. Include a concise omissions count so a worker
can request a named record when needed. A standard may block only when routed
to a deterministic check or an explicitly owned judge criterion; ordinary
guidance does not block work.

Hash the exact rendered packet, including ordering and omission metadata. Put
the packet hash, brain revision, and selected record IDs in the task trace and
verdict record. This makes retrieval reproducible and lets evaluation
attribute outcomes to the packet actually seen.

**POLICY:** The 2,000-token ceiling and deterministic selection are chosen
bounds for the first experiment. The initial mix of standards, exemplars,
pitfalls, and facts is a tunable starting allocation, not an evidence-backed
optimum.

### Amplification loop

For each finding from verdict, a judge, or a milestone review, assign a
deterministic class key (such as rule/category and affected path) and compare
it with the packet trace:

- the needed record was included and followed incorrectly: revise its wording
  or exemplar, or propose a deterministic check;
- the record existed but was omitted: revise applicability metadata or
  ranking;
- no suitable record existed: propose a new record.

At two recurrences of a class in 20 evaluated tasks, open a proposal. Prefer a
check when the requirement can be made deterministic; require that it fail on
the incident revision and pass after the correction. Otherwise propose a
pitfall record with an original example. Promotion always requires operator
approval. The loop produces proposals; it never writes accepted knowledge
automatically.

**Evidence:** Product spine sets the recurrence trigger and attributes a
failure to compliance, retrieval, or knowledge gaps. Whether this loop
reduces future findings remains a hypothesis to measure.

### A/B/C/R evaluation and kill criteria

Before building the ingestion pipeline, index, or packet implementation, run
the Wizard-of-Oz experiment with manually assembled packets. Use 6–9 frozen
tasks of the same class, same repository revision, tools, and verdict checks;
randomize order, run each arm twice, and use a blinded common acceptance
rubric. Include stale, conflicting, superseded, and inapplicable records.

- **A:** Luna without a retrieved packet.
- **B:** Luna with the applicable packet, capped at 2,000 tokens.
- **C:** Luna with an irrelevant packet of the same length as B, controlling
  for added context.
- **R:** Opus without a packet, as the reference arm.

Record packet condition and hash for every run. Measure first-pass verdict
PASS, repair rounds, judge findings (critical findings separately), tokens
and cost per accepted result, and packet precision/recall against findings.
The fixed checks and rubric keep enforcement and grading comparable across
arms.

Register these initial success thresholds before running:

- B exceeds A by at least 20 percentage points in first-pass PASS;
- B closes at least half of the A-to-R gap in critical findings;
- B exceeds C by at least 10 percentage points;
- B cost is at most half of R cost per accepted result.

These thresholds are **POLICY proposals**, not measured baselines. Run the
follow-up 20-task evaluation only if the first round clears its registered
bar. The claim that the brain brings Luna close to Opus is falsified if B is
no better than A in two rounds or B is approximately C. In either case, stop
brain packet productization and narrow the claim to a reviewed standards
source for verdict enforcement. If the Wizard-of-Oz round fails, do not build
the pipeline, index, or relay packet. A later 20-task failure also stops
expansion and requires re-review of the design before more investment.

**Evidence:** R13 reports variable benefits from few-shot examples and
curated skills, but neither cited study establishes this KRN task result. Its
local benchmark did not place retrieved text in the prompt. There is no local
evidence for the Luna-to-Opus claim; the experiment is the required test.

## Consequences

- Semantic authority is reviewable in Git; retrieval is rebuildable and
  disposable.
- Temporal queries preserve both when a claim applied and when KRN accepted
  the record revision.
- A separate repository and index per client make cross-client leakage a
  hard admission and retrieval failure.
- Rights-aware distillation adds review work, and a copy-detector result is a
  screening signal rather than legal clearance.
- Packet traces and hashes enable attribution, but do not by themselves prove
  quality gains.
- Operator promotion keeps learned policies under human control and adds PR
  latency.

## Deferred

- Implementing the v2 JSON schema, validator, SQLite/FTS5 index, ingestion
  command, inbox, or `brain.packet` integration.
- Migrating existing v1 records or deciding an automatic event/episode store
  and retention policy.
- Automatic source fetching, raw-corpus retention in Git, transcript mining,
  or automatic promotion.
- Semantic/vector retrieval, model-based ranking, and cross-client sharing.
- Expanding beyond the initial TS/review standards and course-distillation
  domains before the Wizard-of-Oz gate.
- Treating any copyright basis, detector threshold, judge result, or benchmark
  as a substitute for operator review or applicable rights.
