# Program KRN A–Z (start 2026-10-07)

Owner: lead (Claude Opus 5.5). Operator: Korneliusz (weto, nazwa produktu finalnie, granty).
Cel: zdecydować czym jest KRN, jaka jest mapa modułów, jaki stack i standardy, czy budujemy w nowym
folderze produktowym (nazwa produktu = nazwa folderu, moduły w środku: memory / harness / ...), i jak
każda zmiana architektury jest uzasadniana (ADR + diagram jako kod).

Źródła sklonowane: docs/program/sources/{ts-rust,mastra,paperclip,skills,krn-memory}

## Etapy
1. Discovery (7 specjalistów Luna, read-only, równolegle) -> reports/R1..R7.md
2. Synteza leada -> synthesis-v1.md (teza produktu, moduły, stack, ryzyka, otwarte pytania)
3. Adwokaci diabła: 2x gpt-6.1-sol (niezależni, różne soczewki) + 1x gpt-6-luna jako sędzia
   (eksperyment: czy Luna zdaje egzamin sędziego — porównanie z Sol na tym samym materiale)
4. Decyzje -> blueprint: nazwa, struktura folderu, moduły, AGENTS.md v2, standard ADR/diagramów
5. Onboarding nowego folderu (dopiero po akceptacji blueprintu przez operatora)

## Zasady syntezy
- Każde twierdzenie ma etykietę: [CODE] [STANDARD] [VENDOR] [EMPIRICAL] [OURS-EVIDENCE] [HYPOTHESIS].
- Rozbieżności między raportami rozstrzyga dowód, nie większość.
- Model review = doradcze; decyduje lead na dowodach.

## Wejście operatora (2026-10-07, mid-turn): ciągłość przez kompaktowanie
Hook PreCompact -> wysyła kontekst konwersacji do agenta z rolą (destylacja) -> sędziowie -> zapis do memory;
po wznowieniu reguła wymusza odczyt; agent bierze zadanie z kolejki (jak beads) z wstrzykniętym kontekstem
(stan zadania, ostatnie zmiany, commity, pamięć, standardy, pułapki). Rozwinięcie: narzędzie, które przy
zbliżaniu się do limitu okna samo robi /compact albo /new (reset), a ciągłość zapewnia kolejka wstrzykiwana
na starcie sesji (opcjonalnie). Lead: rozwijamy -> R8. Domena "continuity" w mapie T3.

## Decyzja nazwy (lead, 2026-10-07, na polecenie operatora "sam zadecyduj")
Produkt = `krn` (folder `~/coding/krn/active/krn`, CLI `krn`, scope `@krn/*` — wolny na npm 404, rejestracja NIE wykonana).
Cairn/Rill odrzucone (cairn-cli = backup configu Claude Code, kolizja niszy).
Moduły (katalogi w jednym pakiecie na start, pakiety dopiero przy drugim konsumencie):
relay (ciągłość: kapsuła, wznowienie, handoff) · foreman (supervisor świeżych sesji z kolejki) ·
ledger (port pracy; adapter Paperclip board-only) · verdict (dowód, sędziowie, akceptacja bound do SHA) ·
memory (kapsuła+wskaźniki; zdarzenia warunkowo) · trace (dziennik pomiarów: minuty operatora, koszt) ·
hosts (codex / claude / pi) · cli.
Strangler na poziomie CLI: nowy `krn` obsługuje zmigrowane komendy, a nieznane przekazuje do starego
`krn-codex-skills/scripts/krn.mjs`. Każda komenda zmienia właściciela dopiero razem z dowodem; po
ostatniej stary bin znika.

## Decyzja operatora 2026-10-07: tylko Luna (workerzy i sędziowie). Sol 6.1 wyłącznie na wyraźne życzenie.

## Decyzje operatora po v3 (2026-10-07)
1. Tylko Luna: poprawić ADR 0010 (PR przez workera Luna) i ~/.claude/CLAUDE.md (zrobione przez leada za zgodą).
2. J1 + baseline: frontend-system (kolejka Paperclip LON-x) + krn-codex-skills (6 tanich napraw instrukcji).
3. Instalacja: od razu `krn` (nie krn-next) — nowe CLI przejmuje nazwę i forwarduje nieznane komendy do starego
   wydania (wymaga ochrony przed rekursją, readbacku i testu hooków; stary bin -> `krn-legacy`).
4. Klon pamięci ~/coding/krn/active/krn-memory; progi [POLICY] przyjęte, rewizja po E1.

## Bramki review Opusa (operator 2026-10-07)
Głęboki review Opusa (świeży subagent, wysoki effort, read-only, raport) na każdej bramce kamienia milowego:
G1 po szkielecie + rozpisce E1 (zgodność z blueprintem, prymityw Job, granice modułów), G2 przed pierwszym żywym J1,
G3 na wyjściu E1, oraz przed każdą zmianą architektury. Rutynowe PR-y sędziuje Luna.

## B0 (2026-10-07): T1 lessons M-8, T2 memory reader HTTPS/URN, T3 frontend-system fs-006/LON-19 — protocol b0/protocol.md

## Sygnał jakości sędziów Luna (G2, 2026-10-07)
Luna-judges sprawdzały literę akceptacji, nie składały prawdziwych modułów ani nie testowały przerwań; Opus G2 znalazł 7
blokerów, które wszystkie przepuściły. Zmiana: brief sędziego wymaga ataku adwersarskiego (sygnały, grupy procesów,
re-run, crash). Dane do decyzji o eksperymencie "tylko Luna" na G3.

## Decyzje operatora 2026-10-10 (audyt produktu i przebieg R1)
Źródło: [audyt 2026-10-10](audit-2026-10-10.md); operator przyjął rekomendacje w sesji Claude Code 2026-10-10.
1. **D1 — metryka główna v2 (zastępuje „minuty operatora” jako metrykę główną; baseline minut = 0, więc kryterium −30% było
   nieobliczalne).** Metryka główna: *zaakceptowane wyniki bez uciekających defektów*, raportowane z trzema licznikami na
   wynik: interwencje leada, prompty rekonstrukcyjne, tokeny. Kryterium zabicia (blueprint §12) v2: po 6 podróżach ramienia B
   rdzeń zostaje zamrożony, jeśli mediana interwencji leada na zaakceptowany wynik nie jest ≥30% niższa niż w B0 **albo**
   wystąpi ≥1 uciekający defekt P0/P1. Minuty operatora pozostają metryką pomocniczą. Baseline B0 trzeba przeliczyć (R1-06).
2. **D2 — limit WIP.** Żaden nowy moduł ani host, dopóki R1-01..R1-05 i L2 (R1-12) nie mają kryteriów wyjścia. Maks. 3 zadania
   implementacyjne naraz, rozłączne plikowo.
3. **D3 — polityka powierzchni ewaluatora: odmowa.** Werdykt odmawia (`refused` → `human_decision`), gdy diff `base..sha`
   dotyka powierzchni ewaluatora zadeklarowanej w bazie albo domyślnej (patrz R1-02). Nakładka plików z bazy (wariant C)
   dopiero przy >1 fałszywej odmowie na 10 zadań.
4. **Przebieg R1 (long-running).** Orkiestratorem jest Sol 6.1 (xHigh) — na wyraźne życzenie operatora, zgodnie z zasadą
   „Sol wyłącznie na wyraźne życzenie”. Workerzy i niezależni sędziowie: Luna. Sol nie jest autorem kodu ani dokumentacji
   repo; zleca prace workerom Luna, koordynuje ich, integruje zaakceptowane PR-y i wykonuje adwersarialny przegląd fal.
   Nigdy nie ocenia pracy, której jest autorem.
5. **Grant R1 — merge.** Orkiestrator MAY mergować PR-y R1 do `main` wyłącznie gdy: CI `gate` zielone na dokładnym head,
   `krn/gate-local` zielone, `krn review` = PASS na dokładnym head (Luna), zero nadpisań. Każde FAIL po 2 rundach naprawy =
   zadanie `blocked`, bez override.
6. **Grant R1 — live.** Dozwolone `npm run live` (Codex/Luna) **bez** `--submit`: wynik kończy się na `ready_for_review`.
   Workerzy i procesy `live` nie zapisują do Paperclip (bez `--submit`). Lead może wykonywać wyłącznie autoryzowane
   administracyjne zapisy task/assignment/status oraz kwalifikowaną akceptację PR-backed zgodnie z ADR 0007; bez
   niezwiązanych edycji lub komentarzy issue. Zero instalacji `krn` jako bin, zmian infrastruktury hosta, force-push,
   przepisywania historii i usuwania branchy bez osobnego grantu.


## Decyzje operatora 2026-10-10 — doprecyzowanie admission R1 (LON-213)

Źródło: zaakceptowany pakiet operatora przekazany do przygotowania LON-213.
1. **Control plane i stan R1.** Paperclip jest jedynym bieżącym źródłem celów, zadań, przypisań, statusów i akceptacji. Lead może wykonywać administracyjne zapisy do pól task/assignment/status oraz akceptować kwalifikowane PR-backed issues zgodnie z ADR 0007. Workerzy i procesy `live` nie zapisują do Paperclip; `npm run live` pozostaje bez `--submit`. Backlog i karty R1 są zaakceptowaną specyfikacją i snapshotem zakresu, nie operacyjnym trackerem. Native Goal i kapsuła są widokami kontynuacji. `.krn/runs/delivery-loop/r1/state.md` jest jedyną transient kapsułą cyklu życia i ma jednego autora: delivery-loop lead. Końcowy raport może utrwalić snapshot ID/statusów i dowodów z Paperclip.
2. **Role i kwalifikacja.** W pełnym R1 Sol 6.1 xHigh jest leadem i nie jest autorem kodu ani dokumentacji repo; Luna (`gpt-6-luna`, high) implementuje i niezależnie ocenia zmiany. Przygotowanie pod nadzorem nie kwalifikuje przebiegu unattended. Pełny run może się rozpocząć dopiero po odczycie R1-00 i dowodzie kwalifikowanego confined backendu z dedykowanym workspace i jego readbackiem; sam Goal, native subagent, workspace-write ani read-only bind main nie wystarcza.
3. **Limit pełnego runu.** Limit wynosi 7.5 godziny czasu ściennego od chwili pełnego READY launch. Dla tego runu nie ustawiono native Goal token budgetu; nie stosuje się warunku 90% tokenów. Pozostałe stop conditions z runbooka zachowują moc.
4. **Review i merge.** Merge wymaga CI `gate`, `krn/gate-local` oraz `krn review` PASS na dokładnym head SHA i osobnych, niezależnych `krn/judge-standards` oraz `krn/judge-spec` success na tym samym SHA. Zmiana SHA unieważnia review. Żaden agregat ani wynik historyczny nie zastępuje wymaganych statusów.
5. **Wcześniejsze LON-y.** LON-205/206/211 zachowują wcześniejsze granty i materiały. Replay odbywa się ze świeżego main na osobnych branchach i nowych PR-ach pod tymi samymi LON; bez sync-merge. PR #8 z materialnymi zmianami WoZ zostaje poza R1; zachować dirty guard206 bez edycji i nie uruchamiać WoZ. PR #4 pozostaje propozycją P-006.
6. **Mapowanie R1–LON.** Zadanie R1 mapuje się na issue Paperclip LON przez wiersz `R1-task: R1-xx` w opisie issue; odczyt mapowania zapisuje się jako dowód. Przypisanie issue do Paperclip assignee nie jest wymagane.
7. **Dowody związane z drzewami `src/` i `test/`.** Dowody powiązane z SHA tych drzew są ważne dla każdego headu, którego drzewa są identyczne; sędzia weryfikuje zgodność przez `git rev-parse HEAD:src` i `git rev-parse HEAD:test` względem zapisanych wartości. Późniejszy commit zawierający wyłącznie dowody nie unieważnia tych dowodów. Sędzia może uruchomić dowolny test. Błąd wynikający wyłącznie z braku user scopes systemd lub bwrap w sandboksie przeglądu (błąd możliwości izolacji) nie jest defektem, jeśli status commitu `krn/gate-local` na dokładnym headzie ma stan success i zero pominięć izolacji. Sędzia sam weryfikuje ten status przez GitHub commit-status API (`repos/krn-works/krn/commits/<head>/statuses`: `context`, `state`, `creator`, `description`); gdy sandboks przeglądu nie ma sieci, dowodem jest zarchiwizowany przez leada odczyt API w `docs/program/r1/evidence/<task>/` (wraz z twórcą i znacznikiem czasu), a każda niezgodność SHA z headem jest BLOCKING.
