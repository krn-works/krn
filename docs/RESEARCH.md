# Tallystick — research i eksperymenty

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** kryteria badań · **Status:** REKOMENDACJA — NIEZAMROŻONE
> **Właściciel:** maintainer researchu · **Konsument:** właściciel decyzji i implementer eksperymentu
> **Zakres:** pakiet z 9 września i syntezy z 10 września 2026; cutoff raportów: 9 września; nie plan implementacji
> **Źródła:** [pochodzenie materiałów](#pochodzenie-materiałów), [rejestr audytu](AUDIT-REGISTER.md)
> **Kiedy ten dokument traci aktualność:** po nowej rewizji kodu, źródła zewnętrznego lub nowym pomiarze; dawne wnioski zachowują datę i zakres.

## Cel

Wybrać eksperyment falsyfikujący, zanim powstanie nowa funkcja lub deklaracja gwarancji. [A01–A24](AUDIT-REGISTER.md#ustalenia-a01a24) to ustalenia źródłowego audytu; [F01–F15](AUDIT-REGISTER.md#mapa-f01f15) to osobny rejestr właściciela. Nie utożsamiamy tych identyfikatorów z patologiami P1–P10 ani numerami ADR.

Research nie zastępuje [SPEC](../SPEC.md), [reguł pracy](../AGENTS.md) i aktualnego world state. Historyczne „nie wykonano pomiarów hosta” opisuje moment przygotowania materiału, nie kasuje [późniejszych raportów](AUDIT-REGISTER.md#raporty-operatora--oddzielna-klasa-dowodu).

## Kolejność badań

Poniżej rekomendacja z S-RESEARCH; końcowe zdanie o braku zmian dotyczy historycznej sesji researchu. Nie jest opisem bieżącego PR.

Najpierw DR-06, DR-05, DR-01, DR-02, DR-03 i DR-04: tożsamość dowodów, kompletność preconditions, crash semantics i testy. Równolegle można badać wykonalność DR-17/18/19/20 bez ogłaszania enforce. Dopiero po ustaleniu tych granic oceniaj DR-07/13/14 i DR-09/10/11/12. DR-08 powinien definiować eksperyment zanim pojawią się twierdzenia o compoundingu. DR-15/16 wspierają jakość instrukcji i admission w obu ścieżkach.

To kolejność researchu, nie zmiana zamrożonej sekwencji implementacji ADR-006. Repozytorium pozostawiono bez zmian.

## Syntezy z 10 września 2026

**Status syntez: analiza źródeł, bez nowych reprodukcji ustaleń kodowych ani pomiaru hosta w tym opracowaniu.** Pochodny wspólny wniosek z SD/SR oraz narracyjnych N1/N2 (nie są to niezależne eksperymenty): kierunek transaction/control plane pozostaje; przejście istniejących testów nie domyka zgodności rdzenia. Luki rdzenia i integracji są odrębnymi bramkami, a nie argumentem za rozpoczęciem kolejnego modułu pamięci — [SD: status i bramka](#source-sd), [SR: §1 i §8](#source-sr).

### Identyfikatory zawsze z pochodzeniem

| Zapis w tym rejestrze | Znaczenie i granica |
|---|---|
| `F01`–`F15` | Pierwotny rejestr właściciela z 09.09; [tabela w rejestrze audytu](AUDIT-REGISTER.md#mapa-f01f15) pozostaje niezmieniona. |
| `SR:F16`–`SR:F25` | Dziesięć rozszerzeń w SR §5; nie wynik nowych testów i nie numery GitHub Issues. |
| `SD:F01`–`SD:F22` | Osobna numeracja w SD. Przykład: `SD:F01` dotyczy limitu raw, podczas gdy pierwotne `F01` dotyczy integracji hosta. |
| `DR20:DR-xx` / `SR:DR-xx` | Dwie różne kampanie. Mapy rozdzielono [poniżej](#dwie-kampanie-dr). |
| `P1`–`P10` / `SR:P01`–`SR:P13` | Pierwszy zbiór to patologie z ANALIZY; drugi to identyfikatory bibliografii SR §10. |

Prefiksy SD/SR/DR20 są etykietami odsyłaczy. Nie przemianowują źródłowych ustaleń, nie łączą ich statusów i nie nadają jednej syntezie prawa do zastąpienia drugiej. `KOD` w SD/SR oznacza zadeklarowany odczyt autora syntezy; tutaj sprawdzono treść załącznika, nie ponownie implementację.

### Korekty interpretacji materiału

Źródło tabeli: [SR §3, K01–K11](#source-sr); SD zawiera pokrewne rozstrzygnięcia. To indeks korekt źródła, nie nowe wyniki produktu.

| Korekta SR | Co zachowujemy w dalszej pracy |
|---|---|
| K01 | Brak ANALIZY w materiale badacza nie oznacza braku designu w projekcie. |
| K02 | SR raportuje exact-SHA run `34254764551`, job `102157647534`, 93 testy dla `ddc81034…`; brak odczytu w innym raporcie nie dowodzi braku CI. Nie przenosimy tego wyniku na nowy kod. |
| K03 | Reprodukcja algorytmów na Node 22.16.0 / Git 2.47.3 nie jest regresją oryginalnego produktu ani pomiarem jego targetowego RSS. |
| K04 | Błędy zapisu wewnątrz pętli archive i błędy późniejszego fsync mają według syntezy różne ścieżki; nie łączymy ich w ogólny PASS storage. |
| K05 | Kompletność zachowanych bajtów i egzekwowanie sumarycznego limitu to dwie osie. Pełne dwa strumienie mogą naruszać budżet bez kłamstwa o ich kompletności. |
| K06 | Odrzucenie oversize digestu nie jest dowodem unbounded admission; pozostaje problem bounded reprezentacji i klasyfikacji jej błędu. |
| K07 | SIGKILL nie wykonuje catcha; `started` może blokować powtórkę. Ryzyko po `completed` trzeba wykazać dla konkretnej szczeliny, nie każdego crashu. |
| K08 | In-memory receipt z ADR-016 nie jest sam w sobie defektem; brak consumer ACK nie upoważnia do dopisania exactly-once ani nowego eventu. |
| K09 | Konsekwencja literalnego ADR, np. udział HEAD w epoce, nie jest automatycznie odstępstwem implementacji. |
| K10 | Korekty dat bibliografii pozostają opisane w SR; nie zatwierdzano ich ponownie w tej redakcji ani nie zmieniano ruchomych źródeł. |
| K11 | Projekt prerejestracji nie dowodzi zatwierdzenia protokołu, przeprowadzenia badania ani uzyskania korzyści. |

Treść A01–A24 i wcześniejszych F01–F15 jest zachowana. Powyższe korekty, zwłaszcza K05/K06, ograniczają interpretację dawnych sformułowań zamiast potajemnie przepisywać źródła.

### Rozszerzenia SR:F16–F25

Każdy wiersz wskazuje odrębne ustalenie z [SR §5](#source-sr) oraz najmniejszy wymagany dowód. Powiązanie z Axx nie oznacza równoważności całego zakresu. Klasy KOD/RAPORT poniżej są klasami podanymi przez SR.

| ID źródła / klasa | Ustalenie i powiązanie | Próba albo otwarty kontrakt |
|---|---|---|
| SR:F16 · KOD | `goalId` zamiast `tested_epoch`/`compiled_epoch`; A01. | Stały goal w dwóch epokach; rozstrzygnąć world vs scoped epoch przed poprawką semantyki. |
| SR:F17 · KOD | Dwie bazy `dependencyPaths`; A03. | Root i subdir zawierają różne `state.txt`; pomiar, Gate i proces muszą dotyczyć tego samego obiektu. |
| SR:F18 · KOD | Dowolny błąd fileHash zamieniony w MISSING; A17. | Rzeczywisty brak osobno od EACCES/EISDIR; nieudany pomiar nie staje się dowodem nieistnienia. |
| SR:F19 · KOD/RAPORT | Źródła po ANSI i kolizji tytułów; A16. | Porównać dokładne surowe zakresy dla konkretnej diagnostyki, nie tylko powodzenie readFragment. |
| SR:F20 · KOD | Słabe recognized compiler/test-runner; A15. | Obcy output z exit 0 oraz sprzeczny raport JSON; tożsamość procesu pozostaje osobnym warunkiem. |
| SR:F21 · KOD/RAPORT | Pojedyncze duże pole i zbyt szerokie UNKNOWN; A14. | Długa diagnostyka po znanym wyniku: brak oversize admission i brak domniemanej zgody na retry. |
| SR:F22 · KOD/RAPORT | Pełny reload raw po capture; część A24. | Osobno zmierzyć capture/odczyt/parser i skonfrontować z ADR-017; nie przenosić RSS z proxy harnessu. |
| SR:F23 · KOD opisany przez źródła | Jawne environment w trwałych eventach; rozwinięcie zagadnień F03/F13. | Niewrażliwy canary, mapa storage/admission/uprawnień; persystencja nie jest jeszcze wykazanym wyciekiem. |
| SR:F24 · RAPORT/KOD | `patch_source` a raw/numstat bez pełnego patcha; rozwinięcie F07. | Odtworzyć obiecany patch z realnego git diff; nie dodawać nowego adaptera w ramach diagnozy. |
| SR:F25 · RAPORT/KOD | Reopen projekcji to nie replay; A10 i część F13. | Kopia storage bez projekcji przy zachowanych events/blobs; odtworzenie albo jawna odmowa, bez nowego receipt eventu. |

### Mapa alternatywnej numeracji SD

[SD: rejestr F01–F22](#source-sd) używa innej numeracji. Poniższa mapa rozlicza wszystkie 22 pozycje; wskazuje temat lub część wspólnego problemu, **nie identyczne dowody ani połączenie ustaleń**.

<details>
<summary>Otwórz mapę SD:F01–F22 do wcześniejszego F i rozszerzeń SR</summary>

| Pozycja SD | Powiązanie tematyczne | Ograniczenie mapowania |
|---|---|---|
| SD:F01 | F02 / A12 | Wspólny limit stdout + stderr. |
| SD:F02 | F10 / A13 | Zakończenie i zachowanie timeoutu po raw limit. |
| SD:F03 | SR:F22 | Materializacja pełnego raw po capture. |
| SD:F04 | Część SR:F20 | Compiler, nie cały zakres parsera testów. |
| SD:F05 | F07 i SR:F24 | Rozpoznanie git diff oraz znaczenie patch_source to osobne pytania. |
| SD:F06 | Część SR:F21 | Długie message i bounded reprezentacja. |
| SD:F07 | F08 / A16 | Niezgodny stream unknown git-diff. |
| SD:F08 | Część SR:F19 | ANSI w shell, bez pełnego zakresu tytułów Vitest. |
| SD:F09 | Części SR:F19 i SR:F20 | Walidacja raportu i zakres źródła to odrębne osie. |
| SD:F10 | SR:F16 | SD rozdziela własny odczyt compiler od relacji raportu o test-runnerze. |
| SD:F11 | SR:F17 | Baza ścieżek zależności. |
| SD:F12 | SR:F18 | MISSING a błąd odczytu. |
| SD:F13 | F05 / A09 | completed przed failure i końcową kontrolą. |
| SD:F14 | F04 / A22 | Test ręcznego UNKNOWN nie jest SIGKILL brokera. |
| SD:F15 | SR:F25 | Odbudowa projekcji i semantyka przejść. |
| SD:F16 | Część F03 / A02 | Odziedziczone środowisko procesu. |
| SD:F17 | Część F03 / A04 | Operational inputs i skutki literalnej formuły ADR-011. |
| SD:F18 | F06 / A06 | Lease pomiarowy a okres do spawn. |
| SD:F19 | SR:F23 | Możliwa persystencja sekretu z explicit environment. |
| SD:F20 | F09 / A18 | Skan pierwszych 100000 zdarzeń. |
| SD:F21 | Część F13 / A19 | fsync katalogu i power loss, nie wszystkie awarie storage. |
| SD:F22 | F01 | Pełny profil hosta; późniejsze relacje operatora pozostają odrębnym źródłem. |

</details>

### Dwie kampanie DR

Zakresy DR-01–DR-20 w dalszej części tego dokumentu zachowują wcześniejszy pakiet **DR20**; pełne prompty pozostają poza repozytorium. SR §2 opisuje inną kampanię dziewięciu tematów. Tożsamość numeru nie wystarcza: `DR20:DR-01` to crash semantics, `SR:DR-01` — integracja. Nie liczymy dopasowań tematycznych jako kolejnych niezależnych badań.

| Temat kampanii SR | Materiał według SR §2 | Powiązania z DR20 / istniejącym rejestrem |
|---|---|---|
| SR:DR-01 · integracja | R01, `deep-research-report (3).md` | DR20:DR-17/18/19/20 |
| SR:DR-02 · zależności i epoki | R02, `deep-research-report.md` | DR20:DR-05/06/10 |
| SR:DR-03 · crash-safety | R03, `deep-research-report (5).md` | DR20:DR-01/02/03/04 |
| SR:DR-04 · capture i parsery | R04, `deep-research-report (1).md` | DR20:DR-03/04/16 |
| SR:DR-05 · bezpieczeństwo pamięci | Brak osobnego raportu według SR | Pokrewne DR20:DR-07/20; nie zastępują brakującego opracowania. |
| SR:DR-06 · eksperyment wartości | R06, `deep-research-report (6).md` | DR20:DR-08; różne treatmenty trzeba nadal rozdzielać. |
| SR:DR-07 · docelowa pamięć | R07, `deep-research-report (4).md` | DR20:DR-07/13/14 |
| SR:DR-08 · skala i operacje | Brak osobnego raportu według SR | A18/A19/A24; brak pełnego odpowiednika w jednym temacie DR20. |
| SR:DR-09 · przewaga i harnessy | R09, `deep-research-report (2).md` | Części DR20:DR-08/09/11/12, nie równoważny jeden prompt. |

Nie poświadczamy tutaj obecności oryginalnych R01–R09 w pakiecie: dostępne są syntezy, które je opisują. Sama lista i hashe wewnątrz SR nie są siedmioma wykonanymi odczytami tych raportów.

### Granice interpretacji pamięci i wartości

[SR §4](#source-sr) oraz [SD: decyzje zachowane z ANALIZY](#source-sd) przywracają istniejący design: Atlas z required evidence slots (§8/C04 i §19), compaction/recovery (§20–22), lifecycle/konflikty (§24), validity oddzielone od utility (§25) i compounding (§26). Nie przenosimy tych mechanizmów do MVP-0 ani nie przepisujemy ich jako nowych propozycji. Definicje i progi pozostają w ANALIZIE identyfikowanej w tabeli źródeł; ich mapa jest w [architekturze](ARCHITECTURE.md).

**Różnica wymagająca zachowania:** SD opisuje pytanie C jako wzrost przewagi z ekspozycją, podczas gdy SR §7 wyróżnia C jako przyszłą semantic memory i wzrost przewagi. To nie ten sam treatment. B dotyczy zachowanej historii porażek; ani dodatni B, ani stała oszczędność nie dowodzą semantic-memory compoundingu. Przed eksperymentem potrzebny jest jawny treatment, zakres i zatwierdzony protokół — nie wygładzenie dwóch opisów do jednego.

SD/SR wskazują również różne poziomy progów: 5% false blocks i −5 pp z projektu eksperymentu nie zastępują celu 1% legitimate retries ani −2 pp przy promotion w ANALIZIE. Populacje i poziom decyzji muszą być jawne; redakcja nie wybiera nowego progu.

[N2, druga część od „Co rzeczywiście pokazuje ta praca”](#source-n2) jest odrębnym komentarzem o embedding-based retrieval. Zachowujemy w indeksie jego ograniczenie wniosku: single-vector scoring przy określonym wymiarze i marginesie nie rozstrzyga o całym RAG; embedding może wspierać ranking, nie potwierdza aktualności ani wystarczalności dowodu. Nie weryfikowano tu pracy arXiv ani bibliografii N2; istniejące rozstrzygnięcie o vector-memory-only pozostaje w ANALIZIE §33. Komentarza nie liczymy jako ósmego niezależnego raportu o kodzie.

### Trzy bramki dalszej pracy

Rekomendacja z [SR §8](#source-sr) i [SD: bramka dalszej pracy](#source-sd), nie nowe zlecenie implementacyjne:

| Bramka | Co rozliczamy | Granica dowodu |
|---|---|---|
| Zgodność rdzenia | Wspólny raw cap, termination, parser/source fidelity, epoki i ścieżki zależności, completed/crash/replay. | Regresje oryginalnego kodu, realne awarie i niezależne liczniki; naprawy zgodnie z ADR-006. |
| Kwalifikacja hosta | Coverage, admission, izolacja i związanie kwalifikacji z aktywacją. | Dotychczasowe [relacje operatora](AUDIT-REGISTER.md#raporty-operatora--oddzielna-klasa-dowodu) zachowują swój zakres; brak pełnego S.6. |
| Wartość | Uczciwy baseline, false blocks, correctness, koszt i osobne treatmenty pamięci. | Projekt eksperymentu, hashe raportów i licznik testów nie są pomiarem przewagi. |

Zadanie patcha aktywacji hosta nie zamyka luk rdzenia. Nowe syntezy nie cofają wcześniejszych pomiarów hosta do „braku jakichkolwiek prób”. Ta redakcja RESEARCH nie oznacza żadnego F/A jako naprawionego i nie nadaje nowego ADR.

## Wspólny kontrakt wyniku badania

Wynik zawiera problem, źródła, najwyżej 2–3 alternatywy, kontrprzykład, eksperyment PASS/FAIL/BLOCKED, koszty i decyzję właściciela potrzebną przed implementacją. Reguły normatywne linkuj z [AGENTS](../AGENTS.md), nie kopiuj ich do każdego raportu. Wskazuj P1–P10 i właściwe ADR; próba nie jest wykonanym testem.

### Indeks zakresów badań

Poniższe `DR-01`–`DR-20` są krótkim indeksem zakresów badań. Pełne prompty pozostają w źródle `S-RESEARCH` poza repozytorium; do Gita trafiają tylko zakresy, pochodzenie i wnioski potrzebne konkretnemu konsumentowi.

#### DR-01. Crash semantics i tożsamość nierozliczonego efektu

**Zakres badania:** automat intent/reservation/spawn/capture/completed oraz reconciliation nierozliczonych efektów.

**Materiały startowe:** [R-SPEC](#r-spec), [R-MIDDLEWARE](#r-middleware), [R-GATE](#r-gate), [R-E2E](#r-e2e).

#### DR-02. Replay dowodów, receipts i projekcji

**Zakres badania:** odtwarzalność events, CAS, failures, reservations, proofów i admitted digestów po cold replay.

**Materiały startowe:** [R-LEDGER](#r-ledger), [R-SCHEMA](#r-schema), [R-GATE](#r-gate), [R-MIDDLEWARE](#r-middleware), [R-SPEC](#r-spec).

#### DR-03. Budżety zasobów i zakończenie procesu

**Zakres badania:** wspólny budżet raw, backpressure, timeouty, procesy potomne i trwałość storage.

**Materiały startowe:** [R-ADAPTERS](#r-adapters), [R-LEDGER](#r-ledger), [R-RAWTEST](#r-rawtest), [R-SPEC](#r-spec).

#### DR-04. Czy acceptance i chaos testują kontrakt, czy implementację?

**Zakres badania:** pokrycie kontraktu R/S przez testy rzeczywistych procesów, chaos i mutation testing.

**Materiały startowe:** [R-SPEC](#r-spec), [R-E2E](#r-e2e), [R-RAWTEST](#r-rawtest), [R-CI](#r-ci).

### Memory / epoch

#### DR-05. Kompletna, ale minimalna epoka eksperymentu

**Zakres badania:** minimalna epoka eksperymentu, kompletność preconditions i granice pomiaru świata.

**Materiały startowe:** [R-STATE](#r-state), [R-SHELL](#r-shell), [R-MIDDLEWARE](#r-middleware), [R-GATE](#r-gate), [R-SPEC](#r-spec).

#### DR-06. Atestacje testów i kompilatora bez fałszywej aktualności

**Zakres badania:** wiązanie atestacji testów i kompilatora z epoką bez fałszywej aktualności.

**Materiały startowe:** [R-TEST](#r-test), [R-COMPILER](#r-compiler), [R-MIDDLEWARE](#r-middleware), [R-STATE](#r-state), [R-SPEC](#r-spec).

#### DR-07. Knowledge sandbox: dependency validity nie równa się claim truth

**Zakres badania:** granica między rewalidacją zależności, prawdą claimu i przyszłym admission pamięci.

**Materiały startowe:** [R-STATE](#r-state), [R-SPEC](#r-spec), [R-MIDDLEWARE](#r-middleware), [C-CONTEXT](#c-context).

#### DR-08. Eksperyment compounding: memory-on kontra memory-off

**Zakres badania:** prerejestrowane porównanie memory-on kontra memory-off i pomiar compoundingu.

**Materiały startowe:** [R-STATUS](#r-status), [R-SPEC](#r-spec), [O-SESSION](#o-session), [C-CONTEXT](#c-context).

### Agents & coordinator patterns

#### DR-09. Koordynator i specjaliści poza LEDGER hot path

**Zakres badania:** koordynator i specjaliści poza deterministycznym hot path oraz warunki opłacalności.

**Materiały startowe:** [C-TEAM](#c-team), [O-ASTRA](#o-astra), [R-AGENTS](#r-agents), [R-SPEC](#r-spec).

#### DR-10. Równoległość bez utraty one-writer invariant

**Zakres badania:** równoległe analizy przy zachowaniu jednego writera, lease i aktualności SHA.

**Materiały startowe:** [R-STATE](#r-state), [R-GATE](#r-gate), [R-MIDDLEWARE](#r-middleware), [C-TEAM](#c-team).

#### DR-11. Advisor i Outcomes bez resurrectowania Twin Brains

**Zakres badania:** rozdzielenie hipotezy, review artefaktu i autoryzacji twierdzenia o świecie.

**Materiały startowe:** [C-ADVISOR](#c-advisor), [C-OUTCOME](#c-outcome), [R-SPEC](#r-spec), [R-STATUS](#r-status).

#### DR-12. Async tools, anulowanie i spóźnione wyniki

**Zakres badania:** async tools, anulowanie, late results, resume i zachowanie UNKNOWN.

**Materiały startowe:** [O-ASTRA](#o-astra), [O-APP](#o-app), [R-MIDDLEWARE](#r-middleware), [R-GATE](#r-gate), [R-SPEC](#r-spec).

### Context engineering

#### DR-13. Compaction jako nowy widok, nie utrata źródła

**Zakres badania:** compaction jako nowy widok z zachowaniem źródeł, zobowiązań i recovery.

**Materiały startowe:** [O-SESSION](#o-session), [C-COMPACTION](#c-compaction), [C-CONTEXT](#c-context), [R-SPEC](#r-spec).

#### DR-14. Context Atlas i obowiązkowe evidence dla następnej decyzji

**Zakres badania:** Context Atlas, required evidence slots i odzyskanie brakującego dowodu.

**Materiały startowe:** [R-SPEC](#r-spec), [O-SESSION](#o-session), [C-CONTEXT](#c-context).

#### DR-15. Audyt AGENTS i skills jako wykonywalnego kontekstu

**Zakres badania:** audyt AGENTS/skills jako wykonywalnego kontekstu, konfliktów i supersesji.

**Materiały startowe:** [R-AGENTS](#r-agents), [R-SPEC](#r-spec), [R-ISSUES](#r-issues), [O-ASTRA](#o-astra).

#### DR-16. Deterministyczny digest, który nie fałszuje niepewności

**Zakres badania:** deterministyczne digesty, parser status, bounded reprezentacja i source handles.

**Materiały startowe:** [R-ADAPTERS](#r-adapters), [R-SHELL](#r-shell), [R-TEST](#r-test), [R-COMPILER](#r-compiler), [R-DIFF](#r-diff), [R-SPEC](#r-spec).

### MCP / Agents SDK integracje

#### DR-17. Pełne broker coverage na rzeczywistym hoście

**Zakres badania:** pełne broker coverage na rzeczywistym hoście i kontrola przed efektem.

**Materiały startowe:** [R-DESKTOP](#r-desktop), [R-SPEC](#r-spec), [O-APP](#o-app), [O-SDK](#o-sdk).

#### DR-18. Codex App Server jako punkt integracji bez własnej pętli modelu

**Zakres badania:** Codex App Server jako cienki punkt integracji bez własnej pętli modelu.

**Materiały startowe:** [O-APP](#o-app), [R-DESKTOP](#r-desktop), [R-MIDDLEWARE](#r-middleware), [R-SPEC](#r-spec).

#### DR-19. Pokrycie guardrails Agents SDK versus Failure Antibody Gate

**Zakres badania:** pokrycie guardrails Agents SDK względem Failure Antibody Gate.

**Materiały startowe:** [O-SDK](#o-sdk), [R-GATE](#r-gate), [R-SPEC](#r-spec).

#### DR-20. Model uprawnień środowiska desktopowego: worktree, CAS, SQLite i klucz

**Zakres badania:** model uprawnień desktopowego hosta dla worktree, CAS, SQLite, klucza i symlinków.

**Materiały startowe:** [R-DESKTOP](#r-desktop), [R-MIDDLEWARE](#r-middleware), [R-LEDGER](#r-ledger), [R-SPEC](#r-spec).

## Pochodzenie materiałów

Opracowanie materiałów dostarczonych przez właściciela; nie wykonano tu ponownej weryfikacji zewnętrznych prac ani nowych reprodukcji ustaleń kodowych. Daty publikacji i statusy opisane w materiałach są ich twierdzeniami, nie nowym odczytem internetu.

| ID źródła | Dostarczony plik | SHA-256 oryginalnych bajtów |
|---|---|---|
| S-ANALIZA | `ANALIZA(2)(1).md` — motywacje, kill-round i design docelowy | `a7693eec85023a9d31b6ec7708ac690bfdf9769874a2afdf455196b2ce98d1b3` |
| S-RESEARCH | `tallystick-deep-research-2026-09-09(1).md` — A01–A24, DR-01–DR-20 i bibliografia | `fd0ef95d4213378c10e3fcdbdc4a8012eca3c8b8a42cbf58953177f80f55ecdd` |
| S-SYNTEZA | `Wklejony kod markdown.md` — historyczne syntezy/audyty | `b5c029ec1de45a61641bc2a89ce0189a51504c4b1e0ea3b3f770b83df2963891` |
| S-SYNTEZA-2 | `Wklejony kod markdown (2).md` — synteza A–Z | `75ed37d85f9421f172b3149bb047a6979dd200b387382be89a7f07f29d01e6ca` |

Oryginały pozostają materiałami właściciela; hash identyfikuje plik, nie dowodzi jego wniosków. Nie publikujemy kopii rozmów jako nowego źródła norm. Motywacje wybrano do [architektury](ARCHITECTURE.md); ustalenia A zachowano w [rejestrze audytu](AUDIT-REGISTER.md). Poniższe zakresy i bibliografia wskazują treść S-RESEARCH; pełne prompty nie są przechowywane w repozytorium, a nowe nagłówki i nawigacja są redakcyjne.

S-SYNTEZA/S-SYNTEZA-2 mieszają historyczny status, rekomendacje i opisy designu, a miejscami różnią się zakresem odczytu logów CI. Nie rozstrzygamy tej historii przez ujednolicenie liczb: dowód baseline jest w [MVP-0-STATUS](MVP-0-STATUS.md), późniejsze raporty operatora są rozliczone oddzielnie. Zewnętrzne prace o pamięci pozostają materiałem do badania; nie uzasadniają deklaracji przewagi ani rozpoczęcia implementacji pamięci.

### Syntezy dostarczone 10 września 2026

Poniższe aliasy opisują pochodzenie odsyłaczy, nie nowe ADR ani kolejność autorytetu. Oryginały dostarczono jako załączniki; nie są plikami tego repo. SHA-256 policzono z otrzymanych bajtów.

| Źródło / alias | Rola | SHA-256 otrzymanych bajtów |
|---|---|---|
| <a id="source-sd"></a> **SD** · `SYNTEZA-DECYZYJNA(1).md` | Alternatywny rejestr F01–F22; lokalna numeracja autora. | `7b384eb1fedf346e1b11fff7483f12f321aae1fa9c7f38f04482e0060959ccc3` |
| <a id="source-sr"></a> **SR** · `TALLYSTICK-SYNTEZA-RESEARCHU-2026-09-10(1).md` | Korekty K01–K11; zachowanie wcześniejszych F01–F15 i rozszerzenie F16–F25; mapa siedmiu raportów. | `ce65a384285462dee5642d49fe914b4ac301f16755017e280a85ee5f884104b9` |
| <a id="source-n1"></a> **N1** · `Wklejony kod markdown(2).md` | Narracyjna synteza; nie niezależny eksperyment. | `86be0902ff73f884d9c5c3c40edb8dba56b85e05e6b8485b6d39563ace97f09d` |
| <a id="source-n2"></a> **N2** · `Wklejony kod markdown (2)(1).md` | Narracyjna synteza i odrębny komentarz o embedding-based retrieval. | `320b231750796161fdf2fe556010474bcde685e8ed03c3b643942fb3e38346bb` |

Siedem pierwotnych `deep-research-report*.md` wymienionych wewnątrz SD/SR nie zostało dostarczonych w tej aktualizacji. Ich hashe są deklaracjami syntez, nie wynikiem ponownego odczytu siedmiu oryginałów. N1/N2 nie są dodatkowymi niezależnymi eksperymentami. Indeks korekt i mapowania ustaleń: [syntezy](#syntezy-z-10-września-2026).

## Bibliografia przypiętego researchu

Repozytoryjne odsyłacze są przypięte do SHA audytu. Dokumentacja vendorów jest ruchoma; przed kolejnym badaniem zapisz wersję lub datę odczytu. Cookbook opisuje wzorce, nie zmienia kontraktu projektu.

<a id="r-spec"></a>
**R-SPEC — SPEC.md**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/SPEC.md

<a id="r-agents"></a>
**R-AGENTS — AGENTS.md**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/AGENTS.md

<a id="r-issues"></a>
**R-ISSUES — ISSUES.md — historyczny plan, nie live issues**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/ISSUES.md

<a id="r-middleware"></a>
**R-MIDDLEWARE — src/index.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/index.ts

<a id="r-ledger"></a>
**R-LEDGER — src/ledger/index.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/ledger/index.ts

<a id="r-schema"></a>
**R-SCHEMA — src/ledger/schema.sql**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/ledger/schema.sql

<a id="r-adapters"></a>
**R-ADAPTERS — src/adapters/index.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/adapters/index.ts

<a id="r-shell"></a>
**R-SHELL — src/adapters/shell.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/adapters/shell.ts

<a id="r-test"></a>
**R-TEST — src/adapters/test-runner.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/adapters/test-runner.ts

<a id="r-compiler"></a>
**R-COMPILER — src/adapters/compiler.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/adapters/compiler.ts

<a id="r-diff"></a>
**R-DIFF — src/adapters/git-diff.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/adapters/git-diff.ts

<a id="r-state"></a>
**R-STATE — src/state/index.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/state/index.ts

<a id="r-gate"></a>
**R-GATE — src/guards/index.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/src/guards/index.ts

<a id="r-e2e"></a>
**R-E2E — test/integration/e2e.test.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/test/integration/e2e.test.ts

<a id="r-rawtest"></a>
**R-RAWTEST — test/integration/raw-output-limit.test.ts**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/test/integration/raw-output-limit.test.ts

<a id="r-ci"></a>
**R-CI — .github/workflows/ci.yml**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/.github/workflows/ci.yml

<a id="r-status"></a>
**R-STATUS — Historyczny baseline MVP-0**

https://github.com/korneliuszburian/tallystick/blob/ddc81034add54bf47bf63b5a11e48ed1bd64d4d9/docs/MVP-0-STATUS.md

<a id="r-desktop"></a>
**R-DESKTOP — Bieżące kryteria desktopowego audytu integracji S.6**

[docs/DESKTOP-INTEGRATION-AUDIT.md](DESKTOP-INTEGRATION-AUDIT.md)

<a id="o-astra"></a>
**O-ASTRA — OpenAI — Using GPT-6 Astra / Model guidance**

https://developers.openai.com/api/docs/guides/latest-model

<a id="o-session"></a>
**O-SESSION — OpenAI Cookbook — Context Engineering: Short-Term Memory Management with Sessions (2025-09-09)**

https://developers.openai.com/cookbook/examples/agents_sdk/session_memory

<a id="o-sdk"></a>
**O-SDK — OpenAI Agents SDK JS — Guardrails**

https://openai.github.io/openai-agents-js/guides/guardrails/

<a id="o-app"></a>
**O-APP — Codex App Server — dynamic tools, requests, lifecycle**

https://learn.chatgpt.com/docs/app-server

<a id="c-team"></a>
**C-TEAM — Claude Cookbook — Multiagent: coordinate a specialist team (2026-05-03)**

https://platform.claude.com/cookbook/managed-agents-cma-coordinate-specialist-team

<a id="c-outcome"></a>
**C-OUTCOME — Claude Cookbook — Outcomes: agents that verify their own work (2026-05-03)**

https://platform.claude.com/cookbook/managed-agents-cma-verify-with-outcome-grader

<a id="c-advisor"></a>
**C-ADVISOR — Claude Cookbook — Advisor: let a working agent consult a stronger model mid-turn**

https://platform.claude.com/cookbook/managed-agents-cma-consult-an-advisor

<a id="c-context"></a>
**C-CONTEXT — Claude Cookbook — Context engineering: memory, compaction, and tool clearing**

https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools

<a id="c-compaction"></a>
**C-COMPACTION — Claude Cookbook — Session memory compaction**

https://platform.claude.com/cookbook/misc-session-memory-compaction
