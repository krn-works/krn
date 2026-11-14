# Tallystick — porządek gałęzi po merge

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** kryterium operacyjne · **Status:** CHECKLISTA
> **Właściciel:** maintainer repozytorium · **Konsument:** operator sprzątający refs po merge
> **Zakres:** pojedynczy zatwierdzony merge
> **Źródła:** [AGENTS — porządek gałęzi](../AGENTS.md#porządek-gałęzi-po-merge)
> **Kiedy ten dokument traci aktualność:** po zmianie procedury w AGENTS lub któregokolwiek porównywanego ref; stary wynik nie uprawnia do nowego usunięcia.

## Cel

Zapisać wykonanie kontroli po merge. Reguły dopuszczenia operacji są wyłącznie w [AGENTS.md](../AGENTS.md#porządek-gałęzi-po-merge).

## Kontrole

- [ ] Zapisano PR, merge commit i aktualne SHA `main` oraz head branch.
- [ ] Sprawdzono linked issues, closing keywords i superseded PR; zapisano wykonane czynności albo powód pozostawienia obiektu otwartego.
- [ ] Zapisano wynik porównania gałęzi oraz decyzję zgodną z regułą w AGENTS.
- [ ] Zapisano zgodę właściciela i rezultat operacji na gałęzi albo konkretny BLOCKED.

| PR / gałąź | SHA main / head | Dowód porównania | Zgoda i czynność | Wynik |
|---|---|---|---|---|
| Historyczny PR #27/#28 · `chore/repository-hygiene`, `ci/strict-acceptance-gates` | `main=1f22a36`, heady `8508e9d` / `37234a9` | Oba heady scalone exact-head; wpis zachowuje wynik z poprzedniego przebiegu | Zgoda właściciela; usunięto zdalne i lokalne gałęzie bez aktywnego worktree | HISTORYCZNE |
| PR #31 · `fix/runtime-audit-safe-findings` | `main=ec9829d42441ffb026fa4131b5077177d943a25a`, head `9332a816b9ac5990344094c4dbb14a6fdf413b7e` | Squash commit na `main` ma wymagane checki `ledger-acceptance` (run `34497947667`, job `102941093927`; run `34497914647`, job `102941041169`, odczyt 2026-09-10); `git diff --quiet 9332a816b9ac5990344094c4dbb14a6fdf413b7e ec9829d42441ffb026fa4131b5077177d943a25a` potwierdza identyczne drzewo, a porównanie historii jest `diverged` przez squash merge; GitHub nie pokazuje już gałęzi | Jawne polecenie właściciela z przebiegu audytu; usunięto wyłącznie lokalny stale remote-tracking ref, bez force-delete i bez usuwania evidence | WYKONANO |
| PR #32 · `docs/curate-and-pin-state` | `main=ef3a490f1f1398e6cfaab8b03f25b0f8cce4b233`, head `0e5a1c7bd404892f05850d0b76b834bdd1c37c44` | Squash merge po zielonych checkach `ledger-acceptance` (run `34503666527`, job `102960388969`; run `34503690442`, job `102960473973`); `git diff --quiet 0e5a1c7bd404892f05850d0b76b834bdd1c37c44 ef3a490f1f1398e6cfaab8b03f25b0f8cce4b233` potwierdza identyczne drzewo, a rozbieżność historii wynika z squash merge | Zgoda właściciela; zdalny branch usunięty przez ustawienie `deleteBranchOnMerge`, bez usuwania evidence | WYKONANO |
| PR #33 · `docs/refresh-current-state` | `main=e6fa3c29d810cbf08856e98498f18375ef20c3b3`, head `cb41a796a0391622d7061784fe474599329c2ff1` | Squash merge po dwóch zielonych checkach `ledger-acceptance` (run `34504724721`, job `102963943900`; run `34504730513`, job `102963964321`); porównanie exact tree było częścią kontroli merge | Zgoda właściciela; branch usunięty przez `deleteBranchOnMerge`, bez usuwania evidence | WYKONANO |

## Dowody historyczne

Tabela heads, wyjątek PR #15 i obserwacje ustawień z 8 września 2026 są w [baseline](MVP-0-STATUS.md#historyczny-audyt-porządku-repo). Nie są aktualną listą gałęzi do usunięcia. Odczyt z 2026-09-10 po PR #33 (snapshot przed PR #34): `main=origin/main=e6fa3c29d810cbf08856e98498f18375ef20c3b3`, jeden worktree, brak dodatkowych refów po `git remote prune origin`; w tym snapshotcie GitHub nie miał otwartych PR, a PR #33 był scalony. Odczyt ustawień GitHub potwierdził `deleteBranchOnMerge=true`, strict `ledger-acceptance`, `enforce_admins=true` oraz wyłączone force-push i deletion. Przy kolejnym sprzątaniu nadal wykonaj bieżący odczyt GitHub.
