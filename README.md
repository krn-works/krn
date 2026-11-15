# Tallystick

Transaction/control plane wokół runtime’u Codexa. [Granica systemu](SPEC.md#cel-i-granica-systemu) określa odpowiedzialności i zakres MVP-0; implementacja jest w [src/](src/), a jej testy w [test/](test/).

[Kod](src/) · [Testy](test/) · [Kontrakty i ADR](SPEC.md) · [Reguły pracy](AGENTS.md) · [Motywacje](docs/ARCHITECTURE.md)

## Mapa rdzenia

| Moduł / kontrakt | Typy | Implementacja | Testy |
|---|---|---|---|
| [Event Ledger · R.1](SPEC.md#r1-event-ledger) | [types.ts](src/ledger/types.ts) | [ledger/](src/ledger/) | [ledger/](test/ledger/) |
| [Acquisition Adapters · R.2](SPEC.md#r2-acquisition-adapters) | [types.ts](src/adapters/types.ts) | [adapters/](src/adapters/) | [adapters/](test/adapters/) |
| [State Twin · R.3](SPEC.md#r3-state-twin) | [types.ts](src/state/types.ts) | [state/](src/state/) | [state/](test/state/) |
| [Failure Antibody Gate · R.4](SPEC.md#r4-failure-antibody-gate) | [types.ts](src/guards/types.ts) | [guards/](src/guards/) | [guards/](test/guards/) |
| [Kompozycja · R.5](SPEC.md#r5-cienkie-złożenie-w-srcindexts) | [Publiczne wejście](src/index.ts) | [src/index.ts](src/index.ts) | [integration/](test/integration/) |

## Od czego zacząć

| Potrzeba | Źródło |
|---|---|
| Uruchomić weryfikację | [Skrypty](package.json), [demo](scripts/demo.ts), [przygotowanie i zapis evidence](docs/DESKTOP-INTEGRATION-AUDIT.md#2-przygotowanie-lokalne--todo). |
| Zrozumieć język domeny i powody decyzji | [Rozróżnienia, kill-round i indeks ADR](docs/ARCHITECTURE.md). |
| Sprawdzić ustalenie audytu | [A01–A24 i F01–F15](docs/AUDIT-REGISTER.md); [korekty SD/SR](docs/RESEARCH.md#syntezy-z-10-września-2026). |
| Przygotować konkretny eksperyment | [Research i źródła](docs/RESEARCH.md); [odrębne numeracje DR](docs/RESEARCH.md#dwie-kampanie-dr). |
| Wprowadzić zmianę | [AGENTS](AGENTS.md) i [formularz PR](.github/pull_request_template.md). |
| Sprawdzić historyczny podział pracy / porządek gałęzi | [ISSUES](ISSUES.md), [checklista po merge](docs/REPOSITORY-HYGIENE.md). |
| Sprawdzić stan deweloperskiego orchestratora | [Projekt i granice](docs/orchestrator/DESIGN.md), [plan](docs/orchestrator/IMPLEMENTATION-PLAN.md), [macierz](docs/orchestrator/SECURITY-TEST-MATRIX.md), [P0 hosta](docs/orchestrator/P0-HOST-REPORT.md). Skill wymaga jawnego `$orchestrator`; alias `/orchestrator` nie jest dostarczony. Bieżące statusy P0–P5 i `enforce` są w [indeksie źródeł i statusu](docs/orchestrator/SOURCES.md); to nie jest task queue produktu. |
| Zobaczyć zatrzymane decyzje SPEC | [Diagnostyka konfliktów](docs/SPEC-CONFLICTS.md). Konflikt wymaga decyzji przed zależną implementacją. |

## Status bez skrótów

| Pytanie | Właściwy dowód lub kryterium |
|---|---|
| Co wykazał historyczny CI? | [Baseline z SHA, runem i ograniczeniami](docs/MVP-0-STATUS.md). Nie jest wynikiem dowolnego HEAD. |
| Co zmierzono w hoście? | [Raporty operatora](docs/AUDIT-REGISTER.md#raporty-operatora--oddzielna-klasa-dowodu), [kryteria S.6](docs/DESKTOP-INTEGRATION-AUDIT.md), [issue #22](https://github.com/korneliuszburian/tallystick/issues/22). |
| Co jest dopiero designem? | [Design docelowy a MVP-0](docs/ARCHITECTURE.md#design-docelowy-a-mvp-0). |

Zgodność rdzenia, kwalifikacja hosta i wartość produktu mają [trzy osobne bramki](docs/RESEARCH.md#trzy-bramki-dalszej-pracy). Zielony baseline nie jest certyfikatem całego profilu enforce.

## Nazwa i źródła prawdy

Tallystick to nazwa produktu; LEDGER pozostaje historycznym aliasem i częścią nazw technicznych. [Nazewnictwo](AGENTS.md#nazewnictwo) · [Kod, wymagania i dowody](AGENTS.md#kod-wymagania-i-dowody).

---

**Rola:** mapa. **Kiedy ten dokument traci aktualność:** po zmianie granicy produktu, struktury repo lub wskazanych źródeł; statusy wykonania zawsze wymagają własnego SHA i evidence.
