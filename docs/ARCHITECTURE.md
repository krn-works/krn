# Tallystick — decyzje i motywacje architektury

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** uzasadnienia decyzji i indeks ADR · **Status:** ADR — ZAMROŻONE w SPEC; design docelowy oznaczony osobno
> **Właściciel:** maintainer architektury · **Konsument:** implementer i reviewer potrzebujący motywacji decyzji
> **Zakres:** motywacje projektu; nie bieżący stan implementacji
> **Źródła:** [SPEC](../SPEC.md), S-ANALIZA §§1–2, 8–18, 19–30, 42–46 z [manifestu źródeł](RESEARCH.md#pochodzenie-materiałów)
> **Kiedy ten dokument traci aktualność:** po jawnej zmianie decyzji; historycznych motywacji nie przepisujemy, a stan implementacji sprawdzamy oddzielnie.

## Problem i granica produktu

W S-ANALIZA §1 pytanie wyjściowe dotyczy klas awarii, które zewnętrzny harness ma eliminować albo wykrywać, nie „większej pamięci” agenta. §§10–12 nazywają ten design **LEDGER**. W obecnej dokumentacji produkt nazywa się **Tallystick**; to porządek redakcyjny, nie zmiana architektury ani drugi system.

Transcript dowodzi, co agent powiedział; raw archive — jakie bajty przechwycono; derived memory — jaki wniosek zapisano; pomiar świata — co sprawdzono dla określonych wejść; assembled context — co wybrano do bieżącej decyzji. Dlatego odzyskiwalny log nie dowodzi prawdy każdej zawartej w nim wypowiedzi. Kanoniczne rozróżnienia: [SPEC R.0](../SPEC.md#r0-zakres-środowisko-i-struktura); motywacja: S-ANALIZA §§1, 15–18.

Codex prowadzi runtime. Tallystick nie przejmuje inference, nie staje się provider wrapperem i nie zastępuje wiedzy o repo odpowiedzią modelu. Motywację tego podziału opisuje S-ANALIZA §35; kontrakt: [granica systemu](../SPEC.md#cel-i-granica-systemu).

## Jakie awarie motywują design

Poniższa mapa zachowuje identyfikatory i znaczenie P1–P10 z S-ANALIZA §2. Nie jest listą dziesięciu wdrożonych funkcji.

| Patologia | Brakująca własność | Gdzie leży odpowiedź w designie |
|---|---|---|
| P1 · złota rybka | Doświadczenie adresowalne poza jedną sesją | Lifecycle persistent memory; poza MVP-0. |
| P2 · lost in the middle | Umieszczenie dowodu według roli w decyzji | Context Atlas; poza MVP-0. |
| P3 · context bloat | Ograniczony working set przy rosnącej historii | Bounded digest w MVP-0; pełny context workspace poza nim. |
| P4 · stratna kompresja | Ominięty szczegół ma odzyskiwalne źródło | Raw archive; pełny Compression Contract poza MVP-0. |
| P5 · context drift | Wykrywalny brak przyrostu informacji i odejście od celu | Docelowa telemetria dryfu; nie zastępuje pomiaru stanu. |
| P6 · halucynowany stan | Aktualne twierdzenie oparte na właściwych zależnościach | State Twin; docelowy Claim Publisher osobno. |
| P7 · śmietnik narzędzi | Capture przed admission dużego outputu | Acquisition Adapters i Event Ledger. |
| P8 · pętle narzędziowe | Blokada równoważnej porażki przed procesem | Failure Antibody Gate. |
| P9 · brak odzysku | Aktywny widok nie jest jedyną kopią historii | Raw archive; pełny Recovery Engine poza MVP-0. |
| P10 · pamięć bez testu compoundingu | Korzyść zmierzona względem memory-off | Compounding Evaluator; poza MVP-0. |

## Kill-round: dlaczego te mechanizmy pozostały

Źródło: S-ANALIZA §§6–9. Nazwy C oznaczają historyczne kandydatury, nie moduły ani nowe API. Estymaty kosztowe kill-round nie były pomiarami.

| Kandydatura | Najmocniejszy kontrargument | Rozstrzygnięcie i przyjęty trade-off |
|---|---|---|
| C01 · Receipt Log | SQLite i dowolny proces nie tworzą wspólnej transakcji. | Zachowany z UNKNOWN i reconciliation, bez obietnicy exactly-once; [ADR-003](../SPEC.md#adr-003--nieznany-wynik-wykonania-nie-uprawnia-do-retry). |
| C02 · Epoch Twin | Hash może nie obejmować rzeczywistych preconditions. | Zachowany z jawnymi zależnościami i fingerprintem środowiska; pomiar niekompletnego zbioru nie daje wiedzy o całym świecie. |
| C04 · Context Atlas | Poprawna mapa nie gwarantuje pobrania właściwej strony. | Zachowany w designie tylko z required evidence slots, recovery trigger i promotion; poza MVP-0. |
| C11 · Evidence Membrane | Parser może pominąć jedyną ważną linię. | Zachowana z raw, completeness, parser status i source handles; unknown nie może udawać rozpoznanego wyniku. |
| C12 · Failure Antibody | Zbyt szeroka równoważność blokuje sensowne retry. | Zachowany z precondition epoch, exact normalization, escape proof i rozróżnieniem relevant/irrelevant change. |

### Kierunki odrzucone

| Kandydatury / kierunek | Powód odrzucenia w S-ANALIZA §8 |
|---|---|
| C03 · Snapshot Flood | Manifesty, CAS i zależności miały osiągnąć potrzebną własność taniej niż snapshot przed każdą akcją. |
| C05 · Generational Notes | Wiek/częstotliwość nie dowodzą utility; często pobierany błąd może „dojrzeć”. |
| C06 · Tail Ring | Recency nie jest relevance; stały ogon może usunąć aktywne ograniczenie. |
| C07 · Twin Brains; C18 · Consensus Memory | Modele mogą współdzielić błąd; consensus nie daje prawdy i tworzy drugi system agentowy. |
| C08 · PID Context | Regulacja proxy i ryzyko oscylacji zamiast ochrony informacji. |
| C09 · Shadow Everything | Koszt i ryzyko podwójnych efektów; paired evaluation ma być kontrolowanym eksperymentem. |
| C10 · Memory Auction | Ranking/budżet bez nowego invariantu oraz ryzyko Goodharta. |
| C13 · Zero History | Reset po każdym narzędziu niszczy continuity i ponowne wykorzystanie cache. |
| C14 · AST Only | Nie każda informacja ma stabilny schemat; powstaje nowy DSL i nowa powierzchnia awarii. |
| C15 · Verify Everything | Globalna walidacja wywołuje koszt I/O; zachowano selektywną rewalidację. |
| C16 · Syscall Archive | Nieuzasadniony koszt storage, prywatności i analizy; zachowano kontrolowane tool I/O. |
| C17 · Edge Replication | Powielanie critical content tworzy bloat i konflikty świeżości. |

Większe context window, jedno globalne summary jako truth i vector-memory-only nie rozwiązują źródeł, aktualności ani prawa do retry; uzasadnienia: S-ANALIZA §§31–41. Research nowych narzędzi nie reaktywuje tych kierunków bez nowego evidence i decyzji.

## Indeks ADR

Reguły, uzasadnienia i supersesje mają **jedną kanoniczną kopię w SPEC**. Poniżej jest nawigacja, nie druga specyfikacja.

| Decyzja | Temat |
|---|---|
| [ADR-001](../SPEC.md#adr-001--epoka-świata-jest-oddzielona-od-rewizji-wiedzy) | Epoka świata i rewizja wiedzy |
| [ADR-002](../SPEC.md#adr-002--enforcement-działa-fail-closed) | Fail-closed |
| [ADR-003](../SPEC.md#adr-003--nieznany-wynik-wykonania-nie-uprawnia-do-retry) | UNKNOWN i reconciliation |
| [ADR-004](../SPEC.md#adr-004--dowód-poprzedza-admission) | Dowód przed admission |
| [ADR-005](../SPEC.md#adr-005--hot-path-jest-deterministyczny) | Deterministyczny hot path |
| [ADR-006](../SPEC.md#adr-006--kolejność-implementacji-jest-zamrożona) | Kolejność implementacji |
| [ADR-007](../SPEC.md#adr-007--kompletność-capture-jest-własnością-eventu-nie-blobu) | Kompletność capture |
| [ADR-008](../SPEC.md#adr-008--changed_artifacts-z-lokalnego-pomiaru-filesystem-nie-z-komunikatu-procesu) | Pomiar changed_artifacts |
| [ADR-009](../SPEC.md#adr-009--blobref-niesie-strumień-źródła) | Tożsamość strumienia źródła |
| [ADR-010](../SPEC.md#adr-010--receipt_id-wskazuje-zatwierdzone-zdarzenie-evidence-w-ledgerze) | Historyczny receipt adapterów |
| [ADR-011](../SPEC.md) | Epoka zależności requestu |
| [ADR-012](../SPEC.md#adr-012--state-twin-jest-wiązany-z-ledgerem-przy-konstrukcji) | Konstrukcja State Twin |
| [ADR-013](../SPEC.md#adr-013--gate-jest-wiązany-ze-storage-przy-konstrukcji) | Konstrukcja Gate i storage |
| [ADR-014](../SPEC.md#adr-014--escape-proof-jest-podpisany-kluczem-harnessu) | Podpis escape proof |
| [ADR-015](../SPEC.md#adr-015--transakcja-gate-działa-na-połączeniu-ledgera) | Transakcja Gate na połączeniu Ledgera |
| [ADR-016](../SPEC.md#adr-016--kompozycja-middleware-zużycie-permit-klucz-i-obwoluta-receipt) | Kompozycja, permit, klucz i receipt |
| [ADR-017](../SPEC.md#adr-017--limit-raw-zatrzymuje-proces-podczas-strumieniowego-capture) | Limit raw podczas capture |
| [ADR-018](../SPEC.md#adr-018--demo-uruchamia-skompilowane-artefakty) | Demo ze skompilowanych artefaktów |

**Historia, nie nowe decyzje:** ADR-015 zastępuje klauzulę ADR-013 o osobnym połączeniu Gate. ADR-010 zachowuje ówczesny plan osobnego receipt eventu, natomiast ADR-016 opisuje obwolutę w pamięci bez nowego rodzaju zdarzenia. Instrukcję uruchomienia source TypeScript z ADR-016 zastępują ADR-018 i S.4. ADR-011 w historycznym SPEC jest akapitem, nie nagłówkiem; odsyłacz celowo prowadzi do dokumentu, nie do nieistniejącej kotwicy.

## Design docelowy a MVP-0

Zakres implementacyjny wyznacza [R.0](../SPEC.md#r0-zakres-środowisko-i-struktura), a nie poniższe ambicje. S-ANALIZA §§42–46 uzasadnia pionowy wycinek czterech deterministycznych modułów; ich kompozycja nie jest piątym modułem. Obecność typów pamięci w SPEC nie oznacza gotowej pamięci semantycznej.

| Przyjęty design poza MVP-0 | Motywacja źródłowa | Co trzeba wykazać przed deklaracją działania |
|---|---|---|
| L1/L2/L3, Context Atlas i 16000-tokenowy workspace | S-ANALIZA §§19–20: mały working set nad większą przestrzenią źródeł; budżet dotyczy workspace, nie wnętrza Codexa. | Required evidence, routing i wpływ położenia przy tym samym budżecie; [DR-14](RESEARCH.md#dr-14-context-atlas-i-obowiązkowe-evidence-dla-następnej-decyzji). |
| Compression Contract i Recovery Engine | §§21–22: zmiana dostępności nie może usunąć jedynego źródła. | Exact recovery wskazanych bajtów i zakresu, również bez L2; [DR-13](RESEARCH.md#dr-13-compaction-jako-nowy-widok-nie-utrata-źródła). |
| Persistent Memory lifecycle | §24: provenance, scope, niedestrukcyjne wersje; ważność zależności nie jest prawdą claim ani utility. | Konflikty, stale/quarantine/tombstone i granica dopuszczenia; [DR-07](RESEARCH.md#dr-07-knowledge-sandbox-dependency-validity-nie-równa-się-claim-truth). |
| Compounding Evaluator i utility promotion | §§25–29: wzrost store nie jest learningiem; stała przewaga nie jest rosnącą przewagą. | Paired memory-on/off, koszty i correctness; [DR-08](RESEARCH.md#dr-08-eksperyment-compounding-memory-on-kontra-memory-off). |
| Claim Publisher, drift detectors i dodatkowe adaptery | §§23, 27, 30, 46: jawne braki dowodów, stagnacja i publication boundary. | Właściwe kontrakty i testy, nie kolejny globalny summarizer. |

Progi 10× i promocji w S-ANALIZA są **kryteriami/targetami designu, nie osiągniętymi wynikami**. Syntezy A–Z opisują również otwarte szczegóły (tworzenie i okres próbny pamięci, ranking, podłączenie kontekstu); nie zamrażają ich przez sam opis. Sekwencja researchu nie zmienia [ADR-006](../SPEC.md#adr-006--kolejność-implementacji-jest-zamrożona).

## Dowody i ograniczenia

Stan biblioteki: [baseline](MVP-0-STATUS.md). Ryzyka i konkretne reprodukcje: [rejestr audytu](AUDIT-REGISTER.md). Kryteria rzeczywistego hosta: [audyt integracji](DESKTOP-INTEGRATION-AUDIT.md). Ta notatka nie nadaje żadnemu z tych obszarów nowego PASS.
