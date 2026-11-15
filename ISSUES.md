# Tallystick — historyczna mapa etapów

[Start](README.md) · [Kontrakty](SPEC.md) · [Reguły pracy](AGENTS.md)

> **Rola:** mapa historycznej decyzji o kolejności. **Status:** ARCHIWUM.  
> **Zakres:** pierwotny podział MVP-0 na pięć etapów, nie numery bieżących GitHub Issues.  
> **Źródło:** [pełny pierwotny plan na SHA ddc81034](https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/ISSUES.md).  
> **Kiedy ten dokument traci aktualność:** nigdy nie jest potwierdzeniem bieżącego postępu; zmianę odsyłaczy lub interpretacji etapów trzeba sprawdzić względem SPEC.

## Etapy i źródła wymagań

| Dawny etap | Cel | Zależność | Kontrakt kanoniczny |
|---|---|---|---|
| #1 · `module:ledger` | Event Ledger | Brak | [R.1](SPEC.md#r1-event-ledger) |
| #2 · `module:adapters` | Acquisition Adapters | Zielona bramka #1 | [R.2](SPEC.md#r2-acquisition-adapters) |
| #3 · `module:state` | State Twin | Zielone bramki #1–#2 | [R.3](SPEC.md#r3-state-twin) |
| #4 · `module:guards` | Failure Antibody Gate | Zielone bramki #1–#3 | [R.4](SPEC.md#r4-failure-antibody-gate) |
| #5 · `type:e2e` | Kompozycja, E2E i chaos | Zielone bramki #1–#4 | [R.5](SPEC.md#r5-cienkie-złożenie-w-srcindexts), [S](SPEC.md#s-mvp-0-acceptance-tests) |

Kolejność i warunki przejścia określa [ADR-006](SPEC.md#adr-006--kolejność-implementacji-jest-zamrożona). Pierwotne zakresy, tabele asercji, `state_observations` i komendy zachowano w podlinkowanym archiwum; nie są drugą aktywną kopią kontraktu.

## Granica użycia

Aktualne zadania: [GitHub Issues](https://github.com/korneliuszburian/tallystick/issues). Dowody wykonania: [baseline](docs/MVP-0-STATUS.md) i [rejestr audytu](docs/AUDIT-REGISTER.md). Kryteria wdrożenia: [S.6](SPEC.md#s6-dodatkowa-bramka-wdrożenia--poza-mvp-0).

Ten plik nie nadaje zadaniom statusu ukończonego i nie mapuje historycznego „#5” automatycznie na GitHub issue #5.
