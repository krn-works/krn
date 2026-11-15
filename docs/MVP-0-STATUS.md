# Tallystick — baseline MVP-0

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** dowód historyczny i jego ograniczenia · **Status:** PASS BIBLIOTEKI DLA WSKAZANEGO RUNA; nie PASS S.6
> **Właściciel:** maintainer baseline’u · **Konsument:** operator odczytujący historyczne evidence
> **Zakres:** audyt 2026-09-08; commit `0683f1dc006c37d9c05cb69e054e6bf4a5976a45`
> **Źródła:** [run 34231830068](https://github.com/korneliuszburian/tallystick/actions/runs/34231830068), [job 102079623149](https://github.com/korneliuszburian/tallystick/actions/runs/34231830068/job/102079623149)
> **Kiedy ten dokument traci aktualność:** dokument pozostaje historycznym dowodem; każdy inny SHA, kod, SPEC, lockfile, CI, host lub środowisko wymaga własnej weryfikacji.

## FACT — zakres i identyfikacja dowodu

Audyt GitHub: **8 września 2026 r.** Ten dokument jest historycznym baseline, nie ruchomym wskaźnikiem ostatniego zielonego commitu.

| Pole | Zweryfikowana wartość |
|---|---|
| Repozytorium | `korneliuszburian/tallystick` |
| Default branch w chwili audytu | `main` |
| Pełny SHA main | `0683f1dc006c37d9c05cb69e054e6bf4a5976a45` |
| Zdarzenie | Merge PR #20, 2026-09-08 13:25:02 UTC |
| Workflow | `LEDGER CI`, run #103, ID `34231830068` |
| Check / job | `ledger-acceptance`, ID `102079623149` |
| Wynik | `completed / success`, 2026-09-08 13:25:31 UTC |
| Środowisko z logu | Ubuntu 24.04; Node 24.20.0; npm 11.19.0; Git 2.55.0 |

Dowody pierwotne: [commit main](https://github.com/korneliuszburian/tallystick/commit/0683f1dc006c37d9c05cb69e054e6bf4a5976a45), [run CI](https://github.com/korneliuszburian/tallystick/actions/runs/34231830068), [job i log](https://github.com/korneliuszburian/tallystick/actions/runs/34231830068/job/102079623149). Wyniki sprawdzono w logu main, nie wyłącznie w opisie PR #20. Retencja logów może ograniczyć późniejszą dostępność; brak odczytywalnego logu nie jest nowym potwierdzeniem PASS.

## FACT — moduły i testy

| Moduł / etap | Publiczna odpowiedzialność | Test suite | Wynik baseline |
|---|---|---|---|
| Event Ledger | `openLedger`: append-only events, raw CAS, integralność i odzyskiwalne źródła. | `npm run test:ledger` | PASS, 19/19 |
| Acquisition Adapters | `createAdapters`: shell, test-runner, compiler, git-diff; raw capture i bounded typed digest. | `npm run test:adapters` | PASS, 12/12 |
| State Twin | `createStateTwin`, `computeStateEpoch`, `epochFor`, `revalidateMemory`: pomiar świata i preconditions. | `npm run test:state` | PASS, 35/35 |
| Failure Antibody Gate | `createFailureGate`, `fingerprint`, preflight i failure records: reservations, permits i blokowanie powtórek. | `npm run test:guards` | PASS, 15/15 |
| Middleware + E2E/chaos/demo | `createLedgerMiddleware` w `src/index.ts`: cienka kompozycja, receipt i testy całej ścieżki, bez piątego modułu. | `npm run test:e2e` | PASS, 12/12 |

Łącznie **93/93 testy**. W logu są wszystkie pięć suit w wymaganej kolejności, bez pominięcia któregoś etapu. `npm ci` i `npx --no-install tsc --noEmit` przeszły. Test E2E uruchomił literalne `npm run demo` i otrzymał `All three deterministic demo scenarios passed.`

**FACT — granica twierdzenia:** w CI wykonano łańcuch pięciu skryptów odpowiadający `test:acceptance`; osobnego literalnego wywołania wrappera `npm run test:acceptance` nie ma w tym logu. `verify` dodany w porządkowym PR nie istniał w tym SHA i nie ma wyniku w historycznym baseline. Wyniki nowego PR należy czytać w jego własnych checkach.

Status release-baseline: deterministyczny vertical slice MVP-0 był zintegrowany na main i przeszedł repozytoryjną bramkę testową tego SHA. Nie jest to niezależny formalny dowód braku wszelkich defektów ani potwierdzenie realnej integracji enforce.

## Indeks ADR-001–ADR-018

Indeks przeniesiono do [decyzji i motywacji](ARCHITECTURE.md#indeks-adr). Wszystkie ADR pozostają w [SPEC](../SPEC.md), bez zmiany treści. Zachowano historię ADR-013/015, ADR-010/016 i ADR-016/018; nie powstaje druga kopia reguł.

## FACT — granice MVP-0

Normatywne źródła: [SPEC R.0, R.1–R.5, S.1–S.6](../SPEC.md) i [AGENTS](../AGENTS.md).

Dowód obejmuje cztery moduły, cztery acquisition adapters oraz middleware, E2E/chaos i demo. `MemoryRecord` do revalidation nie oznacza wdrożenia persistent semantic memory. Rozdzielenie transcript, persistent memory, verified world state, tool observations i learned experience określa R.0.

Poza tym wycinkiem pozostają Context Atlas/pełny Context Assembler, Recovery Engine, persistent semantic memory i jej lifecycle, utility promotion, Compounding Evaluator, adaptery file-read/directory/search/HTML i rzeczywisty audyt Codex/MCP. [Design docelowy](ARCHITECTURE.md#design-docelowy-a-mvp-0) nie jest deklaracją implementacji.

Nie ma gwarancji wspólnej transakcji exactly-once ani atomowego rollbacku Git, SQLite i zewnętrznych efektów procesu. UNKNOWN nie daje prawa do automatycznego retry; źródło: [SPEC R.5](../SPEC.md#r5-cienkie-złożenie-w-srcindexts).

## Ograniczenia, TODO i BLOCKED

| Status historycznego baseline | Ograniczenie / dług | Dalsze postępowanie |
|---|---|---|
| TODO / BLOCKED | S.6 nie ma w tym baseline dowodu z realnego Codexa/MCP. | [Kryteria](DESKTOP-INTEGRATION-AUDIT.md) i późniejszy [rejestr](AUDIT-REGISTER.md); brak automatycznego transferu wyników między profilami. |
| FACT / RESOLVED | PR #28 (`merge 1f22a3604313b7c86cbeaee513ba58805b32c000`, head `37234a979a42d509203cc3d12c9e6f32c1d1de10`) usunął warunkowe pomijanie suit: CI uruchamia pięć suit, `demo` i typecheck bez warunków; brak katalogu lub fixture kończy check błędem. Check `ledger-acceptance` dla tego PR: run `34473967108`, job `102860178621`. | Utrzymywać wymagany check `ledger-acceptance`; zmiany workflow wymagają osobnego PR. |
| FACT / TODO | Dowód dotyczy Ubuntu/Node/npm z tabeli; demo używa `rm -rf`, a storage wymaga lokalnego filesystemu i jednego writera. | Zmierzyć środowisko, zależności natywne, shell i SQLite z better-sqlite3. |
| FACT / TODO | `.gitignore` baseline obejmuje `.demo-dist/` i `node_modules/`. | Baza, CAS, logi i `<databasePath>.harness-key` poza wersjonowanym worktree; bez sekretów w repo. |
| FACT / TODO | `ISSUES.md` opisuje historyczne etapy #1–#5, nie bieżące GitHub Issues. | [Mapa etapów](../ISSUES.md) odsyła do niezmiennego oryginału i SPEC. |
| FACT / TODO | W instalacji wystąpiły ostrzeżenia o prebuild-install i skrypcie better-sqlite3 mimo exit 0. | Sprawdzić rzeczywistą instalację oraz politykę skryptów; nie aktualizować zależności w porządkowym PR. |

Źródło ograniczeń: [niezmienny zapis pierwotnego baseline](https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/docs/MVP-0-STATUS.md). Późniejsze raporty operatora o npm 12 i udanym baseline są w [rejestrze](AUDIT-REGISTER.md); nie przepisują tej historii.

## Historyczny audyt porządku repo

Przeniesione z [REPOSITORY-HYGIENE na SHA ddc81034](https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/docs/REPOSITORY-HYGIENE.md). To obserwacje z **2026-09-08**, nie nowy odczyt ustawień ani zgoda na usuwanie gałęzi.

W chwili audytu przed porządkowym PR nie było otwartych PR/issues; `main` miało `protected: false`, auto-merge było wyłączone, a `delete_branch_on_merge: false`. Dla main `0683f1dc006c37d9c05cb69e054e6bf4a5976a45` poniższe heads miały `ahead_by=0`. To zapis historyczny, nie aktualny stan refów.

| Gałąź | Sprawdzony HEAD | Wynik historyczny |
|---|---|---|
| `bootstrap-ledger` | `74a937a5bc68fe1fd2ca6e752fdb9668adddd338` | Zawarta w main. |
| `ledger/issue-2-spec-conflict-capture` | `d534c2f97ddaec4a9a1178a56ebc3c1b18b9d3e2` | Zawarta w main. |
| `codex/handle-environment-setup-for-event-ledger` | `4869d74dcb0754d7f0eb2ea0c1b134f15323ae8f` | Zawarta w main. |
| `codex/implement-acquisition-adapters` | `113cd727c28647a1a6f601d510b4c30c9e38cba9` | Zawarta w main. |
| `codex/implement-state-twin` | `1afea8e3abdbc5a0c6640d6a063f9e0ff18b33ec` | Zawarta w main. |
| `codex/implement-failure-antibody-gate` | `a793a4a2f477f9066d8cf127b90ab3d572cdc4eb` | Zawarta w main. |
| `codex/issue-6-e2e-chaos` | `5756e8283f0c7ec8d9115a00145663f06061bdcd` | Zawarta w main. |

Wyjątek: `codex/implement-event-ledger-according-to-adr-007`, SHA `0acd2177030a16fd7f80fb5988dbacf42538b87d`, PR #15: **2 unikalne commity i 58 commitów opóźnienia**. PR zamknięto bez merge; późniejszy PR #16 nie dowodzi zawarcia tych dwóch commitów.

Historyczna sesja zgłosiła brak operacji usuwania gałęzi w connectorze i podała ścieżkę „GitHub mobile → repo → Branches → Delete”. Zachowujemy tę obserwację z jej datą, nie jako dzisiejszą instrukcję narzędziową. Późniejsze PR #27 i #28 usunęły scalone oraz zastąpione refy; po PR #28 `main` ma wymagany check `ledger-acceptance`, a `delete_branch_on_merge` jest włączone. Aktualny stan należy sprawdzać w GitHub, nie przepisywać z tej tabeli.

## Kiedy dokument przestaje być aktualnym potwierdzeniem

Dokument nadal opisuje historyczny SHA. Nowy baseline potrzebuje własnego SHA, runa i odczytanych logów. Zmiana kodu, testów, SPEC, lockfile, CI, narzędzi, platformy, konfiguracji hosta lub execution paths unieważnia transfer wyniku. S.6 dodatkowo wiąże wersję/config Codexa/MCP i zbadany zbiór ścieżek.

Niedostępny dowód lub nieobserwowalna granica nie stają się PASS na podstawie tego dokumentu. Zasady klasyfikacji: [AGENTS](../AGENTS.md#wyniki-i-evidence).
