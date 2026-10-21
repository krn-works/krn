> **Historical synthesis (2026-10-07).** Current implementation and proposed architecture follow-up: [architecture](../architecture.md); current stage proofs and limits: [roadmap](../program/roadmap-2026-10-20.md). The dated synthesis below remains intact.

# Synteza v3: program KRN A–Z (architekt syntezy, 2026-10-07)

**Wejście.** v2 wraz z ocenami J2 (Sol 6/10, Luna 6/10), raporty R10 (Karpathy) i R11 (język instrukcji) oraz decyzje
operatora z końcówki `charter.md`. Dodatkowo sprawdziłem ręcznie trzy rzeczy: `~/.local/bin/krn` wskazuje na
`~/.codex/krn/current/scripts/krn.mjs`; katalog binariów instalatora to `KRN_BIN_DEST` lub `~/.local/bin`
(`install-inspect.mjs:312`); stara lista komend pochodzi z `krn --help`.

**Etykiety.** Używam etykiet z `_common.md` i jednej nowej: **[POLICY]** oznacza wybraną regułę operacyjną. Taka reguła
nie jest wnioskiem z dowodów i podlega korekcie na danych.

## 0. Co zmienia v3

1. **Real use.** [CODE `krn-harness/README.md:59`] `krn-harness` przeszedł jedną izolowaną realną mutację
   kodu produktu. [OURS-EVIDENCE `krn-factory/PLANS.md:176-186`] `krn-factory` nie ma pilota na realnym celu.
   Twierdzenie v2, że „realne użycie nigdy nie nastąpiło”, wycofuję. Hipotezę, że porażki wynikały z kolejności budowy,
   zostawiam jako [HYPOTHESIS], bez przyczynowości.
2. **Kapsuła nie jest władzą zadania.** [CODE ADR0007:24] Kapsuła to widok kontynuacji. Status, przydział i akceptację
   posiada Paperclip. Kapsuła jest źródłem prawdy tylko dla pól kontynuacji (§4.1).
3. **Przywrócone fakty** (w §2, §3, §5, §6, §7 i §11): LT-1 (0/4→4/4), nasycone SWE-bench, nieużyty guard, Pi Durable 7/10,
   otwarta kwalifikacja pilota Paperclip, luka HTTPS/URN, `node:sqlite` w statusie RC, abstencja sędziów, zapisywalny
   wyjątek kolejki legacy, przedziały VibeMemBench przecinające zero, warunkowa baza `krn-harness`, ukończone fazy `mini-agi`.
4. **Progi.** Każdy próg, moduł i kolejność to [POLICY] albo [HYPOTHESIS]. Kryterium zabicia ma teraz jedno brzmienie (§12).
5. **Role.** Rozdzielam obecny ADR 0010 od decyzji operatora z 2026-10-07 (§11). Z dwóch par ocen sędziów nie wyciągam
   wniosków przyczynowych.
6. **Usunięte.** Kandydaci na nazwę (operator wybrał `krn`), „Netflix Keel” (niezweryfikowane), „120 linii ≈ 1,2k tokenów”
   (nieprawda) i „test widoczny dla agenta nic nie dowodzi” (przesada; poprawione w §2).

## 1. Czym jest krn

**Definicja.** `krn` to osobisty harness inżynierski [HYPOTHESIS]. Działa nad hostami agentów (Codex, Claude Code, Pi).
Prowadzi pracę między świeżymi sesjami i kończy ją zmianą, którą przyjmuje akceptujący. Dowód jest związany z dokładnym
SHA, a czas obsługi operatora ma być jak najmniejszy.

**Czym krn nie jest:**
- AGI ani gwarancją poprawności [OURS-EVIDENCE kapsuła discovery].
- Domyślnym systemem multi-agentowym. Zysk z multi-agentów wykazano przy niezależnych przeszukiwaniach wszerz.
  Kodowanie ze sprzężonymi decyzjami to słabsze dopasowanie, ale werdyktu ekonomicznego dla KRN nie zmierzono
  [EMPIRICAL R6:23,34].
- Trackerem. Na start władzą zadań pozostaje Paperclip (§5).
- Dashboardem, benchmarkiem ani pętlą autoresearchu [CODE goal-0039:122,129-133].
- Modelem.

## 2. Paradoksy, mechanizmy, falsyfikatory

Wszystkie mechanizmy poniżej to [HYPOTHESIS] do sprawdzenia w J1. Fakty mają własne etykiety.

| Paradoks | Mechanizm | Falsyfikator |
|---|---|---|
| **Gotowe ≠ zaakceptowane.** | Worker kończy w stanie `in_review`. Akceptacja następuje według ADR 0007: wymagane CI, sędziowie na dokładnym SHA, merge i odczyt zwrotny [CODE ADR0007:29-57]. | Odsetek zaakceptowanych zmian cofniętych z powodu niespełnionego kontraktu nie spada względem baseline'u. |
| **Ciągłość.** Długa sesja kompaktuje kontekst, a świeża zaczyna od zera. | Kapsuła, deterministyczne odświeżanie faktów i świeże sesje uruchamiane przez supervisora. LT-6 dał 3/3 wobec 0/3 na jednym zadaniu ze skryptowaną kapsułą [OURS-EVIDENCE lab-tests.md:53]. W tym samym LT ramię in-session compaction przeszło z hookiem i bez niego, więc efektu nie wyizolowano. | Incydenty utraty etapu lub prompty rekonstrukcyjne nie spadają. |
| **Pamięć: wartość kontra koszt.** | Na start tylko kapsuła i wskaźniki do dokumentów (§6). Za pamięcią przemawia LT-1: treść pamięci dała 0/4→4/4 na zadaniach zależnych od pamięci, ale bez warstwy neutralnej. Ten sam test dał 9/9 przy wyższym koszcie, gdy pamięć była zbędna [OURS-EVIDENCE R1:31,33]. | Sparowana ewaluacja pamięci włączonej i wyłączonej nie pokazuje zysku netto. |
| **Dowód.** Ewaluator, który worker może zobaczyć lub zmienić, bywa słaby [OURS-EVIDENCE R1:74]. | Ewaluator, który worker może zmienić, nie może być **jedynym** dowodem rozstrzygającym jego własną tezę. Falsyfikator musi być czerwony na bazie. Budżet dowodu skaluje się z ryzykiem, a „0 nowych testów” nadal wymaga dowodu [CODE config/AGENTS.md:51-55; R2:30]. | Gate zielony przy zepsutym zachowaniu albo brak spadku liczby ucieczek defektów. |
| **Ciężar review.** | Operator widzi decyzje i wyjątki. Metryką główną są minuty operatora. | Minuty na zaakceptowany wynik nie spadają. |
| **Dryf instrukcji.** | Jeden rejestr reguł, z którego generuje się AGENTS.md (§10). W ADR0002 9 z 12 żądań wypadło dwuznacznie. Benchmarki pokazują spadek przestrzegania przy wielu regułach, ale nie dają limitu dla KRN [EMPIRICAL R11:1]. | Sparowana sonda zgodności (§10.6) nie pokazuje poprawy. |
| **Meta.** Harness cierpi na paradoksy, które ma rozwiązywać [CODE goal-0039:136, oznaczone jako „expected findings”]. | [POLICY] Moduł powstaje tylko z konsumentem w aktualnej podróży. | Istnieje moduł bez takiego konsumenta. |

## 3. Struktura

### 3.1 Decyzja i jej status

[POLICY, decyzja operatora] Powstaje nowy folder `~/coding/krn/active/krn`, CLI `krn` i scope `@krn/*`.
Scope zwracał 404 na npm; niczego nie zarejestrowano. Na start jest **jeden pakiet**, a moduły to katalogi. Osobny
pakiet powstaje dopiero przy drugim konsumencie [POLICY]. Strangler działa na poziomie CLI.

**Status dowodowy.** Dowody nie wybierają tej topologii [OURS-EVIDENCE J2-Sol §3]. Brakuje porównania kosztu dojścia do
tego samego wyniku dla trzech dróg: naprawy w miejscu, warunkowej adopcji `krn-harness` (żywotna baza z niezamkniętymi
granicami produkcyjnymi [HYPOTHESIS R3:63]) i nowego rdzenia.

Operator wybrał nowy rdzeń. Ryzyko ekonomiczne zabezpieczają dwie zasady:
- nowy kod **wywołuje** gate'y, instalator i katalog starego repo zamiast je przepisywać;
- obowiązuje jedno kryterium zabicia (§12) [POLICY].

### 3.2 Moduły (analiza pudełek)

`src/` w jednym pakiecie. Kolumna „Etap” mówi, kiedy moduł powstaje [POLICY].

| Moduł | Konsument | Odpowiedzialność | Źródło prawdy | Interfejs | Etap | Falsyfikator |
|---|---|---|---|---|---|---|
| `core` | wszystkie | prymityw `Job`, `Result`, parsowanie na granicach | — | typy | 1 | Moduł importuje adapter (reguła importów, §8). |
| `relay` | foreman, lead (SessionStart) | kapsuła v2: wczytanie, walidacja (degradacje LT-6), odświeżenie, CAS, projekcja ≤2k tokenów [POLICY] | plik kapsuły dla pól kontynuacji | `load/validate/refresh/project` | 1 | Świeża sesja nie wznawia albo gubi etap. |
| `foreman` | operator, lead | pętla J1: świeże sesje, budżety, resety, eskalacja do `human_decision` | dziennik (`trace`) dla stanu przebiegu | `runJob` | 1 | Pętla resetów, zduplikowana praca lub zgubiony commit. |
| `ledger` | foreman, verdict | port pracy; adapter Paperclip board-only (odczyt kontraktu, komentarz z dowodem, `in_review`) i adapter „kontrakt ręczny” | Paperclip | `readContract/submit` | 1 | Status zadania zapisany poza Paperclip. |
| `verdict` | foreman | uruchamianie gate'ów starego repo i sędziów Luna na exact SHA; zebranie werdyktu | statusy `krn/judge-*` i CI | `judge(job, sha)` | 1 jako wrapper wywołań, 4 jako właściciel | Akceptacja bez kompletu dowodu na SHA. |
| `trace` | wszyscy, ewaluacja | dziennik zdarzeń i metryk: minuty, tokeny, czas, dotknięcia operatora; **bez pola statusu zadania** | `node:sqlite` | `log/report` | 1 | Metryka nieodtwarzalna z dziennika. |
| `hosts` | foreman, relay | `codex` (worker Luna) w etapie 1; `claude` tylko jako projekcja dla leada; `pi` w etapie 2 | proces hosta | `start/wait` | 1 (codex) | Sesja bez zapisanego ID lub zużycia. |
| `memory` | relay | etap 1: wskaźniki do ADR/CONTEXT; zdarzenia warunkowo (§6) | Git `krn-memory`, SQLite | — | 1 (wskaźniki), 3 | Paired M-10. |
| `cli` | operator | komendy i przekazywanie | — | `krn …` | 1 | Komenda nieobsłużona i nieprzekazana. |

`krn-memory` pozostaje osobnym repo danych jako kandydat. Granica nie jest zaakceptowana [OURS-EVIDENCE kapsuła discovery].

### 3.3 Strangler CLI i kolizja `krn`

**Fakty.** [OURS-EVIDENCE] `~/.local/bin/krn` to symlink do `~/.codex/krn/current/scripts/krn.mjs`. Instalator starego
repo tworzy go z tabeli `bin` w `package.json:22-24`, w katalogu `KRN_BIN_DEST` (domyślnie `~/.local/bin`). Stary `krn`
obsługuje `install`, `doctor`, `capability`, `repo`, `state`, `skills`, `lessons`, `changes`, `gate`, `conformance`,
`memory` i `harness`. Wołają go hooki i skille.

**Plan** [POLICY]:
1. **Rozwój.** Nowe CLI instaluje się jako `krn-next` (symlink w `~/.local/bin` tworzony skryptem nowego repo).
   `krn` pozostaje stary.
2. **Przekazywanie.** Nowe CLI rozpoznaje tylko komendy zmigrowane. Każdą inną wykonuje przez `execFile` z
   `process.execPath` na `KRN_LEGACY_ENTRY`. Domyślnie jest to `~/.codex/krn/current/scripts/krn.mjs`, czyli
   **zainstalowane wydanie, nie checkout**. Argumenty, stdin, stdout i kod wyjścia przechodzą bez zmian.
   - Ochrona przed rekursją: gdy cel rozwiązuje się do własnego pliku albo ustawione jest `KRN_FORWARDED=1`, CLI
     kończy z kodem 70.
   - `krn --version` podaje obie wersje.
3. **Cutover** (wymaga grantu instalacyjnego):
   - jeden PR w starym repo zmienia tabelę `bin` z `krn` na `krn-legacy`;
   - instalator usuwa link `krn` tylko wtedy, gdy wskazuje on do jego wydania (sprawdzenie własności);
   - następnie skrypt nowego repo tworzy `krn`;
   - odczyt zwrotny: `command -v -a krn`, `krn --version` oraz przekazany `krn state check --json` dają ten sam wynik
     co `krn-legacy state check --json`.
   - Bez zmiany tabeli `bin` stare `krn install apply` przywróciłoby własny link `krn`. Dlatego zmiana tabeli jest
     warunkiem koniecznym.
4. **Migracja komendy.** Komenda zmienia właściciela tylko razem z testem parytetu wyjścia JSON, wykonanym na tej
   samej fiksturze, i z usunięciem starego kodu w tym samym cyklu. Pierwsze migrują `state` (→ `relay`) i `memory`
   (etap 3). Po ostatniej komendzie `krn-legacy` znika.

### 3.4 Kamieniołom

Lista pochodzi z v2, z poprawkami J2. Oceny „najlepszy” to [HYPOTHESIS], bez porównania.

- **`krn-factory`**: maszyna stanów, store zdarzeniowy WAL na `node:sqlite` z replayem, dzierżawy, limit dwóch cykli
  naprawy (`repair-loop.ts`) i executor Codex [CODE].
- **Stare repo**: ABI kapsuły z degradacjami, reguła akceptacji z ADR 0007, detektor `secretTextKind`, allowlista z
  ADR 0009 i LT-62. W LT-62 próg 25 minut jest „chosen bound, not measured” [OURS-EVIDENCE lab-tests.md:112].
- **`krn-harness`**: polityka verify z ADR-0017 i format trace.
- **ts-rust**: zasada, że utracony pass blokuje akceptację. Dodajemy zarządzane wycofanie przypadku [POLICY].
- **Gas Town**: lista no-repeat.
- **beads**: ready i prime.
- **`mini-agi`**: ukończone fazy 0–11 [CODE R3:47]; bierzemy tylko wzorzec zamrożonej specyfikacji.
- **Odrzucamy**: dashboardy, delegator, wykonanie przez Paperclip i Pi Durable. Pi Durable dało 7/10 i miało trzy błędy:
  obcięty output oznaczony jako done, przeżywający wnuk procesu, replay pomijający zmienioną bramkę [OURS-EVIDENCE R1:35].

## 4. Pierwsza podróż (J1)

**Wynik.** Przerwane realne zadanie zostaje wznowione w świeżej sesji bez rekonstrukcji przez operatora i dochodzi do
akceptacji przy mniejszym czasie operatora [HYPOTHESIS].

### 4.1 Kto jest władzą czego

[CODE ADR0007:19-24; HYPOTHESIS R8 §3]
- **Paperclip** posiada status, przydział i akceptację.
- **Kapsuła** posiada wyłącznie pola kontynuacji: rewizję kontraktu (kopię odczytaną z Paperclip), kotwice repo
  (base, HEAD, branch, worktree), następną akcję, blokery, decyzje z datą i źródłem oraz odrzucone podejścia.
  Zapis idzie przez CAS na `job.id+epoch`, a pisze wyłącznie właściciel zadania.
- **Podsumowanie hosta** jest jednorazowe.
- **Zdarzenia pamięci** są wyłączone do etapu 3.

### 4.2 Kroki

0. **Baseline** [POLICY]: 3 realne zadania prowadzone obecną praktyką. Mierzymy minuty operatora, prompty
   rekonstrukcyjne, czas do pierwszej użytecznej akcji, utraty etapu, tokeny, rundy sędziów i wynik. Na konfigurację
   pomiaru jest 4 h (propozycja DA-skeptic).
1. `krn start <issue>`: odczyt kontraktu przez `ledger`, worktree, epoka 0, kapsuła.
2. `foreman` uruchamia `codex exec` z modelem Luna i projekcją `relay`.
3. Po każdej sesji `relay.refresh` deterministycznie aktualizuje HEAD, diffstat i wynik wskazanego testu. Worker
   aktualizuje decyzje przez `krn checkpoint`.
4. Wyzwalacze nowej sesji to wyjście procesu, próg kontekstu ~70% [POLICY], timeout albo awaria. Supervisor nie
   steruje `/compact` w żywej sesji. Udokumentowane hooki Claude i Codex nie dają takiej kontroli [VENDOR R8:2,4].
   Zakładam, że `codex exec --json` raportuje tokeny [HYPOTHESIS, spike].
5. Po deklaracji „gotowe” `verdict` uruchamia gate'y i sędziów Luna na dokładnym SHA. Wynik pozytywny prowadzi do
   `in_review`, a lead akceptuje według ADR 0007.
6. `trace` zapisuje każde zdarzenie. Metryki liczy się z dziennika.

### 4.3 Budżety i awarie [POLICY]

- **Projekcja:** <100 ms i ≤2k tokenów.
- **PreCompact:** tylko lokalna walidacja, <250 ms.
- **Sesja:** ≤45 min. Zawieszenie stwierdzamy dopiero po 25 min ciszy.
- **Resety:** ≤3 na epokę zadania, z cooldownem i kluczem idempotencji.
- **Naprawy:** ≤2 cykle [CODE krn-factory]. Potem `human_decision`. Eskalacja do Sol tylko na żądanie operatora (§11).
- **Kapsuła nieważna:** brak startu sesji, zatrzymanie.
- **Kapsuła przeterminowana:** odświeżenie, a decyzje dostają flagę „do weryfikacji”.
- **Sesja bez commita:** `git log` worktree przed ponowną próbą (LT-62).
- **Paperclip niedostępny:** zbuforowany kontrakt z flagą `stale` i brak zapisów akceptacji.
- **Trafienie detektora sekretów:** odrzucenie bez zapisu.

Ścieżki awaryjne to propozycje, nie zaobserwowana kwalifikacja [HYPOTHESIS].

### 4.4 Ewaluacja

[POLICY] Ramiona A (obecna praktyka) i B (`krn`) prowadzimy naprzemiennie na podobnych zadaniach. Przydział ABAB nie jest
randomizacją [OURS-EVIDENCE J2-Sol T4.8]. Każdy incydent utraty etapu zapisujemy jako przypadek w `evals/journeys/`
z kontrolą deterministyczną. Aktywnych przypadków jest najwyżej 20, a wycofanie wymaga właściciela i powodu.

### 4.5 Transkrypty

[CODE ADR0009:78-81] Zakaz kopania transkryptów zostaje. Eksperyment E-1 (destylacja do *kandydata łatki kapsuły*,
lokalnie, z retencją do końca epoki i przyjęciem przez właściciela) [POLICY] rusza dopiero przy nazwanym incydencie,
którego kapsuła deterministyczna nie mogła uchwycić, i pod poprawką ADR 0009. Uzasadnienie: lokalny `remember` dał
jedno nieweryfikowalne podsumowanie [OURS-EVIDENCE R9:3], a upstream opisał rekursywne zatrucie pamięci [VENDOR R9:4].

## 5. Paperclip

[CODE ADR0007:61-84] Paperclip **zostaje** władzą w trybie board-only, a `ledger` jest jego adapterem.

**Otwarta kwalifikacja pilota** [CODE ADR0007:114-121]:
- dyspozycja w UI;
- niezależny review naprawionego pilota;
- pełny restore świeżej instancji;
- kwalifikacja na realnym projekcie.

Natywny eksport pomija historię akceptacji i polityk. Wyjątek kolejki legacy jest nadal technicznie zapisywalny
[CODE AGENTS.md:65-70].

**Warunek zastąpienia** [POLICY, progi wybrane, nie wyprowadzone]. Muszą zajść oba:
1. W ≥10 podróżach ≥25% minut operatora przypada na Paperclip **albo** wystąpi incydent z listy ponownego otwarcia
   w ADR 0007.
2. Następca przechodzi migrację z ID, historią, akceptacjami i politykami, restore świeżej instancji, rollback
   uzgadniający zmiany po cutover oraz test ogrodzonego pojedynczego zapisu [CODE ADR0007:86-111].

Store zdarzeń `krn-factory` pokazuje wykonalność techniczną. Nie dowodzi, że spełni obowiązki władzy.

## 6. Pamięć

- **Etap 1:** kapsuła i wskaźniki do ADR, CONTEXT i skilli.
- **Etap 3, warunkowo** [POLICY]: wchodzi przy ≥3 incydentach utraty wiedzy *między zadaniami*. Wtedy powstają
  zdarzenia z allowlisty ADR 0009 do SQLite, epizody jako niezweryfikowana interpretacja, a rekordy semantyczne
  trafiają do `krn-memory` przez promocję. Warunek wyjścia to sparowana ewaluacja M-10 [CODE ADR0008:146].
- **Proweniencja:** czytnik weryfikuje tylko `file:` z SHA-256. Rekordy z HTTPS i URN są `source_unavailable`
  [CODE read-cli.mjs:101-110; OURS-EVIDENCE kapsuła: 15 HTTPS/Git i 12 bez pliku/hasha]. To trzeba naprawić przed
  jakimkolwiek recall, przez lokalne snapshoty bound do rewizji albo autoryzowany weryfikator [HYPOTHESIS R5:54].
- **Retencja, zapominanie, zakres i osobna kwalifikacja aktywacji** obowiązują według ADR 0009 [CODE ADR0009:99+].
- **Dowody zewnętrzne** [EMPIRICAL R5:44; J2-Sol]:
  - Zweryfikowane doświadczenie dało +1,1–4,5 pp, ale wszystkie pięć przedziałów ufności przecina zero.
  - Jedna para z istniejącym systemem pamięci poprawiła wynik. Zdanie „niezweryfikowana pamięć nie działa” jest więc za mocne.
  - Wniosek ograniczam do tego, że pamięć wymaga pomiaru na naszych zadaniach.
- **Mastra:** bierzemy kompresję wyzwalaną progiem (u nas reset supervisora) i datowane obserwacje (decyzje w kapsule).
  Odrzucamy Observer/Reflector jako władzę stanu [POLICY]. Domyślne wartości różnią się między wersjami (ogłoszenie
  a checkout) [CODE R5:59].
- **remember:** bierzemy jawny handoff, cooldown i zachowanie źródła przy porażce konsolidacji.
- **beads:** bierzemy ready i prime, bez drugiego trackera.

## 7. Stack i standardy [POLICY]

- **Runtime:** Node 24 LTS, patch ≥24.12. Wybieramy minimum dla stabilnego type strippingu; floor Paperclip to 24.11
  [VENDOR R7:4,29]. Uruchamiamy `.ts` bezpośrednio, więc obowiązuje `erasableSyntaxOnly`. Node 26 rozważamy po LTS.
- **Narzędzia:**
  - TS 7.0.x wyłącznie jako typechecker;
  - pnpm 12;
  - testy na `node:test`, bo oba źródła kamieniołomu go używają (świadome odejście od Vitest z R7);
  - Biome jako lint;
  - Zod 4 jako jedyny właściciel parsowania, a `Result` piszemy ręcznie;
  - Effect nie na start: spike dopiero po odtworzonym błędzie zasobów, którego nie rozwiąże prosty `AbortController`.
- **SQLite:** `node:sqlite` ma status **Release Candidate (1.2)** [VENDOR R7:25]. Przed użyciem w `trace` potrzebna jest
  kwalifikacja: blokady, restart, backup/restore, migracja. FTS5 wymaga osobnej kwalifikacji w etapie 3. Fallback to
  better-sqlite3. Użycie w `krn-factory` nie kwalifikuje dziennika.
- **Flagi tsconfig:** strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, NodeNext.
- **Odrzucone na start:** tsc-rs, Bun, tsdown.
- **Higiena starego repo:** `.node-version` (22.23.3) i `.nvmrc` (22.11.0) do ujednolicenia [OURS-EVIDENCE R7:52].

## 8. Architektura jako kod [POLICY]

- **Bez** obowiązkowego gate'u „dokumentacja na każdą zmianę granicy” (propozycja sceptyka).
- **MADR** dla decyzji trudnych do odwrócenia.
- **Jeden diagram Mermaid** w `docs/architecture.md`.
- **Reguła importów:** `core` nie importuje `hosts/`, `ledger/` ani `trace/`. Sprawdza ją skrypt w gate. Chroni
  wymienialność Paperclip i hostów.
- **Structurizr:** R7 rekomenduje go jako model kanoniczny. Przesuwam go do momentu, gdy pojawi się drugi czytelnik
  modelu. To [POLICY], nie wniosek z R7.

## 9. Jak piszemy kod w krn

Źródło: R10 (micrograd, nanoGPT, nanochat, autoresearch). Reguły to [POLICY] z uzasadnieniem w [CODE R10].
Minimalizm Karpathy'ego jest *zakresowany*. To kod dydaktyczny o zaufanym wejściu, a nanochat rośnie tam, gdzie domena
tego wymaga [CODE R10:4].

**K1. Prymitywem rdzenia jest `Job`.** `Job` to `{id, issue, worktree, epoch, state}`. Każdy moduł jest funkcją
na Jobie: `relay` go rzutuje, `foreman` uruchamia, `verdict` osądza kandydata, `ledger` mapuje na issue, `trace`
loguje. Działa to jak `Value` w micrograd, czyli jeden typ, przez który wszystko się składa [CODE micrograd/engine.py:2-70].

**K2. Pętla J1 mieści się na jednym ekranie** (≤40 linii) w `src/foreman/run.ts`. Jeśli przestaje się mieścić,
złą abstrakcją jest pętla, nie ekran. Wtedy przepisujemy pętlę, nie dokładamy helperów.

**K3. Pliki czyta się z góry na dół.** Nagłówek ma 1–3 linie z niezmiennikiem i ID ADR. Potem typy, funkcja główna
i helpery w kolejności wywołań. Bez barrel/`index.ts`, bez interfejsów jednorazowych. Komentarze opisują niezmienniki,
kompromisy i „dlaczego”, nie składnię [CODE nanoGPT/model.py:33-50].

**K4. Pomijamy tylko to, co kontrakt zakresu czyni bezpiecznym.** Zakres to jeden operator, jedna maszyna i zaufane
lokalne repo.
- *Wolno pominąć:* multi-tenant auth, system pluginów, framework konfiguracji (jeden plik ≤10 kluczy), retry na
  wszystko, abstrakcje „na przyszłość”.
- *Nie wolno pominąć:* CAS i fencing, idempotencji, anulowania, recovery po crashu, kontroli władzy, odrzucania
  sekretów, trwałego trace. Szkic z R10 pomija je świadomie, a kod produkcyjny nie może [HYPOTHESIS R10 §4].

**K5. Próg „przepisz zamiast dokładać warstwę”.** Funkcja przepisywana jest razem z testami, jeśli zachodzi jedno z:
- zmiana wymaga trzeciej flagi lub trybu w tej samej funkcji;
- powstaje wrapper na wrapperze;
- plik przekracza ~300 linii (orientacyjnie nanoGPT `model.py` ma 330; to punkt odniesienia, nie prawo).

Usunięcie flagi liczy się jako postęp.

**K6. Porty tylko z realnym drugim adapterem w planie etapów.** Dotyczy to `ledger` (Paperclip i ręczny) oraz `hosts`
(codex, claude, pi). Pozostałe moduły są konkretne.

**K7. Błędy.** Oczekiwane wyniki zwracamy jako `Result`, a wyjątek rzucamy tylko przy bugu. Na każdej granicy procesu,
pliku i sieci obowiązuje parsowanie Zod.

**K8. Testy.** Jeden falsyfikator na kontrakt runtime, pokazany najpierw jako czerwony. Fake'i są dozwolone tylko na
portach. **Moduł nie jest „gotowy” bez jednego przebiegu na realnym hoście.** To reguła anty-`krn-factory`.

**K9. Jeden dział złożoności.** Budżet `foreman` to jeden obiekt `budget`, a nie rozproszone stałe [CODE nanochat/README.md:6,108].

**K10. Zero zależności runtime poza Zod na start.**

**Szkic pętli J1** [HYPOTHESIS; ilustracja, nie implementacja]:

```ts
// src/foreman/run.ts — J1: przerwane zadanie -> świeże sesje -> werdykt -> in_review (ADR 0007).
export async function runJob(job: Job, d: Deps): Promise<Outcome> {
  const contract = await d.ledger.readContract(job.issue);        // władza: Paperclip
  let capsule = await d.relay.load(job, contract);                 // widok kontynuacji
  for (let resets = 0; resets <= d.budget.maxResets; resets++) {
    const facts = await d.relay.repoFacts(job);                    // HEAD, status, diffstat
    const valid = d.relay.validate(capsule, facts);                // degradacje LT-6
    if (!valid.ok) return d.stop(job, "human_decision", valid.reasons);
    const session = await d.hosts.codex.start({
      cwd: job.worktree, model: "gpt-6-luna",
      prompt: d.relay.project(capsule, facts), limits: d.budget.session,
    });
    await d.trace.log(job, "session_started", { epoch: capsule.epoch, id: session.id });
    const end = await session.wait();                              // exit | high_water | timeout | crash
    await d.trace.log(job, "session_ended", end);
    capsule = await d.relay.refresh(capsule, await d.relay.repoFacts(job), end); // CAS job.id+epoch
    if (end.reason !== "exit" || !end.claimsDone) continue;        // nowa epoka, świeża sesja
    const v = await d.verdict.judge(job, contract, capsule.head);  // gate'y + sędziowie Luna na SHA
    await d.trace.log(job, "verdict", v);
    if (v.kind === "pass") return d.ledger.submitForReview(job, v); // in_review; akceptuje lead
    if (capsule.repairs >= d.budget.maxRepairs) break;
    capsule = d.relay.withFindings(capsule, v.findings);           // runda naprawy
  }
  return d.stop(job, "human_decision", ["budżet resetów lub napraw wyczerpany"]);
}
```

## 10. KRN Spec Language v0 (AGENTS.md, skille, briefy)

Źródło: R11. Struktura jest [HYPOTHESIS] i zostaje przyjęta dopiero po sondzie z §10.6 [POLICY]. Benchmarki (IFEval,
ManyIFEval, AGENTIF, IFScale) uzasadniają pomiar naszych reguł, ale nie dają limitów [EMPIRICAL R11:1]. Nie znalazłem
dowodu, że sformułowania pozytywne albo uzasadnienia poprawiają przestrzeganie [UNKNOWN R11:5].

### 10.1 Anatomia reguły

Format rekordu:

`ID | wyzwalacz | akcja | właściciel (rola działająca) | egzekucja: hook|test|gate|none + nazwa sprawdzenia | uzasadnienie ≤1 linia (≤20 słów)`

Wzorce zdań:
- `KRN-<ID> <ROLA> MUST <jedna obserwowalna akcja>.`
- `KRN-<ID> When <wyzwalacz>, <ROLA> MUST <akcja>.`
- Uprawnienie: `<ROLA> MAY <akcja> when <warunek>.`
- Przykład w formie Given/When/Then, oznaczony jako nienormatywny.

Uwagi:
- Wiele akcji wolno trzymać w jednej regule tylko wtedy, gdy mają ten sam wyzwalacz, właściciela i sprawdzenie.
- `none` oznacza prozę. Reguła `none`, której naruszenie da się wykryć mechanicznie, dostaje w rejestrze termin migracji
  do hook/test/gate.

### 10.2 Słowa kluczowe

Według RFC 2119/8174 i tylko wielkimi literami: `MUST`, `MUST NOT`, `SHOULD` (z nazwanym dozwolonym odstępstwem), `MAY`.
Poza regułami piszemy zwykłym językiem.

### 10.3 Konstrukcje zakazane

- Rozmyte słowa bez progu: „usually”, „rarely”, „when appropriate”, „try”.
- Żargon bez wpisu w słowniku.
- Łańcuchy niezależnych obowiązków spięte średnikami.
- „be careful”, „use good judgment” bez obserwowalnej decyzji.
- Sam zakaz, gdy można nazwać właściwą akcję. `MUST NOT` jest dozwolone, najlepiej z bezpieczną alternatywą.
- Synonimy terminów słownikowych.

### 10.4 Słownik

Każdy termin jest zdefiniowany raz w `CONTEXT.md`, w instrukcjach używany zawsze tym samym słowem, a przy pierwszym
użyciu poza słownikiem dostaje definicję w jednym zdaniu. [POLICY] Limit to ≤40 terminów. Bez ogólnej angielszczyzny.

### 10.5 Opis skilla jako router

[VENDOR R11:4] Wzorzec opisu:

`Use when <zadanie/wyzwalacz>; produces <wynik>. Skip when <najbliższy konkurent>.`

[POLICY] Opis ma ≤40 słów. Procedura trafia do ciała skilla (≤200 linii), a szczegóły do `references/`.

### 10.6 AGENTS.md generowany z rejestru i sonda

- **Rejestr.** `spec/rules.json` to jedyne źródło reguł; każda reguła ma zakres `global|repo|host:claude|host:codex`.
- **Generowanie.** `krn spec render` generuje `AGENTS.md`, globalny kontrakt i blok dla Claude. Gate wymaga, by wynik
  renderowania był równy plikowi w commicie. Instalacja kopiuje plik wygenerowany, a `krn doctor` porównuje hash kopii
  zainstalowanej z wydaniem.
- **Dryf.** To usuwa zmierzony dryf: źródło ma blok „Execution standard”, którego nie ma w kopii zainstalowanej
  [OURS-EVIDENCE diff config/AGENTS.md vs ~/.codex/AGENTS.md]. Naprawa w starym repo to ponowna instalacja, co wymaga grantu.
- **Budżety startowe** [POLICY, R11]: zawsze ładowany `AGENTS.md` ≤100 linii i ≤1,5k tokenów; suma zawsze ładowanych
  ≤3k tokenów.
- **Sonda zgodności** [POLICY, R11]:
  - 8 zamrożonych zadań KRN: wyzwalacze bezpośrednie, near-miss routingu, konflikt z instrukcją niższej rangi,
    reguła warunkowa;
  - wersja stara i nowa w losowej kolejności, ten sam model (Luna), te same narzędzia, 2 powtórzenia na ramię;
  - punktacja pass/fail per reguła, przez sprawdzenie deterministyczne albo ślepą rubrykę;
  - mierzymy też zły wybór skilla, akcje niebezpieczne i tokeny;
  - przyjęcie wymaga poprawy przestrzegania w parach i zera regresji krytycznych.

  Proza nie jest granicą bezpieczeństwa. Granice egzekwują hooki i gate'y.

### 10.7 Co bierzemy z `autoresearch/program.md`

[CODE R10:3] **Bierzemy** szablon briefu:
1. cel jednym zdaniem;
2. checklista setupu;
3. pliki zmienne i tylko do odczytu;
4. stała metryka z komendą jej ekstrakcji;
5. przykładowy output;
6. wiersz dziennika z wynikiem także przy porażce;
7. reguły keep, discard i crash;
8. limit czasu na przebieg.

**Odrzucamy:**
- „NEVER STOP” i zakaz pytania człowieka;
- pętlę bez limitu liczby, czasu, budżetu i plateau;
- jakościowy tie-break bez właściciela.

Każdy brief krn MUST mieć warunek stopu, budżet i ścieżkę `human_decision` [POLICY].

### 10.8 Pięć przepisań naszych zdań

1. Przed, `config/AGENTS.md:22`: „Recorded authority may cover commit/push/PR/merge without repeat prompts; credentials,
   non-Git remotes, install/seal, hook trust and irreversible actions need separate grants; never log or persist secrets.”
   Po (trzy rekordy):
   - `KRN-03a When recorded authority covers Git publication, the lead MAY commit, push, open a PR or merge without asking again. | gate: authority-record`
   - `KRN-03b Before touching credentials, non-Git remotes, install/seal, hook trust or an irreversible action, the lead MUST hold a separate recorded grant. | hook: guard`
   - `KRN-03c Every agent MUST NOT log or persist secrets. | gate: secretTextKind`
2. Przed, `config/AGENTS.md:55`: „Every update names owner, evidence, next action; never claim completion without
   observed evidence or readback. A deterministic falsifier outranks model review; same-model self-assessment is never
   proof; show new falsifiers failing first.”
   Po:
   - `KRN-07a Each progress update MUST name owner, evidence and next action. | none`
   - `KRN-07b Before claiming completion, the lead MUST read back the observed effect. | gate: readback`
   - `KRN-07c A new falsifier counts only after it fails at base. | gate: changes check --before`
   - `KRN-07d When a deterministic check and a model review disagree, the check decides. | none`
3. Przed, `~/.claude/CLAUDE.md`: „Use Claude/Opus subagents rarely; they spend the same quota.”
   Po: `KRN-C1 The Claude lead MAY spawn a Claude subagent only when the operator asks for one. | none | Claude quota is the scarcest resource (ADR 0010).`
   To przepisanie zgadza się z obecną regułą narzędzia Agent.
4. Przed, `AGENTS.md:47-50`: „Retire an owned merged branch locally and remotely, and remove its worktree, in the same
   close-out under recorded deletion authority.”
   Po: `KRN-10 When an owned branch is merged and recorded deletion authority covers it, the owner MUST delete the local branch, the remote branch and the worktree in the same close-out. | test: closeout-readback`
5. Przed, opis `delivery-loop/SKILL.md:3`: „Coordinate one accepted outcome whose success is agreed through composed owners,
   fixed-point review, and authorized publication state…”
   Po: `Use when one accepted outcome must be delivered end to end, through review and authorized publication. Skip single edits, diagnosis-only and review-only work.`
   Termin „fixed point” znika na rzecz „exact reviewed commit”.

## 11. Role i delegacja

**Obecny stan zapisany** [CODE ADR0010:8,25-37]:
- Zakres to sesje Claude Code.
- Lead w Claude nie implementuje.
- Worker domyślnie Luna; eskalacja do Sol przy braku postępu.
- Sędziowie to świeże sesje Sol.
- [CODE ADR0007:36-40] Standards i Spec oceniają odrębni, niezależni agenci, a autor nigdy nie ocenia sam siebie.

**Decyzja operatora z 2026-10-07** [POLICY]: Luna jest wyłącznym modelem workerów, sędziów i adwokatów diabła. Sol 6.1
pracuje tylko na wyraźne życzenie operatora.

Ta decyzja **zastępuje** eskalację do Sol i sędziów Sol z ADR 0010. Do spójności potrzebne są:
- poprawka ADR 0010;
- zmiana `~/.claude/CLAUDE.md`, który nadal kieruje review do „fresh gpt-6.1-sol” i eskalację do Sol;
- oznaczenie notatek pamięci jako zastąpionych.

Do czasu tych zmian dokumenty są w konflikcie. Zgłaszam to, ale nie nadpisuję.

**Dowody o sędziowaniu Luny.** Są dwie pary ocen tego samego materiału: 4 wobec 5 (v1) i 6 wobec 6 (v2). Zgodność
ocen nie oznacza poprawności. W v1 różniły się werdykty na poziomie twierdzeń (T6.3, T9.1), ale nie diagnozuję
z tego przyczyny. Wniosek: brak przeciwwskazań, brak kwalifikacji [OURS-EVIDENCE J1/J2].

**Ryzyko nowej polityki.** Worker i sędzia to teraz ten sam model, więc korelacja ślepych plam rośnie
[EMPIRICAL R6:39-42; HYPOTHESIS R6:41].

**Mitigacje** [POLICY]:
1. **Kontrole deterministyczne rozstrzygają wszędzie, gdzie istnieją.** Sędzia ocenia tylko to, czego gate nie rozstrzyga.
2. **Różnorodność przez soczewki.** Każda soczewka ma osobny brief, checklistę i ślepotę na inne werdykty:
   - *Standards*: reguły z rejestru;
   - *Spec*: kontrakt i kryteria;
   - *Adwersarz*: szuka najdroższego błędu;
   - *Fidelity*: każde twierdzenie prowadzi do źródła; sędzia ma obowiązek *wykonać* wskazane komendy i otworzyć
     pliki, do których prowadzą odsyłacze.
   Abstencja („unknown”) jest dozwolona i wymagana przy braku dowodu [VENDOR R6:40].
3. **Tripwire.** Gdy sędzia Luna przepuści defekt, który dało się wykryć deterministycznie (ujawniony później przez
   CI, rewert lub audyt):
   - (a) dodajemy tę kontrolę do gate'u, czyli przenosimy klasę z sędziego do automatu;
   - (b) zapisujemy incydent w `trace`;
   - (c) przy 2 incydentach na 20 kolejnych osądzonych PR lead przedstawia operatorowi raport z propozycją
     (np. Sol dla tej klasy).
   Przełączenie nigdy nie jest automatyczne, bo Sol pracuje tylko na życzenie.
4. **Kwalifikacja wobec prawdy, nie wobec Sol.** Zestaw 20 elementów z prawdą ustaloną przez leada i operatora,
   w tym ≥30% podłożonych defektów (dowód w innym pliku, overclaim, zakres). Mierzymy false-accept, false-reject,
   abstencję i koszt. Wyniki to dane, a progi ustala operator.

**Lead** to rola, nie model: planuje, decyduje, integruje i akceptuje zgodnie z ADR 0007. Domyślnie Opus w Claude
Code (ADR 0010). Lead w Codex jest dopuszczalny zakresem ADR 0010, ale model leada w Codex nie jest objęty decyzją
„tylko Luna”. Pozostaje otwarty (§13). Równoważności Opus i Sol jako leadów nie zmierzono [OURS-EVIDENCE J2-Sol T10.1].

**Łączenie analiz** [POLICY]: twierdzenia niosące decyzje sprawdzamy w źródle pierwotnym, spór rozstrzyga dowód,
odwrócenia zapisujemy jawnie. DA i fidelity tylko dla syntez programowych.

## 12. Etapy, ryzyka, tripwire'y

Wszystkie pozycje w tej sekcji to [POLICY], bez dat.

- **E0 — przygotowanie.**
  - Operator zamyka decyzje z §13.
  - Naprawy w starym repo:
    - ścieżka klonu pamięci w ADR 0008:54;
    - poprawka ADR 0010 i CLAUDE.md;
    - `.nvmrc`;
    - wskaźnik z `tracker-migration.md:7` do poprawki akceptacji;
    - warunek lessons „aktywne do M-8” zapisany raz.
  - Baseline 3 zadań.
  - *Wyjście:* baseline zapisany.
- **E1 — J1 na żywo.** Moduły `core`, `relay`, `foreman`, `ledger`, `verdict` (wrapper), `trace`, `hosts/codex`, `cli`
  oraz `krn-next`.
  - *Wyjście:* ≥3 zaakceptowane wyniki, mediana minut operatora na wynik ≥30% niższa niż w baseline, zero utraconych
    zobowiązań i nieautoryzowanych efektów.
- **E2 — utwardzenie.** Cutover `krn`/`krn-legacy` (§3.3), migracja `state` do `relay`, hook SessionStart przez nowe CLI,
  `hosts/pi` i opcjonalnie E-1.
  - *Wyjście:* 10 podróży, przypadki regresji zielone.
- **E3 — pamięć** warunkowo (§6).
- **E4 — `verdict` jako właściciel**, punkt decyzji o Paperclip, migracja reszty komend. `krn-legacy` znika.

**Jedno kryterium zabicia.** Po 6 podróżach w ramieniu B, jeśli mediana minut operatora na zaakceptowany wynik nie jest
co najmniej 30% niższa niż w baseline, rdzeń zostaje zamrożony. Operator decyduje wtedy, czy przenieść `relay` i
`foreman` do starego repo, czy je porzucić.

| Ryzyko | Tripwire |
|---|---|
| Kolejna linia bez realnego użycia | Brak realnego wznowienia realnego zadania przed 15. commitem; moduł bez konsumenta w J1 |
| Teatr pomiarowy | Konfiguracja pomiaru >4 h; przypadek bez incydentu |
| Podwójny wzrost | Nowa funkcja w `krn-codex-skills` po E0 (dozwolone są tylko poprawki, strangler i naprawy z E0) |
| Pętle i koszt | >3 resety na epokę albo przekroczony pułap tokenów: stop i `human_decision` |
| Drugi tracker | Pole statusu w `trace` |
| Kolizja `krn` | `command -v -a krn` pokazuje dwa linki albo `install apply` przywraca stary link |
| Monokultura Luna | Tripwire z §11 |
| Prywatność | Transkrypt poza hostem albo w pamięci: stop E-1 |
| Overclaim | Wynik bez `n` i etykiety |

## 13. Otwarte decyzje operatora (maks. 5)

1. **Formalizacja polityki „tylko Luna”.** Potrzebna zgoda na poprawkę ADR 0010 (PR przez Lunę) i na zmianę Twojego
   `~/.claude/CLAUDE.md`, który dziś każe sędziować w Sol. Do rozstrzygnięcia także model leada w Codex: Luna czy Sol
   na życzenie. **Rekomendacja:** obie zmiany tak; lead w Codex to Sol tylko na Twoje wyraźne życzenie, poza tym lead
   Opus.
2. **Projekt i rodzina zadań dla J1 i baseline'u.** Proponuję 3 zadania, w tym co najmniej 2 spoza KRN, oraz zgodę na
   logowanie minut i dotknięć operatora w `trace`. **Rekomendacja:** projekt, który i tak ma wieloetapową pracę w
   kolejce Paperclip.
3. **Grant instalacyjny w dwóch krokach.** Teraz link `krn-next`. Przy cutover: przemianowanie binarium starego wydania
   na `krn-legacy`, link `krn` do nowego i ponowna instalacja, która usuwa dryf AGENTS.md. **Rekomendacja:** tak, z
   odczytem zwrotnym z §3.3.
4. **Ścieżka klonu pamięci.** ADR 0008:54 wskazuje `~/.local/share/krn/memory`, a reguła ścieżek `~/coding/krn/active/`.
   **Rekomendacja:** `~/coding/krn/active/krn-memory`.
5. **Akceptacja wartości [POLICY].** Chodzi o: kryterium zabicia (6 podróży, 30%), próg zastąpienia Paperclip
   (10 podróży, 25% plus kwalifikacja), wejście w pamięć (3 incydenty między zadaniami), tripwire Luny (2 na 20)
   oraz zakaz transkryptów z bramką E-1. **Rekomendacja:** przyjąć jako wartości startowe z rewizją po E1.
