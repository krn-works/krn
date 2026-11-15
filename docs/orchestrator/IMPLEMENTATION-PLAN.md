# Astra–Luna Orchestrator — plan realizacji

> **Rola:** plan deweloperskiego harnessu orchestratora
> **Status:** `DRAFT` — nie jest zatwierdzoną implementacją ani specyfikacją funkcji task queue Tallysticka
> **Właściciel:** maintainer orchestratora · **Konsument:** wykonawca zatwierdzonego etapu P0–P5
> **Zakres:** pilot Astra → Luna → Sol dla rozwoju repozytorium; bez zmian MVP-0
> **Źródła:** [SPEC](../../SPEC.md), [AGENTS](../../AGENTS.md), [DESIGN](DESIGN.md), [SOURCES](SOURCES.md), [macierz bezpieczeństwa](SECURITY-TEST-MATRIX.md)
> **Kiedy traci aktualność:** po zmianie hosta, SPEC albo decyzji o osobnej funkcji kolejki zadań Tallysticka.

**Cel:** jawna, ograniczona delegacja w Codexie, najpierw bez zapisów, potem z udowodnioną granicą wykonania.
**Architektura:** główna sesja Astra lub Sol, wąskie role Luna, deterministyczny host, niezmienione cztery moduły Tallysticka (Event Ledger, Acquisition Adapters, State Twin, Failure Antibody Gate).
**Technologie:** obecny Codex, Markdown skills, TOML, istniejący TypeScript/Node Tallysticka. Bez nowej biblioteki agentowej na start.
**Projekt:** `DESIGN.md`, status DRAFT. Poniższe kroki są planem, nie wynikiem testów.

## Ograniczenia globalne

Źródło prawdy repo: `SPEC.md`, `AGENTS.md` na SHA przypiętym w danym przebiegu. Historyczny `ddc81034add54bf47bf63b5a11e48ed1bd64d4d9` nie jest bieżącą rewizją.
Nie zmieniać publicznego API, nazw czterech modułów ani dodawać pętli provider HTTP. Nie rozszerzać MVP-0 przy okazji skilla. Nowe zadanie integracyjne wymaga odrębnego zatwierdzenia zakresu.
Nie pisać do main ani współdzielonego checkoutu. Nie resetować istniejącego repo. Nie używać produkcyjnych sekretów. Nie przedstawiać statycznego parsera jako testu hosta.
`UNKNOWN` nie podlega automatycznemu retry. Konflikt SPEC zatrzymuje dane zadanie. Nie wyłączać failing checks, nie zmieniać testu odbioru tylko po to, by zniknął błąd.

## Mapa plików

PR pilotażu może dodać wyłącznie:

```text
.agents/skills/orchestrator/SKILL.md
.agents/skills/orchestrator/agents/openai.yaml
.codex/agents/luna_mapper.toml
.codex/agents/luna_test_analyst.toml
.codex/agents/luna_patch_author.toml
.codex/agents/sol_reviewer.toml
docs/orchestrator/DESIGN.md
docs/orchestrator/IMPLEMENTATION-PLAN.md
docs/orchestrator/SECURITY-TEST-MATRIX.md
docs/orchestrator/SOURCES.md
docs/orchestrator/P0-HOST-REPORT.md
contracts/task.schema.json
contracts/pressure-tests.json
```

Zmianę `.codex/config.toml` przegląda się osobno wobec istniejącej konfiguracji. Paczka nie zawiera przykładowego `config.toml`; obecne TOML-e ograniczają się do definicji ról.
Pliki pomiarowe hosta, snapshoty, logi i sekrety powstają w osobnym katalogu eksperymentu poza badanym repo. Nie dodajemy ich do Git.

Dalszy klient integracyjny powstaje dopiero po P2, w odrębnym zatwierdzonym workspace `host-integration/`, nie jako `src/orchestrator` Tallysticka. Jego dokładny transport wybiera się na podstawie wyniku P2; brak odpowiedniej powierzchni kończy etap jako BLOCKED, nie jako implementacja domniemanego hooka.

## P0 — potwierdzenie możliwości hosta i konta

**Pliki wyjściowe poza repo:** `preflight.json`, `effective-config.txt`, `tool-inventory.json`, `permissions-evidence/`.
**Wejście:** wskazane konto Pro, zainstalowany host, izolowane fixture repo.
**Wyjście:** przypięta wersja i konfiguracja, zmierzone modele, właściwości delegacji i narzędzi. Brak zmiany kodu.

- [ ] Odczytać wersję hosta jego faktycznym interfejsem pomocy; zapisać OS, wersje, repo SHA i stan checkoutu.
- [ ] Odczytać listę dostępnych modeli przez faktycznie udokumentowany interfejs bieżącego hosta (np. `/model` albo App Server `model/list`, wyłącznie jeśli są obsługiwane). Zanotować Astra/Sol/Luna i dozwolony reasoning effort; brak modelu daje BLOCKED dla danego wariantu, bez zgadywania aliasu.
- [ ] Sprawdzić, że uwierzytelnienie używa zamierzonego konta, a nie odziedziczonego API key. Nie kopiować tokenów do workspace ani raportów.
- [ ] Zinwentaryzować narzędzia głównej sesji i dziecka, ustawienia dziedziczone, MCP, aplikacje, hooki, shell, patch, code mode, sieć i kontrolę procesów. Zarejestrować, co rzeczywiście można wyłączyć.
- [ ] Na inertnym zadaniu utworzyć jednego potomka i potwierdzić model w metadanych hosta, nie na podstawie deklaracji „jestem Luna”.
- [ ] Sprawdzić faktyczne wyłączenie delegacji w liściu, limit otwartych wątków oraz zachowanie root override wobec uprawnień dziecka. Nie wywoływać skutków poza fixture.
- [ ] Zbudować evidence dla nierozstrzygniętych elementów; status końcowy PASS tylko dla zmierzonych własności. Pozostałe BLOCKED.

**Odbiór:** istnieje rzeczywisty ślad parent→child z właściwym modelem; nie ma niezinwentaryzowanych kanałów efektów w deklarowanym profilu. Ten wynik nadal nie jest S.6.

## P1 — skill i pilotaż tylko do odczytu (`BLOCKED` w bieżącym profilu)

**Pliki:** mapa PR powyżej; skill, role i testy presji z `contracts/pressure-tests.json`.
**Zależność:** P0 dla profilu pilotażu. Bieżący P0 wykazał brak wymaganej izolacji childa, więc P1 pozostaje `BLOCKED` do czasu nowego pomiaru; nie wymaga pozornego ogłoszenia Tallystick enforce.
**Wejście:** bezpieczny snapshot bez sekretów, jawnie zatwierdzony eksperyment.
**Wyjście:** raport architektury, testów i propozycja patcha w odpowiedzi; zero zapisów do snapshotu.

- [ ] Najpierw wykonać scenariusze presji bez nowego skilla i zachować baseline zachowania. Nie wymagać naruszenia: gdy scenariusz już przechodzi, zapisać ten fakt.
- [ ] Przejrzeć szkic skilla i konfiguracje; zainstalować je tylko do środowiska pilotażu. Nie dodawać writer permissions.
- [ ] Wywołać jawnie `$orchestrator` w sesji uruchomionej z wybranym modelem root. `/orchestrator` nie jest dostarczonym aliasem.
- [ ] Zlecić `luna_mapper` prześledzenie `src/index.ts`; równolegle `luna_test_analyst` ma wskazać istniejące testy i luki dowodowe. Żaden agent nie uruchamia testów ani instalacji w tym pilotażu.
- [ ] Zamknąć zakończone wątki; przekazać `sol_reviewer` kryteria i konkretne źródła, nie sugestię oczekiwanego werdyktu.
- [ ] Powtórzyć testy presji ze skillem. Zachować raporty, pełne ślady i listę narzędzi; nie usuwać nieudanych prób.
- [ ] Porównać manifest plików fixture przed i po. Odbiór wymaga identycznej zawartości i braku nowych plików.

**Odbiór:** jawne modele, rozróżnienie dowodu i opinii, poprawne odmowy, niezmieniony snapshot. Narzędzia zdalne i wyjście do sieci muszą być rzeczywiście niedostępne. To pilotaż zachowania, nie dowód odporności skilla na każdą manipulację.

## P2 — spike granicy Codex ↔ Tallystick, bez nowej architektury modelowej

**Źródła w repo:** `docs/DESKTOP-INTEGRATION-AUDIT.md`, `src/index.ts`, `SPEC.md` R.5/S.6.
**Pliki eksperymentu:** `execution-path-matrix.json`, `boundary-results.jsonl`, `raw/`, `model-facing/`, `negative-tests/` poza fixture i poza writable scope agenta.
**Wejście:** działające P0/P1, istniejące API middleware. **Wyjście:** PASS/FAIL/BLOCKED dla każdej ścieżki.

- [ ] W kontrolowanym środowisku uruchomić bazową weryfikację repo, zapisując rzeczywiste exit codes:

```sh
npm ci &&
npx --no-install tsc --noEmit &&
npm run test:acceptance &&
npm run demo
```

Provisioning, w tym `npm ci`, wykonuje zaufany operator; jest to wykonanie kodu zależności, nie „nieszkodliwy odczyt”. Wersje i dopuszczone zależności odczytać z aktualnego SPEC i lockfile.

- [ ] Przez rzeczywisty host zmierzyć wspierany interfejs podłączenia. Preferować zachowanie istniejącej pętli Codexa i jego narzędzi integracyjnych. Nie wykonywać `intercept` obok native shell i nie nazywać tego przechwyceniem native shell.
- [ ] Dla każdej ścieżki wykazać kontrolę przed efektem albo rzeczywistą niedostępność. Uwzględnić streaming, kontynuację sesji terminala, dziecko, resume, code mode, hook handlers i zdalne narzędzia.
- [ ] Dla powtarzalnej porażki wykonać trzy równoważne propozycje i niezależnie potwierdzić jeden proces. Licznik dowodowy nie może zmieniać dependencyPaths/epoki eksperymentu.
- [ ] Sprawdzić brak/zużycie permit i niedostępność brokera. Wymagane zero skutków; test nie może tworzyć bypassu w produkcji.
- [ ] Wygenerować inertny output >=100 KiB; przechwycić rzeczywisty input modelu. Sprawdzić raw archive, commit, receipt, digest i brak wcześniejszego raw streamu. Wskazanie pliku ze spill hooka nie jest dowodem spełnienia granicy.
- [ ] Sprawdzić crash, timeout oraz niepoprawną odpowiedź hooka. Odróżnić brak obserwowalności od zaobserwowanego naruszenia.
- [ ] Wydać raport: brak odpowiedniego interfejsu lub obserwowalności → BLOCKED; rzeczywisty bypass → FAIL. `enforce` nie startuje przy żadnym z tych braków.

**Warunek decyzji:** jeśli obecny host nie umożliwia kontraktu, wynik etapu jest pełnoprawną diagnozą. Nie wymyślać flag, nie dodawać cichego fallbacku. Ewentualna zmiana hosta/kontraktu wymaga osobnego ADR i zgody.

## P3 — jeden piszący wykonawca, tylko po bramkach

**Zależności:** zatwierdzony projekt hostowej integracji, PASS wymaganych punktów S.6, ochrony plików i dowodów.
**Proponowane pliki integracji:** `host-integration/README.md`, `host-integration/policy.json`, `host-integration/tests/single-writer.spec.md`. Implementację transportu określa zaakceptowany wynik P2; nie dostarczamy jej w tym pakiecie.
**Wejście:** zaakceptowany kontrakt zadania i snapshot SHA. **Wyjście:** prywatny patch z dowodami; bez push/merge.

- [ ] Najpierw test negatywny: próba zapisu do pliku spoza scope zostaje zatrzymana przed zapisem; po teście zewnętrzny hash pliku jest bez zmian.
- [ ] Operator przygotowuje disposable workspace i read-only acceptance fixtures. Jeden wykonawca otrzymuje minimalny zakres zapisu; recenzent pozostaje read-only. Efektywne uprawnienia obu ról zostają ponownie zmierzone po dziedziczeniu.
- [ ] Test odbioru musi wykazać żądany regresyjny przypadek na bazie; następnie minimalna poprawka, ten sam chroniony test oraz pełne wymagane suity.
- [ ] Zaufany host sprawdza patch względem aktualnej bazy, typy plików, wyjścia poza zakres, symlinki, protected paths i niezmienione testy odbioru. Sama deklaracja listy plików przez agenta jest ignorowana.
- [ ] Po zmianie HEAD lub zależnych plików rewalidować wynik; nie stosować patcha do nowego stanu „na zaufanie”.
- [ ] Świeży review porównuje patch z kontraktem. Istotne naruszenie blokuje odbiór nawet po wyczerpaniu budżetu recenzji.
- [ ] Zachować raw, patch i raport. Przedstawienie PR jest osobnym, jawnym działaniem; brak automerge i brak automatycznego kasowania workspace.

**Odbiór:** jeden writer, brak efektów poza przyznanym zakresem, rzeczywiste przejście testów, odtwarzalne evidence i niezmieniony pierwotny checkout.

## P4 — równoległe analizy; ewentualne dwa niezależne zapisy

Nie rozpoczynać od zmiany serializacji middleware. Najpierw wykorzystać równoległość planowania, czytania i krytyki; tylko effects lane pozostaje sekwencyjny.

Dwa piszące zadania dopuścić wyłącznie po osobnym teście izolacji i odrębnej decyzji: różne snapshoty, storage i zakresy; zdefiniowane zasady zasobów wspólnych; serialna integracja patchy. Inna baza SQLite sama nie rozwiązuje konfliktu na wspólnym pliku lub usłudze.

Test: oba zadania kończą się niezależnie; zmiana wspólnego interfejsu wymusza ponowne sprawdzenie zależnego patcha. Konflikt nie jest rozstrzygany „ostatni zapis wygrywa”. Cancel odcina uprawnienia, zatrzymuje znane procesy i sprawdza brak potomków; nie usuwa evidence.

## P5 — pomiar wartości i wybór koordynatora

**Pliki eksperymentu:** `benchmark/cases.json`, `benchmark/runs.jsonl`, `benchmark/report.md`.
**Warianty:** Astra solo; Sol + 2 Luna; Astra + 2 Luna. Opcjonalny ten sam zewnętrzny reviewer we wszystkich wariantach.

Najpierw 6 niewrażliwych zadań tylko do odczytu. Po P3: 20 zamrożonych zadań obejmujących analizę, małe poprawki, testy i zadania celowo zablokowane. W miarę dostępnego budżetu po 3 powtórzenia; to pilot, nie gwarancja istotności statystycznej.

Zachować jednakowe wejścia, testy, limity i zasady akceptacji. Nie dawać rojowi trzykrotnie większego budżetu i nie nazywać tego przewagą architektury. Naprawy, review i ponowne wysłanie kontekstu wliczać do całości.

Mierzyć akceptowane wyniki, błędne akceptacje, czas do odbioru, widoczne zużycie planu, tokeny per model jako proxy, narzut koordynacji, konflikty i naruszenia. Gdy quota nie jest obserwowalna, nie podawać oszczędności Pro w procentach.

Proponowana bramka promowania: zero zaobserwowanych naruszeń; brak pogorszenia jakości na tym zestawie; oraz korzyść kosztowa lub czasowa uzasadniająca większą złożoność. Orientacyjny próg operacyjny 20% poprawy ustalić przed pomiarami, nie dobierać po wynikach. Nie przedstawiać pilota jako dowodu uniwersalnego „best orchestrator”.

## Definicja ukończenia

P1 kończy się działającym, przetestowanym pilotażem zachowania. P3 kończy się izolowanym single-writer pipeline z rzeczywistymi dowodami. P5 uzasadnia wybór Astra/Sol albo powrót do jednego agenta. Żaden etap nie uzyskuje PASS tylko dlatego, że powstały pliki konfiguracyjne i atrakcyjny raport.
