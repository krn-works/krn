> **Historical target snapshot (2026-10-07).** Current implementation and proposed architecture follow-up: [architecture](../architecture.md); current stage proofs and limits: [roadmap](roadmap-2026-10-20.md). The dated design and original rationale below remain intact.

# Blueprint v4: program KRN A–Z (redakcja, 2026-10-07)

**Wejście.** Synteza v3, raport J3 fidelity-Luna i decyzje operatora z `charter.md` (2026-10-07). Dodatkowo sprawdziłem ręcznie trzy rzeczy: `~/.local/bin/krn` wskazuje na
`~/.codex/krn/current/scripts/krn.mjs`; katalog binariów instalatora to `KRN_BIN_DEST` lub `~/.local/bin`
(`install-inspect.mjs:312`); stara lista komend pochodzi z `krn --help`.

**Etykiety.** Używam etykiet z `_common.md` i jednej nowej: **[POLICY]** oznacza wybraną regułę operacyjną. Taka reguła
nie jest wnioskiem z dowodów i podlega korekcie na danych.

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

Mechanizmy poniżej to [HYPOTHESIS] do sprawdzenia w J1; progi to [POLICY], przyjęte do rewizji po E1. Fakty mają własne etykiety.

| Paradoks | Mechanizm | Falsyfikator |
|---|---|---|
| **Gotowe ≠ zaakceptowane.** | Worker kończy w stanie `in_review`. Akceptacja następuje według ADR 0007: wymagane CI, sędziowie na dokładnym SHA, merge i odczyt zwrotny [CODE ADR0007:29-57]. | Odsetek zaakceptowanych zmian cofniętych z powodu niespełnionego kontraktu nie spada względem baseline'u. |
| **Ciągłość.** Długa sesja kompaktuje kontekst, a świeża zaczyna od zera. | Kapsuła, deterministyczne odświeżanie faktów i świeże sesje uruchamiane przez supervisora. LT-6 dał 3/3 wobec 0/3 na jednym zadaniu ze skryptowaną kapsułą; nie testował kapsuł pisanych przez agentów ani generalizacji [OURS-EVIDENCE lab-tests.md:53]. W tym samym LT ramię in-session compaction przeszło z hookiem i bez niego, więc efektu nie wyizolowano. | Incydenty utraty etapu lub prompty rekonstrukcyjne nie spadają. |
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

**Status dowodowy.** Dowody nie wybierają topologii [OURS-EVIDENCE J2-Sol §3]. Nie porównano kosztu naprawy w miejscu, warunkowej adopcji `krn-harness` ani nowego rdzenia; granice produkcyjne `krn-harness` pozostają niezamknięte [HYPOTHESIS R3:63].

Operator wybrał nowy rdzeń. Ryzyko ekonomiczne zabezpieczają dwie zasady:
- nowy kod **wywołuje** gate'y, instalator i katalog starego repo zamiast je przepisywać;
- obowiązuje jedno kryterium zabicia (§12) [POLICY].

### 3.2 Moduły (analiza pudełek)

`src/` w jednym pakiecie. Kolumna „Etap” mówi, kiedy moduł powstaje [POLICY].

| Moduł | Konsument | Odpowiedzialność | Źródło prawdy | Interfejs | Cykl życia | Zależności | Konflikt obowiązków | Migracja / wycofanie | Falsyfikator |
|---|---|---|---|---|---|---|---|---|---|
| `core` | wszystkie | typy `Job`, `Result`, parsowanie granic | — | typy i walidatory | od startu; ocena po E1 | brak adapterów | typ wspólny może nadmiernie uogólniać | pakiet dopiero przy drugim konsumencie; usuń nieużywane typy | import adaptera |
| `relay` | foreman, SessionStart | kapsuła, wznowienie, handoff, CAS; projekcja ≤2k tokenów [POLICY] | plik kapsuły dla kontynuacji | `load/validate/refresh/project` | od J1; utrzymuje format kontynuacji | `core`, repo, `memory` | aktualność HEAD kontra dostępność po awarii | zachowaj ABI; wycofaj po migracji odbiorców | świeża sesja gubi etap |
| `foreman` | operator, lead | supervisor sesji z kolejki, budżety, eskalacja | przebieg w `trace`; status w Paperclip | `runJob` | J1; ewoluuje po E1 | `ledger`, `relay`, `hosts`, `verdict` | postęp kontra limity i zatrzymanie | migracja podróży; zamrożenie wg kryterium zabicia | duplikat pracy lub zgubiony commit |
| `ledger` | foreman, verdict | port pracy; Paperclip board-only i kontrakt ręczny [POLICY] | Paperclip dla statusu/akceptacji | `readContract/submit` | Paperclip od J1; decyzja w E4 | `core`, Paperclip | buforowany kontrakt kontra nieaktualny status | następca po kwalifikacji, migracji i rollbacku | status zapisany poza Paperclip |
| `verdict` | foreman | gate'y i sędziowie Luna na exact SHA | CI i dowody `krn/judge-*` | `judge(job, sha)` | wrapper J1, właściciel E4 | `ledger`, gate'y, Luna | niezależność sędziego kontra Luna-only | przenieś po parytecie; usuń `krn-legacy` po ostatniej komendzie | akceptacja bez kompletu dowodu |
| `trace` | wszystkie, ewaluacja | dziennik metryk, bez statusu zadania | SQLite | `log/report` | od J1; retencja do ustalenia | `core`, `node:sqlite` | pomiar kontra prywatność i koszt | eksport; wycofaj po odtworzeniu metryk | metryka nieodtwarzalna |
| `hosts` | foreman, relay | uruchamianie hostów; J1 codex/Luna | proces hosta | `start/wait/cancel` | codex J1; Pi E2; Claude jako widok leada | `core`, procesy systemowe | dostępność kontra izolacja | adapter per host; usuń po wycofaniu hosta | proces bez ID/anulowania drzewa |
| `memory` | relay | wskaźniki od startu; zdarzenia warunkowo w E3 | klon `~/coding/krn/active/krn-memory`, SQLite | odczyt wskaźników; zapis warunkowy | wskaźniki J1; decyzja po E1; zdarzenia E3 | `relay`, `trace`, Git | użyteczność kontra prywatność/retencja | zachowaj źródła po błędzie; odłącz, gdy M-10 nie wykaże zysku | sparowane M-10 |
| `cli` | operator, hooki | komendy i forwarding | nowe i stare wydanie | `krn …` | od J1; migracja komend stopniowa | moduły, `krn-legacy` | przejęcie nazwy kontra zgodność hooków | parytet per komenda; usuń forwarder po migracji | nieznana komenda nie przechodzi |

`krn-memory` pozostaje osobnym repo danych jako kandydat. Granica nie jest zaakceptowana [OURS-EVIDENCE kapsuła discovery].

### 3.3 Strangler CLI i kolizja `krn`

**Fakty.** [OURS-EVIDENCE] `~/.local/bin/krn` wskazuje na `~/.codex/krn/current/scripts/krn.mjs`; instalator starego repo odtwarza link z tabeli `bin` w `package.json`. Stare CLI obsługuje `install`, `doctor`, `capability`, `repo`, `state`, `skills`, `lessons`, `changes`, `gate`, `conformance`, `memory` i `harness`.

**Plan [POLICY].** Nowe CLI przejmuje nazwę `krn` od razu. Nieznane komendy przekazuje przez `execFile` i `process.execPath` do zainstalowanego `KRN_LEGACY_ENTRY` (domyślnie `~/.codex/krn/current/scripts/krn.mjs`); zachowuje argumenty, strumienie i kod wyjścia. Blokuje rekursję, gdy cel wskazuje na własny plik albo `KRN_FORWARDED=1` (kod 70). `--version` pokazuje obie wersje.

Cutover wymaga grantu instalacyjnego i kolejności: (1) stary bin zmienia się w `krn-legacy`; (2) hook SessionStart przechodzi sprawdzenie na nowym CLI przed swapem; (3) instalator usuwa wyłącznie własny stary link; (4) nowe wydanie instaluje `krn`; (5) odczyt zwrotny sprawdza `command -v -a krn`, wersję i parytet `krn state check --json` z `krn-legacy state check --json`. Zmiana tabeli bin jest warunkiem, bo stary `install apply` inaczej odtworzy `krn`. Każda komenda zmienia właściciela dopiero z parytetem JSON na tej samej fiksturze i usunięciem starego kodu w tym samym cyklu; po ostatniej migracji znika `krn-legacy`.

### 3.4 Źródła mechanizmów

Źródła są kopalnią wzorców, nie gotową architekturą. `krn-factory` wnosi WAL/replay, dzierżawy i limit dwóch napraw; stare repo — ABI kapsuły, ADR 0007, `secretTextKind` i allowlistę; `krn-harness` — verify i trace. ts-rust wnosi blokadę akceptacji po utraconym passie; Gas Town — no-repeat; beads — ready/prime; `mini-agi` — zamrożony brief [CODE]. Pi Durable (7/10) miało błędy obciętego outputu, przeżywającego procesu potomnego i replayu pomijającego zmienioną bramkę [OURS-EVIDENCE R1:35]. Wybór mechanizmów pozostaje [HYPOTHESIS].

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

Brain v2 record, ingestion, retrieval, and evaluation design: [ADR 0002](../adr/0002-brain-v2.md).

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

- **Runtime:** Node 24 LTS, patch ≥24.11 zgodnie z floor Paperclip [VENDOR R7:4,29]. Uruchamiamy `.ts` bezpośrednio, więc obowiązuje `erasableSyntaxOnly`. Node 26 rozważamy po LTS.
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

**K1. [POLICY]** `Job` to wspólny identyfikator `{id, issue, worktree, epoch}`. Status nie należy do `Job`; `Job.state` jest tylko projekcją statusu Paperclip, nigdy osobną władzą. Analogia do `Value` w micrograd jest inspiracją, nie dowodem uniwersalności [CODE micrograd/engine.py:2-70].

**K2. [POLICY]** Pętla J1 ma cel ≤40 linii w `src/foreman/run.ts`. Graniczne parsowanie i I/O wolno wydzielić do helperów; jeśli sama orkiestracja przekracza limit, upraszczamy ją lub zmieniamy abstrakcję.

**K3. [POLICY] Pliki czyta się z góry na dół.** Nagłówek ma 1–3 linie z niezmiennikiem i ID ADR. Potem typy, funkcja główna
i helpery w kolejności wywołań. Bez barrel/`index.ts`, bez interfejsów jednorazowych. Komentarze opisują niezmienniki,
kompromisy i „dlaczego”, nie składnię [CODE nanoGPT/model.py:33-50].

**K4. [POLICY] Pomijamy tylko to, co kontrakt zakresu czyni bezpiecznym.** Zakres to jeden operator, jedna maszyna i zaufane
lokalne repo.
- *Wolno pominąć:* multi-tenant auth, system pluginów, framework konfiguracji (jeden plik ≤10 kluczy), retry na
  wszystko, abstrakcje „na przyszłość”.
- *Nie wolno pominąć:* CAS i fencing, idempotencji, anulowania, recovery po crashu, kontroli władzy, odrzucania
  sekretów, trwałego trace. Szkic z R10 pomija je świadomie, a kod produkcyjny nie może [HYPOTHESIS R10 §4].

**K5. [POLICY] Próg „przepisz zamiast dokładać warstwę”.** Funkcja przepisywana jest razem z testami, jeśli zachodzi jedno z:
- zmiana wymaga trzeciej flagi lub trybu w tej samej funkcji;
- powstaje wrapper na wrapperze;
- plik przekracza ~300 linii (orientacyjnie nanoGPT `model.py` ma 330; to punkt odniesienia, nie prawo).

Usunięcie flagi liczy się jako postęp.

**K6. [POLICY] Porty tylko z realnym drugim adapterem w planie etapów.** Dotyczy to `ledger` (Paperclip i ręczny) oraz `hosts`
(codex, claude, pi). Pozostałe moduły są konkretne.

**K7. [POLICY] Błędy.** Oczekiwane wyniki zwracamy jako `Result`, a wyjątek rzucamy tylko przy bugu. Na każdej granicy procesu,
pliku i sieci obowiązuje parsowanie Zod.

**K8. [POLICY] Testy.** Jeden falsyfikator na kontrakt runtime, pokazany najpierw jako czerwony. Fake'i są dozwolone tylko na portach. Moduły zależne od hosta wymagają przebiegu na realnym hoście; host-independent, np. `core`, wymagają testu rzeczywistej granicy bez hosta.

**K9. [POLICY] Jeden dział złożoności.** Budżet `foreman` to jeden obiekt `budget`, a nie rozproszone stałe [CODE nanochat/README.md:6,108].

**K10. [POLICY] Zero zależności runtime poza Zod na start.**

**Szkic pętli J1** [HYPOTHESIS; ilustracja, nie implementacja]:

```ts
// Ilustracja J1; status jest wyłącznie projekcją Paperclip.
export async function runJob(job: Job, d: Deps): Promise<Outcome> {
  const contract = await d.ledger.readContract(job.issue);
  let capsule = await d.relay.load(job, contract);
  let repairs = 0;
  for (let resets = 0; resets <= d.budget.maxResets; resets++) {
    const facts = await d.relay.repoFacts(job);
    const valid = d.relay.validate(capsule, facts);
    if (!valid.ok) return d.stop(job, "human_decision", valid.reasons);
    const intent = await d.trace.intent(job, capsule.epoch); // trwały zapis przed startem
    let session: Session | undefined;
    try {
      session = await d.hosts.codex.start({ cwd: job.worktree, model: "gpt-6-luna",
        prompt: d.relay.project(capsule, facts), limits: d.budget.session });
      if (!(await d.trace.started(intent, session.id))) throw new StaleSession();
      const end = await session.wait();
      if (!(await d.relay.isCurrent(job, capsule.epoch, session.id))) throw new StaleSession();
      await d.trace.log(job, "session_ended", end);
      const next = await d.relay.refreshCAS(capsule, await d.relay.repoFacts(job), end);
      if (!next.applied) return d.stop(job, "human_decision", ["konflikt rewizji"]);
      capsule = next.value;
      if (end.reason !== "exit" || !end.claimsDone) continue;
      const verdict = await d.verdict.judge(job, contract, capsule.head);
      if (verdict.kind === "pass") return d.ledger.submitForReviewCAS(job, verdict);
      if (repairs++ >= d.budget.maxRepairs) break;
      const repair = await d.relay.withFindingsCAS(capsule, verdict.findings);
      if (!repair.applied) return d.stop(job, "human_decision", ["konflikt rewizji"]);
      capsule = repair.value;
    } catch (error) {
      if (session) await d.hosts.cancelTree(session.id);
      await d.trace.failure(intent, error);
      return d.stop(job, "human_decision", ["błąd lub nieaktualna sesja"]);
    }
  }
  return d.stop(job, "human_decision", ["budżet wyczerpany"]);
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

- **Rejestr [POLICY].** `spec/rules.json` obejmuje wyłącznie reguły należące do repozytorium. Właściciel globalnego kontraktu pozostaje osobno; zakresy hosta należą do ich właścicieli.
- **Generator [PLAN].** Planowany `krn spec render` ma generować repozytoryjny `AGENTS.md`; gate porówna wynik z plikiem w commicie, a instalacja i `doctor` sprawdzą kopię wydania. Generator nie usunął jeszcze dryfu.
- **Dryf [OURS-EVIDENCE].** W źródle jest blok „Execution standard”, którego brakuje w zainstalowanej kopii (`config/AGENTS.md` vs `~/.codex/AGENTS.md`). Naprawa starego repo wymaga ponownej instalacji i grantu.
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
   Po (rekordy po jednej akcji):
   - `KRN-03a When recorded authority covers Git publication, the lead MAY commit without asking again. | gate: authority-record`
   - `KRN-03b When recorded authority covers Git publication, the lead MAY push without asking again. | gate: authority-record`
   - `KRN-03c Before handling credentials, the lead MUST hold a separate recorded grant; otherwise use a credential-free path. | hook: guard`
   - `KRN-03d Every agent MUST NOT log secrets; redact them before recording. | gate: secretTextKind`
   - `KRN-03e Every agent MUST NOT persist secrets; keep them in the approved secret store. | gate: secretTextKind`
2. Przed, `config/AGENTS.md:55`: „Every update names owner, evidence, next action; never claim completion without
   observed evidence or readback. A deterministic falsifier outranks model review; same-model self-assessment is never
   proof; show new falsifiers failing first.”
   Po:
   - `KRN-07a Each progress update MUST name its owner. | none`
   - `KRN-07b Each progress update MUST name its evidence. | none`
   - `KRN-07c Each progress update MUST name its next action. | none`
   - `KRN-07d Before claiming completion, the lead MUST read back the observed effect. | gate: readback`
   - `KRN-07e A new falsifier counts only after it fails at base. | gate: changes check --before`
   - `KRN-07f When a deterministic check and model review disagree, the check decides. | none`
3. Przed, `~/.claude/CLAUDE.md`: „Use Claude/Opus subagents rarely; they spend the same quota.”
   Po: `KRN-C1 The lead MAY use Claude for lead decisions only when the operator explicitly requests it. | none | Model choice is operator-controlled.`
   Workerzy i sędziowie pozostają wyłącznie na Lunie zgodnie z decyzją operatora.
4. Przed, `AGENTS.md:47-50`: „Retire an owned merged branch locally and remotely, and remove its worktree, in the same
   close-out under recorded deletion authority.”
   Po: `KRN-10 When an owned branch is merged and recorded deletion authority covers it, the owner MUST delete the local branch in the same close-out. | test: closeout-readback`
5. Przed, opis `delivery-loop/SKILL.md:3`: „Coordinate one accepted outcome whose success is agreed through composed owners,
   fixed-point review, and authorized publication state…”
   Po: `Use when one accepted outcome must be delivered end to end. Skip single edits. Review and publication remain separate gates.`
   Termin „fixed point” znika na rzecz „exact reviewed commit”.

## 11. Role i delegacja

**Historyczny stan ADR, zastąpiony decyzją operatora** [CODE ADR0010:8,25-37]:
- Zakres to sesje Claude Code.
- Lead w Claude nie implementuje.
- Worker domyślnie Luna; eskalacja do Sol przy braku postępu.
- Sędziowie to świeże sesje Sol.
- [CODE ADR0007:36-40] Standards i Spec oceniają odrębni, niezależni agenci, a autor nigdy nie ocenia sam siebie.

**Decyzja operatora z 2026-10-07** [POLICY]: Luna jest wyłącznym modelem workerów i sędziów; Sol 6.1 wyłącznie na wyraźne życzenie. Zastępuje to eskalację i sędziowanie Sol opisane w ADR 0010. Charter odnotowuje aktualizację ADR i `~/.claude/CLAUDE.md` jako wykonaną.

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
3. **Tripwire [POLICY].** Gdy sędzia Luna przepuści defekt, który dało się wykryć deterministycznie (ujawniony później przez
   CI, rewert lub audyt):
   - (a) dodajemy tę kontrolę do gate'u, czyli przenosimy klasę z sędziego do automatu;
   - (b) zapisujemy incydent w `trace`;
   - (c) przy 2 incydentach na 20 kolejnych osądzonych PR lead przedstawia operatorowi raport z propozycją
     (np. Sol dla tej klasy).
   Przełączenie nigdy nie jest automatyczne, bo Sol pracuje tylko na życzenie.
4. **Kwalifikacja wobec prawdy, nie wobec Sol.** Eksperyment z 20 elementami [POLICY], prawdą ustaloną przez leada i operatora,
   w tym ≥30% podłożonych defektów (dowód w innym pliku, overclaim, zakres) [POLICY]. Mierzymy false-accept, false-reject,
   abstencję i koszt. Wyniki to dane, a progi ustala operator.

**Lead** to rola, nie model: planuje, decyduje, integruje i akceptuje zgodnie z ADR 0007. Lead w Codex pozostaje otwartym wyborem (§13); równoważności Opus i Sol nie zmierzono [OURS-EVIDENCE J2-Sol T10.1].

**Łączenie analiz** [POLICY]: twierdzenia niosące decyzje sprawdzamy w źródle pierwotnym, spór rozstrzyga dowód,
odwrócenia zapisujemy jawnie. DA i fidelity tylko dla syntez programowych.

## 12. Etapy, ryzyka, tripwire'y

Wszystkie pozycje w tej sekcji to [POLICY], przyjęte 2026-10-07 i podlegające rewizji po E1.

- **E0 — przygotowanie.**
  - Decyzje z §13 zostały przyjęte; pozostają tylko wskazane kwestie otwarte.
  - Naprawy w starym repo:
    - ścieżka klonu pamięci w ADR 0008:54 na `~/coding/krn/active/krn-memory`;
    - poprawka ADR 0010 i CLAUDE.md;
    - `.nvmrc`;
    - wskaźnik z `tracker-migration.md:7` do poprawki akceptacji;
    - warunek lessons „aktywne do M-8” zapisany raz.
  - Baseline trzech zadań na `frontend-system` (Paperclip LON-x) i `krn-codex-skills` (sześć tanich napraw instrukcji); to cele J1.
  - *Wyjście:* baseline zapisany.
- **E1 — J1 na żywo.** Na `frontend-system` i `krn-codex-skills`: `core`, `relay`, `foreman`, `ledger`, `verdict` (wrapper), `trace`, `hosts/codex`, `cli`; instalacja od razu jako `krn`.
  - *Wyjście:* ≥3 zaakceptowane wyniki, mediana minut operatora na wynik ≥30% niższa niż w baseline, zero utraconych
    zobowiązań i nieautoryzowanych efektów.
- **E2 — utwardzenie.** Migracja `state` do `relay`, hook SessionStart przez nowe CLI, `hosts/pi` i opcjonalnie E-1; nazwa `krn` obowiązuje od E1.
  - *Wyjście:* 10 podróży, przypadki regresji zielone.
- **E3 — pamięć** warunkowo (§6).
- **E4 — `verdict` jako właściciel**, punkt decyzji o Paperclip, migracja reszty komend. `krn-legacy` znika.

**Jedno kryterium zabicia — [D1 z charteru](charter.md).** Metryka główna to *zaakceptowane wyniki bez uciekających
defektów*, raportowane z trzema licznikami na wynik: interwencje leada, prompty rekonstrukcyjne, tokeny. Po 6 podróżach
ramienia B rdzeń zostaje zamrożony, jeśli mediana interwencji leada na zaakceptowany wynik nie jest co najmniej 30% niższa
niż w B0 **albo** wystąpi co najmniej 1 uciekający defekt P0/P1. Minuty operatora pozostają metryką pomocniczą.
Klauzula interwencji jest oceniana tylko wtedy, gdy B0 `lead_interventions` > 0. Przy zerowej bazie raportuje się ją jako
`not-evaluable` (bez PASS/FAIL), a D1 rozstrzygają pozostałe klauzule.

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

## 13. Decyzje podjęte (2026-10-07) i otwarte kwestie

**Przyjęte [POLICY]:** produkt/folder/CLI to `krn`, instalacja od razu przejmuje `krn`; stary bin staje się `krn-legacy`. Nieznane komendy są forwardowane z guardem rekursji, parytetem i sprawdzeniem SessionStart przed swapem. Workerzy i sędziowie używają wyłącznie Luny; Sol 6.1 tylko na wyraźne życzenie. J1 i baseline obejmują `frontend-system` (LON-x Paperclip) oraz `krn-codex-skills`. Klon pamięci to `~/coding/krn/active/krn-memory`. Wartości [POLICY] przyjęto jako startowe z rewizją po E1.

**Otwarte:** kwalifikacja pilota i wybór Paperclip (zachować, dostosować lub zastąpić po dyspozycji UI, niezależnym review, restore i realnym projekcie); czy `krn-memory` ma pozostać osobnym repo/modułem po porównaniu alternatyw, w tym Mastra OM; model leada w Codex; wynik sondy Spec v0. Eksperyment oceny Luny wygasa po E1: lead przedstawia wynik wobec prawdy referencyjnej, a operator rozstrzyga utrzymanie, zmianę lub zakończenie; zakres nie rośnie bez decyzji.

## Changelog vs v3
- Produkt i CLI `krn` przejmują nazwę od startu; usunięto `krn-next`.
- Stary bin staje się `krn-legacy`; nieznane komendy są forwardowane z guardem rekursji.
- Dodano parytet odczytu i sprawdzenie hooka SessionStart przed swapem.
- Ustalono Luna-only dla workerów i sędziów; Sol działa wyłącznie na wyraźne życzenie.
- Wskazano J1 i baseline: `frontend-system` oraz `krn-codex-skills`.
- Ustalono klon pamięci `~/coding/krn/active/krn-memory`.
- Wartości [POLICY] przyjęto do rewizji po E1; §13 rozdziela decyzje i kwestie otwarte.
- Uzupełniono moduły o cykl życia, zależności, konflikty oraz migrację i wycofanie.
- Oznaczono K1–K10 jako [POLICY], uzgodniono K2 z helperami i wyjątek K8 dla core.
- Naprawiono przykłady Spec v0, ograniczono registry do reguł repo i poprawiono floor Node oraz ilustrację J1.
- Zastąpiono kryterium E1 metryką D1: zaakceptowane wyniki bez uciekających defektów.
