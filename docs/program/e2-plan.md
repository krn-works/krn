# E2 — plan workerów: `krn review` jako sędzia, ewaluacja Wizard-of-Oz, domknięcie E1

Data: 2026-10-08. Właściciel: lead. Status: propozycja. Slice'y oznaczone decyzją D1–D5 (§3) startują dopiero po
niej. Etykiety jak w blueprincie: [CODE], [OURS-EVIDENCE], [POLICY], [HYPOTHESIS].

**Aktualizacja 2026-10-09.** PR #1 scalono jako `1018556` z innym projektem R0: CI pomija zadeklarowane testy
zależne od izolacji i zapisuje powody; nie ma skryptu `test:portable`. PR-y #2/#3 zastąpiono odpowiednio PR #5/#4.
W0 to LON-206 (PR #7), a K0 to LON-207 (PR #6); w K0 rejestr obejmuje tylko `typecheck`, `lint` i `rules`,
bo suite nie może działać wewnątrz bwrap verdictu. `main` w `krn-works` pozostaje bez ochrony: lead odmawia
merge'a bez wymaganych statusów albo wiersza override, a API readback sprawdza autorów statusów. Ochrona gałęzi
wraca jako opcja, jeśli operator później kupi GitHub Team.

## 0. Wynik i granice

E2 ma trzy wyniki:

1. **`krn review` sędziuje każdy PR w repozytoriach krn-works.** Każdy head PR-a dostaje trzy statusy na dokładnym
   SHA: `krn/gate` z CI, `krn/gate-local` z hosta i `krn/judge` z `krn review`. Werdykt ma rekord. Red-first jest
   rozstrzygany mechanicznie. `gpt-6.1-sol` dochodzi jako drugi sędzia tylko przy zmianach wysokiego ryzyka:
   bezpieczeństwo, uprawnienia, instalacja, publikacja.
2. **Ewaluacja Wizard-of-Oz jest przeprowadzona i rozstrzygnięta.** Ramiona A/B/C/R na 6 zadaniach z `evals/woz`,
   jako replaye od commitów sprzed poprawki. Metryka główna to koszt na zaakceptowany wynik przy zerze uciekających
   defektów. Wynik to decyzja dla ADR 0002.
3. **E1 jest domknięte.** Dochodzą zaakceptowane wyniki „krn builds krn” (projekt Paperclip `krn`) i jeden żywy
   przebieg z wymuszonym przerwaniem: `SIGKILL` po commicie, który nie jest finalny. Na końcu bramka G3.

**Poza zakresem:** kod mózgu (schemat, indeks, potok wchłaniania, pakiet w `relay`); `hosts/pi`; kokpit; cutover CLI;
migracja `state`; nowe funkcje w `krn-codex-skills`, które jest zamrożone (dozwolone są tylko poprawki). Treść E2 z
blueprintu §12 („utwardzenie”) zastępuje decyzja operatora z 2026-10-08: po E1 najpierw `krn review`, równolegle
tylko Wizard-of-Oz. Aktualizacja blueprintu to osobny slice dokumentacyjny.

## 1. Stan wejściowy

1. **`krn review` v0** [CODE `src/flow/*`].
   - Komenda: `krn review --repo --base --head --lens [--panel]`.
   - Red-first: testy zmienione w PR uruchamiane są na drzewie bazy w bwrap i scope systemd. Klasy wyniku to `pass`,
     `assertion`, `procedural` i `other`.
   - Klasyfikator to regex po ogonie wyjścia, a `procedural` ma pierwszeństwo przed `assertion`
     [CODE `repository.ts:24-28,183-189`]. Asercja, której komunikat cytuje błąd modułu procesu potomnego, zostanie
     więc uznana za proceduralną.
   - Panel: `standards`, `spec` i `adversarial`, uruchamiani po kolei. Każdy to świeża sesja Codex z modelem
     `gpt-6-luna` wpisanym na sztywno, w trybie read-only. Start wymaga izolacji `systemd_scope` [CODE `panel.ts`].
   - `panelVerdict` zależy wyłącznie od sędziów. Wynik red-first trafia do nich tylko jako tekst briefu i niczego
     mechanicznie nie blokuje [CODE `index.ts`].
   - Rekord leży w `.krn/runs/review/<sha>/record.json`. Jest wyłączny, ignorowany przez Git i lokalny. Override
     można dopisać tylko po FAIL [CODE `record.ts`].
   - Brak integracji z GitHubem (statusy, komentarze) i odczytu kontraktu z Paperclip.
2. **`verdict` czyta checki z `krn.checks.json` w bazie, a repo `krn` tego pliku nie ma** [CODE `verdict/registry.ts`;
   OURS-EVIDENCE listing repo]. Podróż na samym `krn` nie przejdzie więc ścieżki verdictu.
3. **CI (PR #1, run 37824954030, runner `krn-ci-isolated`)** [OURS-EVIDENCE log].
   - `bwrap: command not found` (exit 127).
   - `systemctl --user`: „Failed to connect to bus: No medium found”.
   - Preflight PR-a jest sam błędny: `systemd-run --user --scope --wait` kończy się komunikatem „--wait may not be
     combined with --scope”.
   - Kontener jest bezrootowy i nie ma menedżera użytkownika systemd. Nie uruchomi tam testów izolacji, m.in.
     `test/flow/review`, `test/verdict/sandbox`, `test/hosts/codex-stale-scope` i `test/ledger/paperclip-cli`.
   - `test/relay/capsule-cas.test.ts:13` ma na sztywno ścieżkę hosta do `krn-codex-skills`.
   - Wniosek: testy izolacji wymagają lokalnego statusu `krn/gate-local`.
4. **Materiał Wizard-of-Oz przed korektą (zastąpiony PR #5).** Sześć zadań. Pakiety mają 910–1359 znaków (228–340 tokenów
   szacunkowych), a kontrole są dopasowane długością przez dopełnienie spacjami na końcu. Dla replayu od commitu
   sprzed poprawki są dwa defekty blokujące:
   - **a) Wyciek rozwiązania.** Wzorcowy diff w każdym pakiecie pochodzi z zaakceptowanej zmiany *tego samego*
     zadania:
     - LON-20 `a262a5f`, LON-21 `c7eaee1` i LON-22 `a43a99c`: pakiet sam nazywa je poprawką zadania;
     - LON-130 `6567b4b` „add the read-only memory CLI”;
     - LON-131 `fd9b1b5` „add governed proposals, verification and retirement”;
     - LON-133 `d1bc745` „generate session digests and worker bundles”
       [OURS-EVIDENCE `git log` w `krn-codex-skills`].

     Ramię B dostaje więc fragment odpowiedzi. Prereg nazywa wyciek między ramionami powodem unieważnienia zadania.
   - **b) Checki z `tasks.md` nie istnieją na bazie.** Przykład: `test/memory/read-cli.test.mjs` i skrypt
     `test:memory` dodaje dopiero `6567b4b` [OURS-EVIDENCE `git show --stat`]. Na bazie są to testy ukryte
     (held-out). Część z nich jest sprzężona z interfejsem przyjętej implementacji.

   **Uwaga o progach.** Dla tej rundy Wizard-of-Oz `n=6` niezmienione progi preregistracji 1–2 oraz dodany decyzją
   D2 główny próg kosztu są jawnym, zapisanym odstępstwem od progów ADR 0002 (+20 pp, połowa luki i +10 pp). Te
   progi z ADR obowiązują późniejszą rundę 20 zadań. D3 ustala w tej rundzie jeden przebieg na ramię i zadanie (24
   łącznie), jawnie zamiast dwóch powtórzeń wymaganych przez ADR.
5. **E1** [OURS-EVIDENCE `.krn/runs/lead/L1/notes.md`].
   - Jest jeden zaakceptowany wynik: LON-200, zaakceptowany przez leada 2026-10-08 17:19 po replayu L1g z `--submit`.
   - Żaden przebieg nie przerwał pracy w toku (korekta G3: watcher widzi checkpoint dopiero po `session_ended`).
   - Było 8 prób żywych, każda z nazwaną poprawką.
6. **Decyzje operatora z 2026-10-08** są zapisane w charterze leada, ale jeszcze nie w `docs/program/charter.md`:
   - metryka główna: koszt na zaakceptowany wynik przy zerze uciekających defektów;
   - jednorazowy Opus-implementer w ramieniu R: 6 zadań, tylko w worktree ewaluacji, wynik nie trafia do `main`;
   - Sol jako drugi sędzia wyłącznie dla zmian wysokiego ryzyka;
   - „krn builds krn” jako domyślny cel podróży;
   - jeden PR ↔ jedno issue LON; projekt Paperclip `krn`;
   - zamrożenie `krn-codex-skills`.

## 2. Zasady wspólne [POLICY]

- **Wykonawcy.**
  - Cały kod, testy i pliki w repo piszą workerzy Codex `gpt-6-luna` przez `codex exec`. Binarka to daemon Codex
    0.160 pod ścieżką absolutną z `src/hosts/codex.ts`, nigdy wrapper z `~/.local/bin`.
  - Lead planuje, pisze briefy (cel, ustalenia, ograniczenia, akceptacja; nigdy gotowe łatki), recenzuje i integruje.
  - Sol pracuje tylko jako sędzia z E2-R3. Opus implementuje tylko w ramieniu R (E2-W2).
- **Tracker i publikacja.**
  - Każdy slice to jedno issue Paperclip w projekcie `krn`. Ma blok `krn-contract` z checkami z bazowego
    `krn.checks.json` od chwili wejścia E2-K0.
  - PR: tytuł `type: summary (LON-x)`, gałąź `krn/LON-x-slug`, merge commitem (`--merge`). Po merge'u gałąź jest
    usuwana lokalnie i zdalnie.
- **Falsyfikator.**
  - Każdy slice ma dokładnie jeden falsyfikator, pokazany jako czerwony na bazie slice'u.
  - Dla kodu `krn review` musi sklasyfikować pierwsze niepowodzenie jako `assertion` (K8, plan E1).
  - Nowy punkt wejścia falsyfikator uruchamia przez istniejącą granicę: CLI w podprocesie albo istniejący eksport.
    Brak funkcji na bazie jest wtedy asercją, a nie brakującym importem. Klasa override'ów z P1 nie może wracać.
  - W slice'ach żywych i danych falsyfikatorem jest deterministyczny readback: komenda i oczekiwana wartość,
    czerwone przed przebiegiem.
- **Statusy docelowe (po E2-R5; `main` bez ochrony).**
  - `krn/gate`: CI, część przenośna gate'u.
  - `krn/gate-local`: host, pełny gate na dokładnym SHA.
  - `krn/judge`: host, `krn review` na dokładnym SHA.

  Lead scala PR tylko wtedy, gdy na dokładnym headzie są sukcesy `krn/gate`, `krn/gate-local` i `krn/judge`,
  albo istnieje wiersz dla tego PR w `docs/program/overrides.md`. Jego pipeline merge'a odmawia w pozostałych
  przypadkach. API readback zmergowanych PR-ów weryfikuje dokładny SHA oraz autora każdego statusu. Ochrona
  gałęzi wraca jako opcja, jeśli operator później kupi GitHub Team. Do czasu E2-R5 integrator robi to co dziś:
  `npm run gate` na fixed poincie i ręczny `krn review`.
- **Override.** Merge mimo FAIL wymaga przed merge'em wiersza w `docs/program/overrides.md` oraz
  `krn review --override` w rekordzie. Override nie zmienia statusu `krn/judge`.
- **Przebiegi żywe.**
  - Tylko `KRN_LIVE=1 npm run live`, nigdy w gate.
  - Najwyżej 2 jednocześnie na hoście i nigdy dwa w tym samym klonie celu.
  - Przed i po przebiegu snapshot: Paperclip, `ls-remote`, status głównego checkoutu, `pgrep -af 'codex exec'`.
- **Narzędzia.** `gh` tylko z `/usr/bin/gh`. Claude Code dla ramienia R uruchamiany z instalacji mise, nie przez
  wrapper, który zmienia globalną konfigurację mise.

## 3. Decyzje operatora przed startem

| ID | Decyzja | Rekomendacja leada | Blokuje |
|---|---|---|---|
| D1 | Token GitHub do statusów i komentarzy z hosta (magazyn `gh`, bez nowego pliku z sekretem); `main` pozostaje bez ochrony, a pipeline leada odmawia merge'a bez wymaganych statusów lub wiersza override | grant tylko dla `repo:status` i komentarzy PR; ochronę gałęzi rozważyć ponownie po zakupie GitHub Team | publikacja w R1/R4, całe R5 |
| D2 | Ponowne zamrożenie materiału Wizard-of-Oz przed pierwszym przebiegiem: usunięcie wycieku (1.4a), podział checków na widoczne i ukryte (1.4b), rejestracja metryki głównej jako aneksu do prereg | progi preregistracji 1–2 bez zmian i główny próg kosztu B ≤ 0,5 × R przy zerze uciekających defektów; jawne odstępstwo od progów ADR 0002 dla n=6 | merge W0 |
| D3 | Liczba powtórzeń: 1 przebieg na ramię i zadanie (24 przebiegi, R = 6 przebiegów Opusa zgodnie z grantem) zamiast 2 z ADR (48, w tym 12 Opusa) | 1, z odstępstwem od ADR jawnie odnotowanym | merge W0 |
| D4 | Początkowa mapa ryzyka dla Sol (`krn.risk.json`, lista w R3) | przyjąć listę z R3 | merge R3 |
| D5 | Porównywalność wyjścia E1: podróże na `krn` nie są tej samej klasy co B0 (`krn-codex-skills`, `frontend-system`) | G3 ocenia metrykę z tym ograniczeniem; opcjonalnie jedna podróż na `frontend-system` | K3 i G3 |

## 4. Ścieżka R — `krn review` jako sędzia każdego PR

### E2-R0 — `krn/gate`: przenośny gate w CI
- **Cel.** CI w bezrootowym kontenerze raportuje job `krn/gate`; zadeklarowane testy zależne od izolacji są pomijane
  z zapisanym powodem. PR #1 scalono jako `1018556` z tym projektem; nie powstaje skrypt `test:portable`.
- **Moduły/pliki.** `.github/workflows/ci.yml`, `test/workflow.test.ts` i rejestr powodów pominięć testów izolacji.
- **Akceptacja.**
  - Job `krn/gate` jest zielony na runnerze `krn-ci-isolated`.
  - `npm run gate` lokalnie pozostaje pełny.
  - Każde pominięcie testu zależnego od izolacji ma jawny powód w raporcie CI.
- **Falsyfikator (red first).** Readback joba `krn/gate` na runnerze bez `systemd`, `bwrap` i busa użytkownika:
  job kończy się sukcesem, a każdy pominięty test ma powód w raporcie. Brak powodu albo niezerowy exit joba
  falsyfikuje slice.
- **Zależności.** Brak; PR #1 jest już zmergowany jako `1018556`.
- **Grupa równoległa.** P1.
- **Kryteria zabicia.**
  - Zbiór przenośny obejmuje mniej niż połowę plików testów albo wyklucza test logiki niezależnej od hosta
    (`core`, `relay`, `trace`, parsowanie `ledger`): przeprojektować podział.
  - Po 2 naprawach runner nadal pada z przyczyn środowiskowych: `human_decision` u właściciela floty runnerów.

### E2-R1 — `krn review pr`: status `krn/judge` i rekord werdyktu na PR
- **Cel.** Jednorazowa komenda hosta `krn review pr --repo <abs> --pr <owner/repo#n>`:
  1. czyta PR: head SHA, bazę (merge-base z gałęzią bazową) i LON-x z tytułu;
  2. odmawia, dopóki `krn/gate` na headzie nie jest zielone (sędziowie dopiero po tanim sygnale);
  3. składa soczewkę z bazowego `AGENTS.md` i kontraktu issue z Paperclip, czytanego tylko do odczytu; PR nie może
     zmienić kryteriów, którymi jest sądzony;
  4. uruchamia `runReview` na dokładnym SHA;
  5. publikuje status `krn/judge` na `record.headSha`: `success` tylko dla PASS, `failure` dla FAIL, `error` dla
     INCOMPLETE; opis ma werdykt i 12 znaków sha256 rekordu;
  6. publikuje jeden komentarz PR z kompaktowym rekordem: werdykt, klasy red-first, BLOCKING z `path:line`, ID
     sesji sędziów, sha256 rekordu.

  Ponowne uruchomienie na tym samym SHA używa istniejącego rekordu: bez nowych sesji i bez drugiego komentarza.
- **Moduły/pliki.** `src/flow/pr.ts` (nowy), `src/flow/github.ts` (nowy port; transport przez `/usr/bin/gh`),
  `src/flow/cli.ts` (podkomenda `pr`), `test/flow/pr.test.ts`. Bez zmian w `src/flow/index.ts` i `types.ts`, które
  należą do R2.
- **Akceptacja.**
  - Status trafia na dokładny SHA.
  - INCOMPLETE nigdy nie daje `success`.
  - Rerun jest idempotentny.
  - Zero zapisów do Paperclip, czyli zero wywołań `updateIssue`.
  - PR z forka jest odrzucany.
  - Publikacja live dopiero po D1.
- **Falsyfikator (red first).** `test/flow/pr.test.ts` używa fałszywego `gh` i fałszywego `codex` (istniejący
  szew `codexExecutable`), z sędzią bez `turn.completed`. Asercja: opublikowano dokładnie jeden status `error` i
  żadnego `success`. Na bazie podkomendy `pr` nie ma, więc lista wywołań `gh` jest pusta i asercja pada.
- **Zależności.** Brak w kodzie. D1 dotyczy tylko publikacji.
- **Grupa równoległa.** P1.
- **Kryteria zabicia.**
  - Ponad 30% pierwszych 10 przeglądów kończy się INCOMPLETE z przyczyn hosta: wstrzymać wdrożenie i naprawić host.
  - Publikacja wymagałaby zapisania tokenu poza magazynem `gh`: stop (polityka poświadczeń).

### E2-R2 — mechaniczny red-first jako część werdyktu
- **Cel.** `runReview` liczy przed sędziami deterministyczny wynik `mechanical` według reguł z bazowego
  `krn.review.json` (PR nie może ich złagodzić):
  - zmiana kodu runtime (globy `runtime`) wymaga ≥1 zmienionego testu z klasą `assertion` na bazie;
  - każdy zmieniony test z klasą `procedural` albo `other` daje FAIL mechaniczny z powodem;
  - PR bez zmian runtime dostaje `not_required`, co odpowiada budżetowi dowodu 0.

  FAIL mechaniczny nie uruchamia sędziów i zapisuje `panelVerdict: FAIL` z powodem. Rekord dostaje
  `schemaVersion: 2` z polem `mechanical`. Klasyfikacja opiera się na pierwszym nieudanym teście (`not ok` i jego
  `error`), a nie na dowolnym fragmencie wyjścia (1.1).
- **Moduły/pliki.** `src/flow/index.ts`, `src/flow/policy.ts` (nowy), `src/flow/types.ts`,
  `src/flow/repository.ts` (klasyfikator), `krn.review.json`, `test/flow/policy.test.ts`.
- **Akceptacja.**
  - PR, którego jedyny test pada proceduralnie, dostaje FAIL bez sesji sędziów.
  - PR tylko z dokumentacją dostaje `not_required`, a sędziowie działają.
  - Rekordy v1 nadal się parsują i przyjmują override.
- **Falsyfikator (red first).** `test/flow/policy.test.ts` przez `runReview` z fałszywym `codex`: head z nowym
  testem, który na bazie pada na brakującym module. Asercja: `panelVerdict === 'FAIL'` i zero uruchomień `codex`.
  Na bazie sędziowie startują, więc asercja pada.
- **Zależności.** Brak.
- **Grupa równoległa.** P1 (pliki rozłączne z R1).
- **Kryteria zabicia.**
  - Co najmniej 2 fałszywe FAIL-e na 10 PR-ach, przy poprawnie udowodnionej zmianie w ocenie leada: zrewidować
    reguły, a nie wpisywać override z nawyku.
  - Co najmniej 3 slice'y nie potrafią dać falsyfikatora klasy `assertion` bez sztuczek: operator rozstrzyga K8
    zamiast dokładać override'y.

### E2-R3 — klasa ryzyka i drugi sędzia `gpt-6.1-sol`
- **Cel.** `krn.risk.json`, czytany z bazy, mapuje globy na klasy `security`, `permissions`, `install` i
  `publication`. Każde trafienie oznacza ryzyko wysokie. Wtedy panel dostaje dodatkowego sędziego `adversarial` na
  `gpt-6.1-sol`: świeża sesja, read-only, ten sam scope i brief. PASS panelu wymaga jego kompletnego PASS. Rekord
  podaje klasy, dopasowane ścieżki i model każdego sędziego.

  Mapa początkowa (D4):
  - `security`: `src/verdict/sandbox.ts`, `src/hosts/**`, `src/flow/panel.ts`, `src/flow/repository.ts`;
  - `permissions`: `src/foreman/checkpoint*.ts`, `src/cli/index.ts`;
  - `install`: `package.json`, `pnpm-lock.yaml`, `src/cli/main.ts`;
  - `publication`: `src/ledger/**`, `src/flow/github.ts`, `src/flow/pr.ts`, `.github/**`, `scripts/live-*.mjs`;
  - same pliki polityki (`krn.risk.json`, `krn.review.json`, `krn.checks.json`) należą do `security`.
- **Moduły/pliki.** `src/flow/risk.ts` (nowy), `src/flow/panel.ts` (model jako parametr), `src/flow/index.ts`,
  `src/flow/types.ts`, `krn.risk.json`, `test/flow/risk.test.ts`.
- **Akceptacja.**
  - PR, który usuwa własne ścieżki z `krn.risk.json`, nadal ma ryzyko wysokie (liczy się baza).
  - Sol działa tylko przy ryzyku wysokim.
  - Niekompletny Sol daje INCOMPLETE.
  - Tokeny Sol są w rekordzie.
- **Falsyfikator (red first).** `test/flow/risk.test.ts` przez `runReview` z fałszywym `codex`, który zapisuje
  `--model`: zmiana `src/hosts/codex.ts`, a fałszywy Sol zwraca FAIL. Asercja: jedno uruchomienie z
  `gpt-6.1-sol` i `panelVerdict !== 'PASS'`. Na bazie Sol nie startuje, więc asercja pada.
- **Zależności.** R2 (wspólne `index.ts` i `types.ts`); D4.
- **Grupa równoległa.** P2.
- **Kryteria zabicia.**
  - Sol uruchamia się na ponad 50% PR-ów: mapa jest za szeroka; zawęzić z operatorem.
  - Ponad 3 z pierwszych 5 FAIL-i Sol lead uznaje za pozorne: przegląd soczewki przed dalszym użyciem.

### E2-R4 — `krn gate local`: status `krn/gate-local`
- **Cel.** Komenda hosta `krn gate local --repo <abs> --sha <pełny> [--publish <owner/repo>]`:
  1. tworzy świeży worktree detached na dokładnym SHA w `.krn/tmp`;
  2. instaluje zależności offline z zamrożonego lockfile'a;
  3. uruchamia argv checku `gate-local` z bazowego `krn.checks.json`, poza bwrap, bo testy izolacji same potrzebują
     systemd hosta;
  4. usuwa worktree;
  5. publikuje `krn/gate-local` (`success` albo `failure`) z liczbą testów, czasem i sha256 logu; log trafia do
     `.krn/runs/gate-local/<sha>/`.

  Na repo działa najwyżej jeden przebieg naraz (blokada).
- **Moduły/pliki.** `src/flow/gate-local.ts` (nowy), `src/cli/index.ts` (dispatch `gate`),
  `test/flow/gate-local.test.ts`. Z `src/flow/github.ts` (R1) korzysta tylko do odczytu.
- **Akceptacja.**
  - Bramka działa wyłącznie na dokładnym SHA, nigdy na drzewie głównego checkoutu.
  - Brudny worktree albo przesunięty SHA oznacza odmowę.
  - Raport pokazuje zero pominiętych testów.
- **Falsyfikator (red first).** `test/flow/gate-local.test.ts`: w repo tymczasowym commit X ma test czerwony, a
  HEAD checkoutu (Y) jest zielony. `krn gate local --sha X` z fałszywym `gh`. Asercja: opublikowano `failure` dla
  X. Na bazie nie ma komendy `gate`, więc żaden status nie powstaje i asercja pada.
- **Zależności.** R1 (`github.ts`), K0 (check `gate-local` w rejestrze); D1 dla publikacji.
- **Grupa równoległa.** P2.
- **Kryteria zabicia.**
  - Mediana czasu przekracza 20 minut.
  - Co najmniej 2 niedeterministyczne porażki w 10 przebiegach: kwarantanna testu z właścicielem, nigdy `skip`.

### E2-R5 — wdrożenie: każdy PR w krn-works przez `krn review`
- **Cel.**
  1. `main` w `krn-works` pozostaje bez ochrony. `krn-pr.sh` i dyscyplina leada odmawiają merge'a, chyba że
     dokładny head ma statusy `success` `krn/gate`, `krn/gate-local` i `krn/judge` albo PR ma wiersz w
     `docs/program/overrides.md`. Po późniejszym zakupie GitHub Team operator może przywrócić ochronę gałęzi.
  2. Pętla leada na każdy nowy head SHA: zielone `krn/gate`, potem `krn gate local`, potem `krn review pr`;
     zmiana SHA unieważnia dotychczasowe statusy i wymaga ponownego przebiegu.
  3. Lead przestaje używać `bin/krn-judge.sh` i `bin/pr-pipeline.sh` dla `krn`.
  4. Fala kolejnych repo krn-works z aktywnością PR (lista z API przy starcie): `krn-codex-skills`, potem
     repozytorium `frontend-system`, potem reszta przy pierwszym nowym PR. Każde repo dostaje własne
     `krn.checks.json`, `krn.review.json` i `krn.risk.json` w PR-ze tego repo, wykonanym przez workera Luna.
- **Moduły/pliki.** Pipeline merge'a leada (`krn-pr.sh`); pliki polityki w repozytoriach docelowych. Bez kodu `krn`.
- **Akceptacja.**
  - 10 kolejnych PR-ów zmergowanych w `krn`: każdy ma trzy statusy `success` na dokładnym zmergowanym headzie albo
    wiersz override. API readback dla każdego z nich sprawdza SHA, nazwę i autora każdego statusu.
  - ≥1 osądzony PR w każdym repo z pierwszej fali.
  - Zero merge'y bez kompletu statusów lub wiersza override.
- **Falsyfikator (red first).** Na PR-sondzie dokładnego headu bez `krn/judge` `krn-pr.sh` odmawia merge'a;
  readback potwierdza, że PR nie został scalony. Po dodaniu wiersza override pipeline dopuszcza merge, a API
  readback zmergowanych PR-ów sprawdza SHA i autorów statusów. Bez tej odmowy falsyfikator jest czerwony.
- **Zależności.** R0, R1, R2, R4. R3 przed objęciem zmian wysokiego ryzyka. D1.
- **Grupa równoległa.** P3.
- **Kryteria zabicia.**
  - Interwencje leada na zaakceptowany wynik nie spadają po 10 PR-ach (kill E2 z product spine §6): skrypty
    zostają, produktyzacja się zatrzymuje.
  - 2 uciekające defekty wykrywalne deterministycznie na 20 osądzonych PR-ów: tripwire z blueprintu §11, czyli check
    do gate'u i raport dla operatora.
  - Repo bez testów `node --test` nie ma red-first. Wtedy dostaje `mechanical: not_applicable` z adnotacją w
    rekordzie i nie wchodzi w metrykę jakości.

### E2-R6 — kalibracja sędziów wobec prawdy
- **Cel.** Zmierzyć false-accept, false-reject, abstencję i koszt panelu Luna, a Sol na podzbiorze wysokiego ryzyka.
  Zbiór: 20 elementów, ≥30% z podłożonymi defektami w klasach z G2 B1–B7 i z `overrides.md`. Prawdę ustalają lead i
  operator przed przebiegiem (blueprint §11.4).
- **Moduły/pliki.** `evals/judge/items.json`, `evals/judge/truth.sha256` (zamrożony przed wynikami),
  `evals/judge/results.json`, `test/judge-calibration.test.ts`.
- **Akceptacja.**
  - Wyniki mają `n=20` i etykietę, z miarami per klasa.
  - Hash prawdy jest zacommitowany wcześniej niż wyniki.
  - Progi ustala operator po odczycie.
- **Falsyfikator (red first).** `test/judge-calibration.test.ts` asertuje ≥20 elementów, ≥30% podłożonych i hash
  prawdy zgodny z `truth.sha256`. Na bazie elementów jest 0.
- **Zależności.** R2; R3 dla podzbioru Sol.
- **Grupa równoległa.** P3.
- **Kryteria zabicia.** False-accept na podłożonych defektach ≥50%: `krn review` nie może być jedynym sędzią.
  Bramki Opusa zostają wymagane dla klas M i H, a lead raportuje to operatorowi.

## 5. Ścieżka W — ewaluacja Wizard-of-Oz (bez kodu mózgu)

### E2-W0 — korekta i ponowne zamrożenie materiału
- **Cel.**
  1. Zmergować PR #5 bez zmian, jako zachowaną historię.
  2. Przed pierwszym przebiegiem (README pozwala zmieniać materiał do tego momentu) poprawić materiał:
     - **(a) Wzorce.** Wzorcowy diff pochodzi z *innej* zaakceptowanej zmiany tej samej klasy, z datą commitu nie
       późniejszą niż baza. Źródła pakietu czytamy w rewizji bazy, a źródło dodane dopiero przez poprawkę zadania
       też jest wyciekiem.
     - **(b) Kontrole.** Dopasowanie długości bez dopełnienia spacjami, uzupełnione nieistotnym tekstem.
     - **(c) `manifest.json`.** Zawiera:
       - repo i bazę przed poprawką (pierwszy rodzic przyjętej zmiany);
       - zapieczętowany SHA przyjętej zmiany;
       - checki widoczne (sprawdzone, że istnieją na bazie);
       - checki ukryte z flagą `interface_coupled`;
       - sha256 i liczbę znaków pakietów i kontroli;
       - seed i kolejność ramion;
       - ID modeli (`gpt-6-luna`, `claude-opus-5-5`) oraz tożsamość sędziów (SHA `krn review`);
       - cennik z datą i źródłem oraz estymator tokenów;
       - metodę fingerprintu worktree;
       - budżety: sesja ≤45 min, ≤2 naprawy, pułap tokenów na przebieg;
       - zamrożoną checklistę audytu.
     - **(d) Tabela rozmiarów w `prereg.md`** i aneks z decyzji D2 i D3.
- **Moduły/pliki.** `evals/woz/**`, `test/woz-manifest.test.ts`.
- **Akceptacja.**
  - Test manifestu jest zielony.
  - Każde zadanie ma ≥1 deterministyczny check akceptacji, który działa dla każdego zgodnego rozwiązania: widoczny na
    bazie albo ukryty bez sprzężenia z interfejsem.
  - Lead robi readback, a operator zatwierdza zamrożenie (D2, D3).
  - SHA merge'a staje się kotwicą zamrożenia przed jakimkolwiek przebiegiem.
- **Falsyfikator (red first).** `test/woz-manifest.test.ts` asertuje, że żaden pakiet nie zawiera SHA ani prefiksu
  ≥7 znaków przyjętej zmiany własnego zadania. Na materiale z PR #5 asercja pada dla wszystkich 6 pakietów.
- **Zależności.** Merge PR #5; D2, D3.
- **Grupa równoległa.** P1 (tylko `evals/**` i jeden nowy test).
- **Kryteria zabicia.** Dla ≥3 z 6 zadań nie da się podać checku akceptacji niezależnego od interfejsu i nie ma
  zamiennika tej samej klasy: runda jest nieważna przed startem, decyduje operator. Wymiana zadań po pierwszym
  przebiegu jest zakazana.

### E2-W1 — ręczny kontrakt i załącznik ramienia w przebiegu żywym
- **Cel.** `npm run live -- --contract-file <json> --attachment <plik>`.
  - Ręczny adapter `ledger` (blueprint §3.2, drugi adapter) jest tylko do odczytu: zero wywołań Paperclip, a
    `--submit` jest odrzucane.
  - `relay` wkłada załącznik dosłownie, raz w brief startowy każdej sesji.
  - Trace `session_started` zapisuje sha256 i rozmiar załącznika oraz sha256 kontraktu.
  - Budżet projekcji liczy załącznik osobno, z limitem ≤2000 tokenów.
  - Ramię A nie ma załącznika, B dostaje pakiet, C kontrolę.
- **Moduły/pliki.** `src/ledger/manual.ts` (nowy), `src/relay/index.ts` (projekcja), `scripts/live-l1.mjs`,
  `test/ledger/manual.test.ts`.
- **Akceptacja.**
  - Bajty załącznika są identyczne we wszystkich sesjach.
  - Hash w trace się zgadza.
  - Zero wywołań transportu Paperclip.
  - ABI kapsuły i hook pozostają bez zmian.
- **Falsyfikator (red first).** `test/ledger/manual.test.ts` uruchamia `scripts/live-l1.mjs` w podprocesie z
  fałszywym `codex`, który przechwytuje prompt. Asertuje, że prompt zawiera załącznik dokładnie raz, a
  `session_started.attachmentSha256` równa się sha256 pliku. Na bazie załącznika w prompcie nie ma.
- **Zależności.** Brak.
- **Grupa równoległa.** P1 (pliki rozłączne z R0–R2 i W0).
- **Kryteria zabicia.** Wstrzyknięcie wymaga zmiany ABI kapsuły albo hooka SessionStart: stop i `human_decision`.
  Załącznika nie wolno kłaść do worktree, bo jest tam widoczny i zostaje w historii.

### E2-W2 — przebiegi ramion A/B/C/R
- **Cel.** 6 zadań × 4 ramiona × 1 przebieg (D3) w kolejności z manifestu.
  - **Izolacja.** Każdy przebieg ma świeży klon celu na bazie z manifestu. `pushurl` jest wyłączony, zależności
    instalowane przed sesją identycznie dla wszystkich ramion.
  - **A/B/C.** Foreman z `--contract-file` i `--attachment`, model Luna.
  - **R.** Claude Code headless z JSON-owym raportem zużycia, ten sam brief i ten sam protokół przerwania. Tylko w
    klonie ewaluacji; wynik nigdy nie trafia do `main` (grant operatora nr 3).
  - **Przerwanie z prereg.** Sesja 1 kończy się po pierwszym behawioralnym RED, zacommitowanym i z checkpointem.
    Sesja 2 jest świeża i dostaje tylko ścieżkę, ID i „resume”. Jeśli pierwsza porażka jest setupem albo infra,
    porównanie przerwania w tym przebiegu jest nieważne.
  - **Naprawy.** Najwyżej 2, w świeżych sesjach tego samego ramienia, wyłącznie ze znaleziskami z W3.
  - **Rekord przebiegu.** Modele, ID sesji, tokeny (wejście, cache, wyjście) per sesja, czas, hash załącznika,
    fingerprinty przed i po, commity. Bez transkryptów.
- **Moduły/pliki.** `evals/woz/runs/<zadanie>/<ramię>.json`. Bez kodu.
- **Akceptacja.**
  - 24 rekordy: kompletne albo jawnie nieważne, z powodem.
  - Zero wycieku między ramionami.
  - Snapshoty Paperclip i `ls-remote` bez zmian.
  - Najwyżej 2 przebiegi naraz i nigdy dwa ramiona tego samego zadania jednocześnie.
- **Falsyfikator (red first).** Readback `node --test test/woz-runs.test.ts`: 24 rekordy z wymaganymi polami i
  hashami równymi manifestowi. Na bazie rekordów jest 0. Test dodaje ten slice, bez kodu runtime.
- **Zależności.** W0, W1, R2 (mechaniczny red-first używany przez W3).
- **Grupa równoległa.** P3.
- **Kryteria zabicia.**
  - Limit Claude wyczerpany przed 6 przebiegami R: R jest niekompletne, a luki do Opusa nie liczymy; bez imputacji.
  - Pułap tokenów Luny z manifestu przekroczony: stop.
  - Ponad 2 zadania nieważne: runda nieważna.

### E2-W3 — ślepe sędziowanie i audyt uciekających defektów
- **Cel.**
  1. Wynik każdego przebiegu przechodzi anonimizację: jeden commit na bazie, neutralny autor i opis, bez trailerów
     `Krn-Session` i `Co-Authored-By`, bez plików sesji.
  2. Na tak przygotowanym commicie działa `krn review`, z tą samą soczewką dla wszystkich ramion (kontrakt
     akceptacji zadania).
  3. PASS pierwszej próby z prereg to zielone checki widoczne plus brak BLOCKING u sędziów Standards i Spec.
     Adwersarza raportujemy osobno.
  4. Przed odślepieniem hash wszystkich werdyktów trafia do commitu (blokada).
  5. Audyt po akceptacji: checki ukryte (deterministyczne; `interface_coupled` tylko doradczo) plus checklista z
     manifestu, stosowana przez leada na losowych ID.
  6. Uciekający defekt to P0/P1 znaleziony w audycie, a przeoczony przez checki nazwane i obu sędziów finalnych.
- **Moduły/pliki.** `scripts/woz-anonymize.mjs` (nowy), `test/woz-anonymize.test.ts`,
  `evals/woz/judgments.json`, `evals/woz/lock.sha256`, `evals/woz/audit.json`.
- **Akceptacja.**
  - Blokada jest zacommitowana przed mapą odślepienia.
  - Żadne wejście sędziego nie zawiera nazwy modelu, ramienia ani zdania-wartownika z pakietu.
- **Falsyfikator (red first).** `test/woz-anonymize.test.ts` uruchamia skrypt w podprocesie na gałęzi z trailerami
  `Krn-Session` i `Co-Authored-By` oraz wartownikiem pakietu w komentarzu. Asertuje, że commit wynikowy nie zawiera
  żadnego z nich. Na bazie skryptu nie ma, więc asercja kodu wyjścia i treści pada.
- **Zależności.** R2. W W2 działa w przeplocie, przebieg po przebiegu.
- **Grupa równoległa.** P3 (pliki rozłączne z W2).
- **Kryteria zabicia.** Sędzia albo audytor rozpoznaje ramię: zadanie jest nieważne. Ponad 2 takie przypadki:
  runda nieważna.

### E2-W4 — analiza i decyzja
- **Cel.** Dla tej rundy `n=6` niezmienione progi preregistracji 1–2 oraz dodany decyzją D2 główny próg kosztu
  (próg 5 prereg) są jawnym, zapisanym odstępstwem od progów ADR 0002. Progi ADR (+20 pp, połowa luki, +10 pp)
  obowiązują późniejszą rundę 20 zadań. Decyzja dla pakietu jest pozytywna tylko wtedy, gdy B spełnia próg
  jakości 1 i główny próg kosztu 5 przy zerze uciekających P0/P1; jeśli warunek kosztu nie jest spełniony,
  wynik nie uzasadnia pakietu.
  Raport pokazuje osobno pozostałe progi prereg i ich rolę:
  - tabele per zadanie i ramię;
  - próg 1: B ma więcej pierwszych PASS niż A na co najmniej 4/6 zadań i niż C na co najmniej 4/6, bez
    dodatkowego uciekającego P0/P1 względem A ani C;
  - próg 2 „w stronę Opusa”: zamknięcie co najmniej 50% luki PASS, `(PASS_B − PASS_A)/(PASS_R − PASS_A)`,
    tylko gdy `PASS_R > PASS_A`; w przeciwnym razie wynik jest nierozstrzygający;
  - progi 3–4 jako sygnały wspierające: mediana napraw B nie większa niż A i C; liczba blokujących znalezisk
    pierwszego werdyktu B niższa niż A i C;
  - metryka główna operatora: koszt na zaakceptowany wynik przy zerze uciekających P0/P1, łącznie i per zadanie,
    z progiem `koszt_B ≤ 0,5 × koszt_R`, z cennika manifestu i cache liczonym po cenie cache; próg dotyczy
    zaakceptowanych wyników bez uciekających defektów;
  - próg 5 dodatkowo nakazuje opisać jako kompromis jakości/kosztu, a nie bezwarunkową wygraną, jeśli mediana
    tokenów B przekracza A o ponad 25%; próg 6 zabrania twierdzeń o istotności przy `n=6` i wykluczeń post hoc.

  Decyzja trafia do statusu ADR 0002.
- **Moduły/pliki.** `evals/woz/results.json`, `evals/woz/report.md`, `docs/adr/0002-brain-v2.md` (tylko status i
  konsekwencje), `test/woz-report.test.ts`.
- **Akceptacja.**
  - Brak wykluczeń post hoc.
  - Nieważne i brakujące wyniki są zachowane.
  - Etykieta `n=6` i brak twierdzeń o istotności.
- **Falsyfikator (red first).** `test/woz-report.test.ts` przelicza progi z rekordów W2 i W3 i asertuje zgodność z
  `results.json`. Na bazie wyników nie ma.
- **Zależności.** W3.
- **Grupa równoległa.** P4.
- **Kryteria zabicia (progi prereg dla n=6).**
  - Niespełnienie progu 1 albo kosztu B ≤ 0,5 × R przy zerze uciekających defektów: stop produktyzacji pakietu
    (bez potoku, indeksu i pakietu w `relay`), a teza zostaje zawężona do „mózg jako źródło standardów dla verdictu”.
  - Niespełnienie progu 2 oznacza brak potwierdzenia tezy „w stronę Opusa”; progi 3–4 pozostają sygnałami
    wspierającymi i nie zastępują progów 1 i 5.

## 6. Ścieżka K — domknięcie E1

### E2-K0 — rejestr checków `krn` i rekord wyników E1
- **Cel.**
  - `krn.checks.json` w `krn` z ID `typecheck`, `lint` i `rules` dla verdictu w bwrap bez sieci oraz
    `gate-local` (pełny `npm run gate`) dla R4. Suite nie może działać wewnątrz bwrap verdictu.
  - `evals/journeys/e1-results.json` z wynikiem nr 1: LON-200, SHA `695df905` w `krn-codex-skills`, akceptacja
    2026-10-08 17:19, tokeny i ograniczenia z rekordu L1g.
- **Moduły/pliki.** `krn.checks.json`, `evals/journeys/e1-results.json`, `test/checks-registry.test.ts`.
- **Akceptacja.** `verdict.judge` na commicie `krn` uruchamia 3 checki w bwrap i przechodzi.
- **Falsyfikator (red first).** `test/checks-registry.test.ts` asertuje, że
  `resolveChecks(repo, 'HEAD', ['typecheck','lint','rules'])` zwraca 3 checki. Na bazie pliku nie
  ma i obietnica zostaje odrzucona (`assert.doesNotReject`).
- **Zależności.** R0 (job `krn/gate`); check `gate-local` z R4 uruchamia pełne `npm run gate` na hoście.
- **Grupa równoległa.** P2.
- **Kryteria zabicia.** Suite nie może działać wewnątrz bwrap verdictu: rejestr ogranicza się do `typecheck`,
  `lint` i `rules`, a ograniczenie trafia do rekordu.

### E2-K1 — „krn builds krn”: co najmniej 2 kolejne zaakceptowane wyniki
- **Cel.** Lead zakłada w projekcie Paperclip `krn` 3 issue. Każde jest realne, dwuetapowe i ma `krn-contract` z
  checkami z K0. Zadania nie leżą na ścieżce krytycznej E2; kandydaci z G2 NON-BLOCKING:
  - usunięcie zaślepek `NotImplemented` i barrela (`hosts/index.ts`, `memory/index.ts`, `foreman/index.ts`; K3);
  - `capsule-cas.test.ts` bez ścieżki hosta, z wyjęciem pliku z `test/isolation.json`;
  - deduplikacja typów `foreman/types.ts` względem `relay/capsule-store.ts`.

  Przebieg każdego zadania:
  1. `KRN_LIVE=1 npm run live -- --repo <klon krn> --job … --issue LON-x --submit`;
  2. `verdict_pass` prowadzi do `in_review`;
  3. lead publikuje gałąź `krn/LON-x-slug` jako PR i dostaje statusy, które już istnieją;
  4. merge commitem i akceptacja według ADR 0007 (`done`).
- **Moduły/pliki.** Tylko diff samej podróży. Dowody zapisuje K3.
- **Akceptacja.**
  - ≥2 zaakceptowane wyniki; 3 próby dają zapas.
  - Każdy ma dokładny SHA, dowód verdictu, readback boardu `in_review` → `done`, tokeny per sesja, liczbę interwencji
    leada i ręczny log minut operatora.
- **Falsyfikator (red first).** Readback tylko do odczytu: issue ma `done` i komentarz dowodowy krn związany ze
  zmergowanym SHA. Przed przebiegiem status to `todo`.
- **Zależności.** K0, R0.
- **Grupa równoległa.** P3 (żywe; limit 2 przebiegów naraz dzielony z W2).
- **Kryteria zabicia.**
  - 3 kolejne porażki podróży, każda z nowym defektem: stop i wcześniejsze G3 z dowodem negatywnym.
  - Ponad 3 resety na epokę (blueprint §12): `human_decision`.

### E2-K2 — wymuszone przerwanie: `SIGKILL` foremana po commicie, który nie jest finalny
- **Cel.** Druga podróż z K1 jest zaprojektowana dwuetapowo, a prompt nie podpowiada kroku B (L1f). Przebieg:
  1. Krok A, checkpoint z `next` różnym od `done` i commit A, którego właścicielem jest foreman.
  2. Start S2.
  3. Po `session_started(S2)` i przed checkpointem S2 lead wysyła `SIGKILL` do procesu node `live-l1`; handlery się
     nie wykonują.

  Wyzwalaczem jest commit A w `git log` worktree plus `session_started(S2)` w trace, a nie `session_ended`.
  Wznowienie przez `npm run live -- --worktree <wt> …` musi:
  - posprzątać osierocone scope'y przed nową sesją;
  - zapisać S2 jako `session_lost`;
  - uruchomić S3 z ID różnym od S2;
  - zachować commit A dokładnie raz;
  - wykonać krok B z kapsuły;
  - przejść `verdict_pass`, `in_review` i akceptację.

  Przed przebiegiem lead puszcza na `gate-local` istniejące testy `session_lost` i `codex-stale-scope` jako sondę.
  Defekt wykryty przez sondę staje się osobnym slice'em naprawczym z własnym falsyfikatorem.
- **Moduły/pliki.** Brak. Dowody zapisuje K3.
- **Akceptacja.**
  - Kolejność w trace: `session_started(S2)` | KILL | `intent` → `session_lost(S2)` → `reapedScopes` niepuste albo
    potwierdzony brak ocalałych → `session_started(S3≠S2)` → `checkpoint(done)` → `verdict_pass(sha)` →
    `in_review`.
  - Najwyżej jeden proces `codex` naraz.
  - Zero ocalałych procesów na końcu.
  - 0 promptów rekonstrukcyjnych.
  - Remote i board bez zmian poza zapisem `in_review`.
- **Falsyfikator (red first).** Readback trace i Git po przebiegu: istnieje para `session_lost(S2)` i
  `session_started(S3)` z różnymi ID, a `git log --format=%s` zawiera commit A dokładnie raz. Przed przebiegiem
  takiego śladu nie ma.
- **Zależności.** Pierwsza podróż K1 zaakceptowana, K0.
- **Grupa równoległa.** P4 (sam przebieg żywy).
- **Kryteria zabicia.**
  - Wznowienie kończy się `already running`, `HEAD changed` albo duplikatem commita: dowód negatywny, jeden slice
    naprawczy z nazwaną poprawką i najwyżej jedna ponowna próba (procedura G2).
  - Druga porażka: G3 z dowodem negatywnym; E1 nie jest ogłaszane.

### E2-K3 — rekord wyjścia E1 i bramka G3
- **Cel.**
  - `evals/journeys/e1-results.json`: ≥3 zaakceptowane wyniki i rekord przerwania z K2.
  - Metryki:
    - główna: koszt na zaakceptowany wynik przy zerze uciekających defektów;
    - wtórne: tokeny wejścia na wznowienie, odsetek akceptacji, interwencje leada.
  - Porównanie z B0 z jawną nieporównywalnością (D5; w B0 T2 brakuje tokenów wyjścia).
  - Potem G3: świeży Opus, read-only. Wyjście z E1 rozstrzyga operator.
- **Moduły/pliki.** `evals/journeys/e1-results.json`, `test/e1-exit.test.ts`.
- **Akceptacja.** Każdy wynik ma `n`, etykietę i ograniczenia. Raport G3 jest zapisany w `docs/program/reviews/`.
- **Falsyfikator (red first).** `test/e1-exit.test.ts` asertuje:
  - ≥3 zaakceptowane wyniki z SHA i readbackiem boardu;
  - ≥1 rekord z `signal: "SIGKILL"`, `killedSession ≠ resumedSession` i ≥1 commitem przed zabiciem, który nie jest
    finalny.

  Na bazie jest 1 wynik i 0 przerwań.
- **Zależności.** K1, K2; D5.
- **Grupa równoległa.** P4.
- **Kryteria zabicia.** Mniej niż 3 zaakceptowane wyniki po 5 próbach podróży: zamrożenie rdzenia według blueprintu
  §12 (z metryką z decyzji operatora). Decyzja należy do operatora.

## 7. Kolejność i grupy równoległe

Każda grupa jest izolowana plikowo. Wspólne kontrakty, czyli schemat rekordu i port GitHub, mają jednego właściciela
w danej grupie.

| Grupa | Slice'y | Warunek wejścia | Wspólne pliki rozdzielone |
|---|---|---|---|
| P0 | D1–D5, PR #5/#4 zastępują PR #2/#3; PR #1 już zmergowany | — | — |
| P1 | R0, R1, R2, W0, W1 | P0 (W0: D2, D3) | `src/flow`: R1 ma `pr/github/cli`, R2 ma `index/policy/types/repository`; `package.json` tylko R0 |
| P2 | R3, R4, K0 | R3 po R2; R4 po R1 i K0; K0 po R0 | R3 ma `index/panel/types/risk`; R4 ma `cli/index` i `gate-local` |
| P3 | R5, R6, W2+W3, K1 | R5 po R0–R2 i R4; W2 po W0, W1, R2; K1 po K0 | przebiegi żywe: ≤2 naraz na hoście |
| P4 | K2, W4, K3 → G3 | K2 po pierwszej akceptacji z K1; W4 po W3; K3 po K1 i K2 | — |

## 8. Wyjście z E2 i kryteria zabicia całości

**Wyjście:**
- 10 kolejnych PR-ów w `krn` scalonych przez pipeline leada: trzy sukcesy statusów na dokładnym headzie albo
  wiersz override; API readback potwierdza SHA i autora każdego statusu. Co najmniej 1 osądzony PR w każdym repo
  z pierwszej fali R5;
- raport R6 z `n=20`;
- raport W4 i status ADR 0002;
- rekord K3 i raport G3.

**Kill całości [POLICY]:**
- Interwencje leada na zaakceptowany wynik nie spadają po 10 PR-ach: wdrożenie `krn review` stoi, skrypty leada
  zostają.
- Konfiguracja pomiaru Wizard-of-Oz przekracza 4 h (tripwire „teatr pomiarowy”): stop i uproszczenie.
- Budżet Claude: Opus pracuje tylko w G3, w ramieniu R i w pracy leada. Przekroczenie pułapu tygodniowego zatrzymuje
  R, a G3 przechodzi do następnego okna.

**Ryzyko rezydualne:**
- `main` w `krn-works` jest bez ochrony, więc egzekwowanie zależy od pipeline'a merge'a i dyscypliny leada. Status
  commita z tokenem PAT może wystawić każdy z prawem zapisu; API readback w R5 sprawdza więc autora każdego statusu.
- Sędziowie i red-first działają wyłącznie na hoście (scope systemd, bwrap, poświadczenia Codex). CI w kontenerze ich
  nie zastąpi bez osobnej decyzji o izolacji i sekretach na runnerze.
