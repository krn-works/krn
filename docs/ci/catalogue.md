# CI catalogue

Every operator-owned GitHub repository pushed since 2026-09-01 (63, archived excluded), its current CI and its migration wave onto the shared hosted CI. Inventory taken 2026-11-07 with `gh` only (read-only); task t-crxrfg4.

## Direction

The operator's later direction (2026-11-06, "CI like T3") replaced the 2026-10-30 brief to leave GitHub Actions: KRN runs on GitHub-hosted runners with parallel jobs and one aggregate `Check`, and Jenkins was destroyed. The shared CI applies that same shape to every project:

- `.github/workflows/project-ci.yml` (`workflow_call`): Plan, Lint, Typecheck and N test shards on hosted runners, tools from the caller's `mise.toml` or `.tool-versions`, actions pinned by SHA, one `Check` that fails on any failed, cancelled or unexpectedly skipped job.
- `.github/workflows/project-ci-selftest.yml` calls it on every change to either file: a green caller must pass and a caller with a failing shard must fail (first real run: PR #320).

A caller keeps its own commands and permissions; `krn-works/krn` is public, so private repositories can call it:

```yaml
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
jobs:
  ci:
    uses: krn-works/krn/.github/workflows/project-ci.yml@<sha>
    with:
      install: npm ci
      lint: npm run lint
      typecheck: npm run check
      test: npm test -- --shard=$CI_SHARD_INDEX/$CI_SHARD_TOTAL
      test-shards: 4
```

The required status check is then `ci / Check` (one ruleset entry per repository).

## Billing evidence

Four repositories have runs whose jobs never started, with the annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased": `korneliuszburian/wp-pipeline` (2026-10-12), `krn-works/wilq-seo` (2026-10-30), `Rekurencja/hasmed-2024` (2026-09-30), `Rekurencja/mise-en-plesk` (2026-09-29). Private runs succeeded again on 2026-11-07 (`krn-works/krn-ekologus-brain-lab`, `Rekurencja/ekologus-2026`), so no lock is active now. Public repositories run on hosted runners at no charge; private minutes depend on each owner's plan and spending limit, which only the operator can change. `krn-works` billing usage for 2026-10: 3005 Linux minutes, net 0.

## Waves

- **0** `krn-works/krn`: done (own `ci.yml`, ruleset `Check`).
- **1** other `krn-works` repositories: stopped 2026-11-07 by the operator (focus on KRN itself). Already onboarded and kept, each with a green `ci / Check` and a ruleset requiring it: krn-ogar, krn-portfolio, krn-onboarding-demo, krn-pokemon, krn-frontend, krn-codex-skills (main red on a PR commit without a change contract). Not onboarded: krn-ekologus-brain-lab, wilq-seo (PRs closed), krn-memory and krn-onboarding (nothing to run).
- **2** `korneliuszburian` personal repositories: not planned; only on the operator's request.
- **3** `Rekurencja` client repositories: owned by the client organisation; onboard only with the operator's explicit per-repository approval, never imposed.

## Catalogue

Runs = success/failure/cancelled in the last five runs; lock = a run blocked by billing; gate = required status checks from rulesets or classic protection.

| repo | visibility | language | pushed | workflows | runs | lock | gate | toolchain | wave |
|---|---|---|---|---|---|---|---|---|---|
| krn-works/krn | public | TypeScript | 2026-11-07 | ci.yml | 5/0/0 | no | Check | mise.toml, package.json | 0 done |
| krn-works/krn-codex-skills | private | JavaScript | 2026-11-07 | validate.yml | 3/2/0 | no | Check | package.json | 1 |
| krn-works/krn-ekologus-brain-lab | private | Python | 2026-11-07 | python-tests.yml | 5/0/0 | no | none | - | 1 |
| krn-works/krn-frontend | private | TypeScript | 2026-10-19 | ci.yml | 2/0/3 | no | none | - | 1 |
| krn-works/krn-memory | private | - | 2026-10-06 | none | 0/0/0 | no | none | - | 1 |
| krn-works/krn-ogar | private | Go | 2026-11-05 | none | 0/0/0 | no | none | go.mod, mise.toml | 1 |
| krn-works/krn-onboarding | private | JavaScript | 2026-09-10 | none | 0/0/0 | no | none | - | 1 |
| krn-works/krn-onboarding-demo | private | JavaScript | 2026-09-16 | validate.yml | 4/1/0 | no | none | package.json | 1 |
| krn-works/krn-pokemon | private | TypeScript | 2026-09-23 | ios-ipa.yml | 2/1/0 | no | none | pyproject.toml | 1 |
| krn-works/krn-portfolio | private | JavaScript | 2026-10-21 | none | 0/0/0 | no | none | - | 1 |
| krn-works/wilq-seo | private | Python | 2026-11-05 | quality.yml | 3/2/0 | yes | none | package.json, pyproject.toml | 1 |
| korneliuszburian/Pi-Agents-Team | public | TypeScript | 2026-10-14 | none | 0/0/0 | no | none | package.json | 2 |
| korneliuszburian/krn-demo-site | private | PHP | 2026-10-12 | ci.yml, deploy.yml | 1/4/0 | no | none | - | 2 |
| korneliuszburian/mise-en-plesk | private | TypeScript | 2026-09-28 | ci.yml, publish-bootstrap.yml | 5/0/0 | no | none | package.json | 2 |
| korneliuszburian/pi-voice | private | JavaScript | 2026-10-06 | none | 0/0/0 | no | krn/judge-spec, krn/judge-standards | package.json | 2 |
| korneliuszburian/pozewgen-pipeline-test | private | C# | 2026-10-26 | ci.yml, pr-guard.yml, release.yml | 2/3/0 | no | none | - | 2 |
| korneliuszburian/release-pipeline-sandbox | private | Python | 2026-10-30 | ci.yml, pr-guard.yml, release.yml | 1/0/4 | no | none | - | 2 |
| korneliuszburian/repomind | private | - | 2026-09-05 | ci.yml | 0/1/0 | no | none | - | 2 |
| korneliuszburian/seo-audit-harness | private | TypeScript | 2026-10-26 | ci.yml, mutations.yml | 3/2/0 | no | krn/judge-spec, krn/judge-standards, seo/local-verify | mise.toml | 2 |
| korneliuszburian/snorlax | private | JavaScript | 2026-09-19 | none | 0/0/0 | no | none | package.json | 2 |
| korneliuszburian/tallystick | private | TypeScript | 2026-09-10 | ci.yml | 5/0/0 | no | ledger-acceptance | package.json | 2 |
| korneliuszburian/wp-pipeline | private | Shell | 2026-10-12 | ci.yml, deploy.yml, rollback.yml, sync.yml | 1/4/0 | yes | none | - | 2 |
| Rekurencja/PozewGen | private | C# | 2026-10-23 | create_release.yaml | 5/0/0 | no | none | - | 3 |
| Rekurencja/Swieta-na-starowce | private | PHP | 2026-11-07 | none | 0/5/0 | no | none | composer.json | 3 |
| Rekurencja/Wireropes | private | PHP | 2026-10-14 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/boilerplate-rekurencja | private | PHP | 2026-10-27 | build.yml | 2/3/0 | no | none | composer.json, package.json | 3 |
| Rekurencja/bop-2026 | private | PHP | 2026-11-02 | build.yml | 3/2/0 | no | none | composer.json, package.json | 3 |
| Rekurencja/cm-komorniki | private | PHP | 2026-09-25 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/dentalcity | private | PHP | 2026-10-22 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/dentify-ofertownik-planownik | private | - | 2026-11-05 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/design-studio | private | JavaScript | 2026-11-05 | none | 0/0/0 | no | none | mise.toml, package.json | 3 |
| Rekurencja/ekologus | private | PHP | 2026-09-21 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/ekologus-2025 | private | PHP | 2026-10-15 | checks.yml | 5/0/0 | no | none | package.json | 3 |
| Rekurencja/ekologus-2026 | private | PHP | 2026-11-07 | deploy-dev2026.yml | 5/0/0 | no | none | composer.json | 3 |
| Rekurencja/ekologus-db-codex | private | HTML | 2026-10-07 | none | 0/0/0 | no | none | package.json, pyproject.toml | 3 |
| Rekurencja/ekologus-training-registration | private | PHP | 2026-09-15 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/fala-uderzeniowa-warszawa | private | PHP | 2026-09-03 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/gabinetUSG | private | HTML | 2026-11-05 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/hasmed-2024 | private | PHP | 2026-11-06 | bump-release-version.yml, release.yml | 0/5/0 | yes | none | composer.json, package.json | 3 |
| Rekurencja/hminewimplement | private | PHP | 2026-11-03 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/keystone-rozliczenia-delegacje | private | PHP | 2026-10-23 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/krn-ekologus-brain | private | Python | 2026-10-22 | quality.yml, runtime-image-candidates.yml | 0/5/0 | no | none | .tool-versions | 3 |
| Rekurencja/krn-elektroinstal-ogar | private | Python | 2026-11-05 | none | 1/0/0 | no | none | - | 3 |
| Rekurencja/lightweight-rekurencja-antyspam | private | PHP | 2026-11-06 | release-deploy.yml | 2/0/0 | no | none | composer.json | 3 |
| Rekurencja/lsn2-2026 | private | PHP | 2026-10-30 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/mariusz2 | private | PHP | 2026-10-26 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/mise-en-plesk | private | TypeScript | 2026-11-05 | none | 0/5/0 | yes | none | package.json | 3 |
| Rekurencja/multimed-2026 | private | CSS | 2026-11-05 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/multimed-scrap | private | - | 2026-10-07 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/odprawy-rekurencja | private | Python | 2026-11-06 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/podolog-2026 | private | PHP | 2026-11-05 | none | 0/0/0 | no | none | composer.json, mise.toml | 3 |
| Rekurencja/rekurencja-quota | private | JavaScript | 2026-09-23 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/rekurencja-skills | private | Python | 2026-10-29 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/rekurencja-wp-login | private | CSS | 2026-10-08 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/rekurencja2026 | private | PHP | 2026-10-16 | none | 3/2/0 | no | none | package.json | 3 |
| Rekurencja/rqrecorderproject | private | HTML | 2026-09-09 | none | 5/0/0 | no | none | package.json | 3 |
| Rekurencja/sawaryn-i-partnerzy | private | PHP | 2026-11-07 | none | 1/0/0 | no | none | composer.json, mise.toml, package.json | 3 |
| Rekurencja/segeworld-2026 | private | PHP | 2026-11-04 | none | 3/2/0 | no | none | composer.json, package.json | 3 |
| Rekurencja/sklep-ekologus-ogar | private | PHP | 2026-10-01 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/swieta-na-starowce-2026-hq | private | Python | 2026-10-16 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/usg-warszawa | private | PHP | 2026-09-25 | none | 0/0/0 | no | none | package.json | 3 |
| Rekurencja/vc.rekurencja.com | private | Shell | 2026-09-06 | none | 0/0/0 | no | none | - | 3 |
| Rekurencja/wilmed | private | PHP | 2026-11-05 | none | 0/0/0 | no | none | composer.json, package.json | 3 |
