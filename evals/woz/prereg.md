# E2 preregistration — standards-packet Wizard of Oz

**Freeze:** 2026-10-08, before any A/B/C/R run. Owner: experiment lead. Consumer: E2 decision on whether task-scoped packets improve Luna; delete/supersede this transient record when that decision is recorded. Freeze tasks, packet, control, base SHA, checks and randomization before execution.

## Arms and interruption

For each paired Paperclip task compare A Luna, B Luna plus its task packet, C Luna plus matched irrelevant text, and R Opus. Hold task brief, base SHA, allowed paths, tools, time/repair caps, checks, interruption point and judge rubric constant. Randomize arm order within task. Give B/C context only as a single startup attachment. Use a fresh context per arm. B0 interruption: session 1 stops after the first behavioral falsifier is observed RED and checkpointed; session 2 is fresh and receives only repo/worktree path, issue ID and “resume,” plus normal arm material. If the first failure is setup/infra rather than an assertion on behavior, mark the interruption comparison invalid; never call it RED. Before any run record exact Luna/Opus model IDs, judge identities, worktree fingerprints and arm order.

## Outcomes

- **First-try verdict PASS (primary):** before repair, all named deterministic checks pass and both independent exact-head Standards and Spec verdicts have no blocking finding. Missing evidence is not PASS.
- **Repair rounds:** each post-verdict repair and fresh review cycle; cap 2. Unaccepted after cap stays unaccepted.
- **Judge findings:** unique P0/P1/P2 defects from first verdict and final fixed point, deduplicated by defect/severity; list nonblocking findings separately. Judges are blind to arm/model/context and one another.
- **Tokens per accepted result:** all input/output tokens across both sessions and repairs through first accepted fixed point, including packet/control. For no accepted result, report spent tokens and “no accepted result”; do not impute.
- **Escaped defects:** defects missed by named checks and both final judges but found by a predeclared post-acceptance audit of frozen diff/check surface. Apply same blinded checklist to each accepted outcome; count severity and task.
- Any packet over 2,000 estimated tokens (ceil(chars/4)), non-equal paired control length, arm leakage, or changed isolation/check fingerprint invalidates that task before outcome review.

## Thresholds (fixed before runs)

1. Packet improves first-try quality only if B has more PASS outcomes than A on at least 4/6 tasks and more than C on at least 4/6, with no additional escaped P0/P1 defect versus either.
2. “Toward Opus” requires at least 50% of pooled first-try PASS gap closed: (PASS_B − PASS_A)/(PASS_R − PASS_A). Compute only if PASS_R > PASS_A; otherwise comparison is non-discriminating. Show raw paired counts.
3. Supportive repair signal: B median repair rounds no greater than A and C; report all paired values.
4. B first-verdict blocking findings total lower than both A and C; report severity and final counts.
5. Report tokens per accepted result by arm. If B median exceeds A by >25%, describe a quality/cost trade-off, not an unqualified win. No cost win threshold.
6. Six tasks do not support a significance claim. No post-hoc exclusion or threshold changes.

## Analysis

Freeze and hash task, packet, control, base, checks and randomization manifest. Judges receive identical task acceptance contract, exact diff/head SHA and raw command/output evidence with arm/model/context labels removed. Lock blind judgments and escaped-defect audits before unblinding.

Tabulate per task/arm first-try PASS, final acceptance, repairs, first/final findings, escaped defects, tokens spent and tokens per accepted result. Compare B−A and B−C task by task, with wins/ties/losses and raw counts. Report R as reference and calculate preregistered gap closure only when defined. Show distributions, medians and totals; retain failed, blocked, invalid and missing outcomes. Interpret B vs A as packet lift, B vs C as specific relevance versus extra context, quality separately from cost. A threshold miss or invalid task does not support the claim.

## Frozen context sizes

Character count includes headings and citations; estimated tokens are ceil(characters/4). Each control is character-for-character length matched to its packet.

| Task | Packet chars | Estimated tokens | Control chars | Match |
|---|---:|---:|---:|---|
| LON-130 | 1305 | 327 | 1305 | yes |
| LON-131 | 1359 | 340 | 1359 | yes |
| LON-133 | 1178 | 295 | 1178 | yes |
| LON-20 | 1006 | 252 | 1006 | yes |
| LON-21 | 1023 | 256 | 1023 | yes |
| LON-22 | 910 | 228 | 910 | yes |
