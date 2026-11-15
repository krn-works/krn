# Projekt: ograniczona hierarchia Astra → Luna

> **Rola:** projekt deweloperskiego harnessu orchestratora
> **Status:** `DRAFT`; propozycja do przeglądu, nie wdrożona architektura
> **Właściciel:** maintainer orchestratora · **Konsument:** operator rozwijający Tallystick
> **Zakres:** rozwój repozytorium Tallysticka; bez produktowej task queue i bez zmian MVP-0
> **Źródła:** [SOURCES](SOURCES.md), [SPEC](../../SPEC.md), [AGENTS](../../AGENTS.md)
> **Kiedy traci aktualność:** po zmianie hosta, SPEC albo granicy harnessu.

Data opracowania: 2026-09-10.
**Repozytorium:** korneliuszburian/tallystick, stały **code fixed point** tego audytu: `ec9829d42441ffb026fa4131b5077177d943a25a`; późniejsze commity dokumentacyjne nie zmieniają tego pomiaru. `ddc81034add54bf47bf63b5a11e48ed1bd64d4d9` pozostaje wyłącznie historycznym punktem odniesienia.
Źródła: identyfikatory S1–S14 oraz R1–R5 opisano w `SOURCES.md`.

## 1. Cel i miernik sukcesu

Celem jest uzyskać więcej poprawnych, zweryfikowanych rezultatów z konta Pro 5×, bez poszerzania niekontrolowanych uprawnień. Liczba agentów, długość logu, zgodność opinii modeli i liczba wygenerowanych linii kodu nie są miernikami sukcesu.

Hipoteza: Astra jest użyteczna do rozkładu problemu i integracji, Luna do wąskich kontraktów; Sol jest wariantem porównawczym koordynatora i opcjonalnym recenzentem. Bieżąca polityka właściciela nie uruchamia Astry ani Sol bez potrzeby; jeśli Sol zostanie użyty, ma pracować w trybie low przy tworzeniu issue/zadań i delegowaniu, a rola `sol_reviewer` pozostaje wyłączonym wariantem benchmarku. Konfiguracja zawiera kandydackie identyfikatory ról; sama dokumentacja nie potwierdza, że child rzeczywiście uruchomił się z danym modelem [S1]. Dostępność na konkretnym koncie i tożsamość wykonania muszą zostać zmierzone.

## 2. Nienaruszalna granica odpowiedzialności

Codex jest runtime'em: utrzymuje sesje, reasoning, wybór narzędzi i delegację. Skill opisuje sposób pracy głównej sesji. Tallystick zachowuje dokładnie cztery moduły i deterministyczny hot path; historyczny alias LEDGER pozostaje w nazwach technicznych. Ewentualny klient App Server jest cienką, deterministyczną integracją hosta, a nie nowym agentem ani bezpośrednim klientem modelowego HTTP API [R1, R2, S7].

Nie dopisujemy `src/orchestrator/`, provider adapters ani nowych rodzajów eventów do MVP-0. Hostowe metadane zadań pozostają odrębnymi artefaktami integracji; nie udają Evidence Receipts i nie zastępują Event Ledgera.

## 3. Trzy warianty

**A — rekomendowany start: natywna hierarchia.** Jedna sesja Astra, jawnie delegowane role Luna, świeże konteksty, synteza przez rodzica. Mała powierzchnia integracyjna, ale instrukcje skilla nie są twardym enforcementem [S2].

**B — etap docelowy: ta sama hierarchia + zweryfikowana granica wykonania.** Host ogranicza uprawnienia i wszystkie dozwolone ścieżki efektów; istniejące middleware Tallysticka obsługuje wspierane żądania wykonania. Konieczny rzeczywisty audyt S.6. To nie zmienia pętli Codexa [R3–R5].

**C — odrzucony na start: autonomiczny peer swarm.** Wszyscy rozmawiają ze wszystkimi, wybierają zadania i tworzą następców. Utrudnia przypisanie odpowiedzialności, kontrolę budżetu i odbiór. Nie ma wykazanego zysku dla Tallystick. Framework korzystający z API to ponadto osobny model kosztowy względem wykorzystania konta Pro [S4].

## 4. Role i przepływ

```text
Człowiek / zatwierdzony zakres
             |
     Astra w sesji Codexa
       plan / DAG / synteza
             |
      natywna delegacja
       /        |         
 Luna mapper   Luna test analyst   Luna patch author
       \        |         /
       raporty + referencje do źródeł
             |
   świeży recenzent Sol lub Luna
             |
   testy uruchomione przez zaufany host
             |
   propozycja zmiany / PR do zatwierdzenia
```

Role w paczce są tylko do odczytu. `luna_patch_author` zwraca propozycję patcha w odpowiedzi, nie zapisuje jej. Dopiero etap P3 może przyznać jednemu wykonawcy kontrolowany zapis w disposable workspace.

Astra nie zatwierdza sobie rozszerzenia uprawnień. Recenzent nie podpisuje permitów. Runner nie uznaje tekstu „PASS” za wynik testu. Wybór innego modelu recenzenta jest dodatkową perspektywą, a nie drugim niezależnym eksperymentem.

## 5. Reguły delegowania

Start: root + maksymalnie 3 otwarte wątki potomne; zwykle 2 równoległe analizy i recenzja po ich zamknięciu. Limit trzech otwartych child threads i sześciu delegacji na run jest propozycją harnessu; [S3] oznacza politykę promptu/organizacyjną, a P0 nie zmierzył hostowego licznika. Nie opisujemy tego jako natywnego ograniczenia ani twardej gwarancji.

Wyłączamy narzędzia delegacji w konfiguracji liści i testujemy efektywny wynik po dziedziczeniu. Nie zakładamy istnienia opcji `max_depth`. Niezależny limit całego drzewa wymaga kontroli po stronie hosta przed uruchomieniem potomka; sam `SubagentStart` nie jest dowodem odmowy startu.

Delegacja wymaga zysku: niezależne wejścia, jasno zdefiniowany rezultat i mały pakiet kontekstu. Gdy dwa zadania potrzebują ciągłej negocjacji wspólnego interfejsu, najpierw Astra zamraża kontrakt, a praca przebiega sekwencyjnie. Nie rozbijamy jednej małej poprawki na komitet pięciu agentów.

## 6. Kontrakt zadania

`contracts/task.schema.json` jest propozycją hostowego formatu dla zadań **harnessu deweloperskiego**, **nie API Tallysticka ani jego przyszłej kolejki produktowej**. Pola obejmują: run/task/attempt, bazowy SHA, rolę, cel, zależności, dozwolone ścieżki, kryteria odbioru, ograniczenia i zweryfikowany identyfikator epoki albo jawny brak pomiaru.

Rodzic przekazuje wybrane fragmenty SPEC/AGENTS, właściwe interfejsy i niezbędne pliki. Nie kopiuje całej historii ani surowych komunikatów innych agentów jako nowych poleceń. Tekst z repozytorium, sieci i narzędzi jest materiałem dowodowym o określonym poziomie zaufania; nie może nadać nowych uprawnień.

Raport pracownika zawiera osobno: twierdzenia, lokalizacje dowodów, proponowane zmiany, wykonane i niewykonane testy, niepewności, konflikty. Referencja do pliku/wiersza nie jest Evidence Receipt. Tylko zaufana integracja weryfikuje powiązanie receipt z raw i pomiarem stanu.

## 7. Stan zadania, retry i odtwarzanie

Proponowane stany hostowe:
`PLANNED → READY → RUNNING → REPORTED → REVIEWED → VERIFIED → PROPOSED`.
Osobne wyjścia: `BLOCKED`, `NEEDS_DECISION`, `UNKNOWN`, `CANCELLED`.

`REPORTED` jest deklaracją pracownika. `VERIFIED` wymaga zewnętrznej kontroli kryteriów. Brak odpowiedzi nie oznacza porażki bez efektu. Utrata sesji, crash po spawn lub niepewność po timeout prowadzą do `UNKNOWN`; zero automatycznych ponowień do reconciliation [R5].

Wygaśnięcie lease nie dowodzi, że poprzedni proces przestał działać. Przejęcie zadania wymaga odcięcia jego uprawnień i sprawdzenia stanu. Idempotencja dispatchu nie zapewnia exactly-once skutków dowolnej komendy.

Dwie rundy poprawy to proponowany limit organizacyjny, nie pozwolenie na dwa identyczne wykonania. Retry wykonania musi przejść Failure Gate. Zmiana task_id, timestampu, raportu albo modelu nie jest zmianą epoki eksperymentu. Podpisanego escape proof nie tworzy model.

## 8. Płaszczyzna wykonania i stan faktyczny

Obecne `createLedgerMiddleware(...).intercept(...)` zwraca `BLOCK`, `UNKNOWN` albo `EXECUTED` z digestem i receipt [R5]. W tej rewizji jedna instancja szereguje wywołania przez Promise chain. Nie omijamy tego dla pozornej równoległości.

Etap pierwszy rozdziela równoległe rozumowanie od pojedynczego wykonawcy efektów. Kilka instancji middleware, wspólny storage i równolegli writerzy wymagają osobnych testów: poprawność pojedynczej instancji nie dowodzi poprawności wielu rootów i procesów.

ExecutionPermit w Tallysticku dotyczy wykonania procesu w obsługiwanym pipeline. Nie zakładamy, że automatycznie ogranicza tworzenie modelowych subagentów, połączenia MCP, modyfikacje plików przez native tools czy pracę zdalnych aplikacji.

Natywne hooki są przydatne diagnostycznie, lecz ich zachowanie i pokrycie nie zostały w tym repozytorium potwierdzone [S8]. Post-hook nie cofa skutku. Wariant `enforce` wymaga pomiaru wszystkich dozwolonych ścieżek i model-facing admission; brak dowodu blokuje start, a nie uruchamia observer mode [R3].

## 9. Izolacja i niedestrukcyjność

Worktree izoluje zmiany Git, lecz nie jest granicą bezpieczeństwa. Może współdzielić metadane, konta OS, cache i poświadczenia. Minimalny eksperyment używa niewrażliwego, osobnego snapshotu oraz sandboxa z ograniczonym filesystemem, zasobami i siecią. Sekrety inferencji pozostają po stronie hosta, poza odczytem narzędzi wykonawcy [S9].

Dla piszącego wykonawcy: jeden prywatny workspace, jawnie dopuszczone pliki i brak zapisu do pozostałych. Chronione są metadane Git, konfiguracja hosta, SPEC/AGENTS, niezależne testy odbioru, harness, CAS i klucze. Rola przyznana przez prompt nie realizuje ochrony filesystemu. Samo `0600` nie chroni przed procesem działającym jako ten sam użytkownik.

Brak produkcyjnych poświadczeń, zdalnego push, automerge, deploy, publikacji, trwałych daemonów i modyfikowania polityki. Instalacja zależności jest etapem zaufanego provisioningu; skrypty testów i package managera również wykonują kod. Nie uznajemy dowolnego `npm test` za bezpieczny wyłącznie po nazwie.

Sieć narzędzi jest domyślnie wyłączona; połączenie hosta z usługą modelową to inna ścieżka. Ewentualny dostęp do dokumentacji przechodzi przez ograniczony fetcher; sam HTTP GET nie oznacza braku skutków. Zdalne MCP, aplikacje i narzędzia hostowane wymagają osobnej polityki, niezależnie od sandboxa shella.

## 10. Wspólna tablica i lekcje z incydentów

Bezpiecznym odpowiednikiem „message board” jest jawny kanał rodzic–dziecko i proponowany hostowy rejestr zadań. Trwały rejestr nie jest zaimplementowany w tym repozytorium (S10). Autor zadania, zakres, wersja i pochodzenie pozostają widoczne. Nie budujemy anonimowej tablicy, z której dowolny agent może przejąć cele lub uprawnienia.

Scenariusze nieuprawnionej komunikacji, przyjmowania cudzych celów, nacisku na wynik i manipulowania dowodem pozostają hipotezami do zewnętrznego źródła i pomiaru; repozytorium nie przedstawia ich jako zebranych dowodów [S12, S13]. Nie kopiujemy exploitów, ukrytej persistencji ani self-replication. Uczciwe `BLOCKED` jest poprawnym wynikiem, nie karą skłaniającą do obejścia ograniczeń.

Surowe evidence zapisuje zaufany host poza writable scope workerów. Hash-chain nie dowodzi prawdy wypowiedzi; gwarancje integralności zależą też od ochrony zapisu i kluczy. „Dwie Luny mówią PASS” nie zastępuje rzeczywistego exit code i niezmienionych testów.

## 11. Koszt i pomiar

Pro 5× nie jest pięcioma kontami ani pulą API dla dowolnego frameworka [S4, S5]. Mierzymy sumę pracy root, wykonawców, recenzji, napraw i powtórnego dostarczenia kontekstu. Sama liczba tokenów jest tylko przybliżeniem zużycia uprawnień planu; gdy host nie ujawnia naliczenia, wynik oznaczamy jako proxy.

Porównanie: Astra solo, Sol + 2 Luna, Astra + 2 Luna. Te same zamrożone zadania, zakres, testy, limity i kryteria. Wynik: poprawnie przyjęte rezultaty na zmierzone zużycie, czas do akceptacji, konflikty, błędy i naruszenia granic. Mały pilotaż nie dowodzi uniwersalnej przewagi żadnego modelu.
