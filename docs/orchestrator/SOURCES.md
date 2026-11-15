# Orchestrator — źródła i status dowodów

> **Rola:** indeks źródeł dla deweloperskiego harnessu orchestratora
> **Status:** `DRAFT`; nie jest źródłem normatywnym
> **Właściciel:** maintainer orchestratora · **Konsument:** reviewer DESIGN i IMPLEMENTATION-PLAN
> **Zakres:** identyfikatory użyte w `DESIGN.md`; funkcja task queue Tallysticka jest poza zakresem
> **Źródła normatywne:** [SPEC](../../SPEC.md), [AGENTS](../../AGENTS.md)
> **Kiedy traci aktualność:** po zmianie hosta, SPEC albo zakresu harnessu.

Identyfikatory `R*` wskazują sekcje bieżącego repozytorium; `S*` wskazują wymagania/testy lub zewnętrzne materiały opisane w dokumentach. Ten indeks nie zamienia hipotezy w dowód działania.

| ID | Znaczenie | Źródło / status |
|---|---|---|
| R1 | Codex jako runtime, bez provider loop | `SPEC.md` cel i granica systemu — normatywne |
| R2 | Cztery moduły MVP-0 i brak LLM hot path | `SPEC.md` R.0, ADR-005 i ADR-006 — normatywne |
| R3 | Granica middleware przed spawn | `SPEC.md` R.5, S.6 — normatywne; host enforce niezweryfikowany |
| R4 | Evidence przed admission | `SPEC.md` ADR-004, R.1/R.5 — normatywne |
| R5 | Statusy BLOCK/UNKNOWN/EXECUTED i receipt | `SPEC.md` R.5 oraz bieżące API `src/index.ts` — implementacja do weryfikacji |
| S1 | Katalog modeli i hosta | [Raport operatora P0](P0-HOST-REPORT.md) — katalog reklamowany; exact child model UNKNOWN |
| S2 | Natywna delegacja Codexa | [Raport operatora P0](P0-HOST-REPORT.md) — operator-reported: delegacja zaobserwowana; izolacja child: FAIL (zaobserwowany brak read-only), model child: UNKNOWN |
| S3 | Limity dzieci i delegacji | Propozycja harnessu — prompt/organizational policy, nie host enforcement |
| S4 | Konto Pro i brak założenia o API quota | [Raport operatora P0](P0-HOST-REPORT.md) — OpenCode credential jest osobne; brak utożsamienia z Codex Pro |
| S5 | Koszt i benchmark | `DESIGN.md` §11 oraz plan P5 — NOT_RUN |
| S6 | Audyt ścieżki desktop | `docs/DESKTOP-INTEGRATION-AUDIT.md`, `SPEC.md` S.6 — P1 BLOCKED; P2 BLOCKED/NOT_RUN |
| S7 | Integracja App Server/MCP | `docs/DESKTOP-INTEGRATION-AUDIT.md` — wymaga odrębnego audytu |
| S8 | Hooki i granice pokrycia | `docs/DESKTOP-INTEGRATION-AUDIT.md` — zakres audytu; konkretne zachowanie hosta NOT_AVAILABLE |
| S9 | Worktree/sandbox i sekrety | `AGENTS.md`, macierz bezpieczeństwa i [raport P0](P0-HOST-REPORT.md) — operator-reported child sandbox FAIL (zaobserwowany brak read-only); zakres modelu/coverage BLOCKED |
| S10 | Rejestr postępu | Kontrakt harnessu — NOT_IMPLEMENTED |
| S11 | Jedyny writer | Plan P3 — BLOCKED do czasu P2 |
| S12 | Zagrożenia komunikacji agentów | NOT_AVAILABLE w tym repozytorium; scenariusz do przyszłego źródła i pomiaru |
| S13 | Zagrożenia presji na wynik | NOT_AVAILABLE w tym repozytorium; scenariusz do przyszłego źródła i pomiaru |
| S14 | Benchmark wariantów | Plan P5 — NOT_RUN |
