# Tallystick — rejestr ustaleń audytu

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** kryteria reprodukcji i ewidencja dowodów · **Status:** OTWARTE — nie certyfikat S.6
> **Właściciel:** maintainer audytu · **Konsument:** kolejny audytor i właściciel issue #22
> **Zakres:** historyczny kod `ddc81034add54bf47bf63b5a11e48ed1bd64d4d9`; research 2026-09-09; code fixed point rewalidacji poniżej `ec9829d42441ffb026fa4131b5077177d943a25a`; późniejsze zmiany dokumentacyjne nie są nowym pomiarem kodu; aktualizacja redakcyjna 2026-09-10, Europe/Warsaw (UTC+02:00)
> **Źródła:** [S-RESEARCH i manifest źródeł](RESEARCH.md#pochodzenie-materiałów), rejestr F dostarczony przez właściciela
> **Kiedy ten dokument traci aktualność:** po zmianie właściwego kodu, kontraktu, profilu lub nowym rozstrzygającym teście; każda pozycja wymaga własnej rewalidacji.

## Jak czytać wynik

A01–A24 zachowują treść i status źródłowego researchu. F01–F15 pozostają identyfikatorami osobnego rejestru; mapa poniżej nie zamienia ich w nowe numery ADR. Priorytet „wysoki” nie oznacza patologii P1–P10. Statyczna obserwacja i proponowana reprodukcja nie są wynikiem wykonanego testu.

Czytaj ten historyczny rejestr razem z [korektami interpretacji K01–K11](RESEARCH.md#korekty-interpretacji-materiału) oraz [mapą odrębnych numeracji SD/SR](RESEARCH.md#identyfikatory-zawsze-z-pochodzeniem). Dotyczy to również F02/A12 (K05) i A14 (K06). Oryginalne ustalenia pozostają poniżej bez zmian; opis statusu PR w A23 dotyczy daty źródła, nie bieżącego GitHub.

**Nie są defektami MVP-0 same w sobie:** brak pełnego Context Atlas, semantic memory lifecycle, Recovery Engine, Claim Publisher i Compounding Evaluator. To granica [R.0](../SPEC.md#r0-zakres-środowisko-i-struktura). Receipt w pamięci jest dopuszczony przez [ADR-016](../SPEC.md#adr-016--kompozycja-middleware-zużycie-permit-klucz-i-obwoluta-receipt); historyczny plan ADR-010 nie upoważnia do żądania nowego eventu receipt.

## Rewalidacja code fixed point

Poniższa tabela jest dyspozycją dla wskazanych historycznych ustaleń na code fixed point `ec9829d42441ffb026fa4131b5077177d943a25a`. `RESOLVED` oznacza usunięcie opisanego mechanizmu w tym ograniczonym zakresie kodu/testów; nie zamyka całego A/F ani nie zastępuje nowej reprodukcji. Oryginalne A01–A24 i F01–F15 pozostają niezmienione jako evidence z własnego SHA; ten dopisek nie przenosi ich zakresu na późniejsze rewizje.

| Ustalenie | Dyspozycja na `ec9829d42441ffb026fa4131b5077177d943a25a` | Dowód lokalny |
|---|---|---|
| A07 / permit–request binding | `RESOLVED` dla verifiera adapters i jego użycia przez middleware; test negatywny pokrywa równoważny verifier wstrzyknięty do adapters | `src/index.ts:124-145`; inspekcja ścieżki middleware; `test/integration/e2e.test.ts:102-115` |
| A13 / eskalacja i reap procesu | `RESOLVED` dla ścieżek timeout/capture objętych testami POSIX; power-loss pozostaje poza dowodem | `src/adapters/index.ts:229-247`; `test/adapters/adapters.test.ts:240-254,256-290,393-400` |
| A14 / bounded digest | `RESOLVED` dla pól i kolekcji objętych reducerem; brak ogólnego claimu o wszystkich przyszłych digestach | `src/adapters/index.ts:80-141`; `test/adapters/adapters.test.ts:338-363,387-391` |
| A16 / SourceHandle i semantyka bajtów | `RESOLVED` dla przetestowanych ścieżek invalid UTF-8 shell oraz unknown git-diff; zakres nie obejmuje wszystkich przyszłych parserów | `src/adapters/index.ts:14-24`; `test/adapters/adapters.test.ts:69-74,218-237` |
| A18 / paginacja skanów | `RESOLVED` dla wspólnego `scanAll`; test poza pierwszą stroną dotyczy UNKNOWN, pozostałe ścieżki mają wyłącznie dowód inspekcji kodu | `src/ledger/scan.ts:1-15`; `src/index.ts:155-165`; `src/guards/index.ts:142-160`; `test/guards/guards.test.ts:211-229` |
| A12 / wspólny limit raw | `OPEN` — dwa strumienie nadal archiwizują niezależnie | `src/adapters/index.ts:249-267`; [historyczny wpis A12](#a12-limit-raw-na-strumień-zamiast-na-wykonanie) |
| A15 / git-diff parser | `OPEN` — exit 0 może nadal oznaczyć nierozpoznany, niepusty output jako `recognized`, a refs są wyprowadzane z argv | `src/adapters/git-diff.ts:3-6,61-74` |
| A17 / błąd odczytu pliku | `OPEN` — każdy wyjątek fileHash nadal daje `MISSING` | `src/adapters/shell.ts:21-24` |

Nie traktuj `OPEN` jako nowego ADR ani jako zgody na zmianę SPEC; pozycje wymagające decyzji pozostają w sekcjach poniżej.

## Rewalidacja po PR #35

Poniższy wpis dotyczy code fixed point `b878e675cf7a9f2d262b7417be02f92f64239500` po scaleniu PR #35. To osobna rewalidacja A12; nie przepisuje historycznej tabeli powyżej ani nie certyfikuje S.6.

| Ustalenie | Dyspozycja na `b878e675cf7a9f2d262b7417be02f92f64239500` | Dowód wykonania i granica |
|---|---|---|
| A12 / wspólny limit raw | `RESOLVED` dla `openLedger` oraz płytkich kopii zachowujących tożsamość funkcji `archive`; stdout+stderr dzielą jeden budżet wykonania | `src/adapters/index.ts:144-186,286-289`; `src/ledger/internal.ts:3-14`; `test/integration/raw-output-limit.test.ts:142-241`; [PR #35](https://github.com/korneliuszburian/tallystick/pull/35) i dwa zielone checki `ledger-acceptance` |

Test 3072+3072 przy capie 4096 wykazuje sumaryczne cięcie, partial capture, rozwiązywalny `SourceHandle` i reap potomka. Owijanie `archive` nową funkcją oraz inne własne implementacje `EventLedger` pozostają poza tym dowodem i wymagają osobnej decyzji kontraktowej.

## Rewalidacja A15 po PR #37 i #38

Poniższy wpis dotyczy code fixed point `6b3bc36d52f79ad33aeafd0b1e0acc734b7a4eee` po scaleniu PR #37 i #38. To rewalidacja ograniczonego parsera `git-diff`; nie zamyka pozostałych ustaleń A15 dotyczących innych parserów ani pełnej semantyki argumentów Git.

| Ustalenie | Dyspozycja na `6b3bc36d52f79ad33aeafd0b1e0acc734b7a4eee` | Dowód wykonania i granica |
|---|---|---|
| A15 / nierozpoznany output przy exit 0 | `RESOLVED` dla niepustego stdout bez rozpoznanych rekordów raw/numstat; taki wynik ma `parser_status=unknown`, bounded fragment i rozwiązywalny `SourceHandle` | `src/adapters/git-diff.ts:69-85`; `test/adapters/adapters.test.ts:240-249`; [PR #37](https://github.com/korneliuszburian/tallystick/pull/37) |
| A15 / refs kontra pathspec | `RESOLVED` dla pathspeców po `--` oraz przypadków z inną niż dokładnie dwiema kandydaturami rewizji; parser zwraca puste refs zamiast zgadywać | `src/adapters/git-diff.ts:3-10`; `test/adapters/adapters.test.ts:390-399`; [PR #38](https://github.com/korneliuszburian/tallystick/pull/38) |

Weryfikacja: `npm run test:acceptance`, `npm run demo`, `npx --no-install tsc --noEmit` i `git diff --check` przechodzą na tym checkoutcie. Ograniczenie refs jest celowo konserwatywne: opcje Git, które przyjmują nieflagowy argument bez jednoznacznego rozdzielenia, mogą dać puste `base`/`head` i wymagają osobnego kontraktu, jeśli mają być publikowane.

## Ustalenia A01–A24

Poniższe obserwacje pochodzą z odczytu przypiętego kodu. Podane testy są propozycjami, nie wynikami reprodukcji. Sformułowanie „ryzyko” nie jest dowodem wystąpienia awarii. Brak pełnego systemu memory lub integracji jest granicą zakresu, nie automatycznie defektem MVP-0.

### A01. Powiązanie atestacji z epoką

**FAKT KODU.** `tested_epoch` i `compiled_epoch` dostają `request.goalId`; middleware nie podmienia ich na epokę pomiaru.

**Kontrakt i patologie:** ADR-001, ADR-011, R.2–R.3; P5/P6/P8.

**Weryfikacja:** Dwa różne goalId w identycznym świecie; następnie zmiana istotnego pliku przy tym samym goalId. Sprawdzić semantyczną tożsamość pól epoki.

**Źródła:** [R-TEST](RESEARCH.md#r-test), [R-COMPILER](RESEARCH.md#r-compiler), [R-MIDDLEWARE](RESEARCH.md#r-middleware).

### A02. Środowisko wykonania szersze niż pomiar

**FAKT KODU / RYZYKO.** Fingerprint middleware obejmuje Node/platform/arch, a spawn dziedziczy process.env. Nie mierzy rzeczywistego resolution i instalacji zależności. Jawne request.environment trafia do action_key, ale odziedziczone wartości nie.

**Kontrakt i patologie:** ADR-001, R.3; P5/P6/P8.

**Weryfikacja:** Zmieniać osobno odziedziczony PATH, istotną zmienną i zainstalowaną zależność bez zmiany lockfile; porównać klucze i wynik.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-ADAPTERS](RESEARCH.md#r-adapters), [R-STATE](RESEARCH.md#r-state), [R-GATE](RESEARCH.md#r-gate).

### A03. Niespójna baza dependencyPaths

**FAKT KODU.** State Twin interpretuje ścieżki względem repositoryRoot; shell mierzy je względem request.cwd.

**Kontrakt i patologie:** ADR-008/011; P5/P6/P8.

**Weryfikacja:** Repo zawiera config i subdir/config o różnych bajtach; cwd=subdir, dependencyPaths=[config]. Sprawdzić, jaki plik autoryzuje Gate i jaki mierzy shell.

**Źródła:** [R-STATE](RESEARCH.md#r-state), [R-SHELL](RESEARCH.md#r-shell).

### A04. Kompletność zbioru zależności

**OTWARTY KONTRAKT INTEGRACYJNY.** Caller dostarcza dependencyPaths; epochFor używa zawartości z touched_file_hashes, bez mode/type. HEAD pozostaje globalną składową. Wewnętrzny symlink wymaga uwzględnienia celu, a plik ignorowany może nie być zmierzony.

**Kontrakt i patologie:** ADR-001/011, R.3/R.4; P5/P6/P8.

**Weryfikacja:** Macierz chmod, symlink target, ignored config, brakujący plik, zewnętrzny probe/TTL i niezwiązany commit. Nie zmieniać ADR-011 bez decyzji.

**Źródła:** [R-STATE](RESEARCH.md#r-state), [R-SPEC](RESEARCH.md#r-spec).

### A05. Atestacje nie wracają do State Twin w middleware

**FAKT KODU.** measure() przekazuje zawsze testAttestations={}. Mechanizm przyjmowania atestacji istnieje w State Twin, ale przepływ middleware go nie wypełnia.

**Kontrakt i patologie:** R.3/R.5; P5/P6.

**Weryfikacja:** Udany i nieudany rozpoznany run dla tej samej epoki: epoka ma zostać stała, rewizja wiedzy i dostępna atestacja mają odpowiadać nowym dowodom.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-STATE](RESEARCH.md#r-state).

### A06. Lease nie obejmuje całego wykonania

**FAKT KODU / RYZYKO.** Lease State Twin chroni pomiar; Promise chain chroni jedną instancję middleware. Gate blokuje równoważny klucz, nie wszystkie równoległe mutacje tego samego worktree.

**Kontrakt i patologie:** R.0, R.4/R.5; P6/P8/P9.

**Weryfikacja:** Dwa procesy middleware, różne akcje, jeden worktree; wymusić zmianę po pomiarze, przed spawn. Obserwować nie tylko duplikaty identycznego requestu.

**Źródła:** [R-STATE](RESEARCH.md#r-state), [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-GATE](RESEARCH.md#r-gate).

### A07. Permit nie jest ponownie wiązany z faktycznym requestem

**FAKT KODU / RYZYKO GRANICY.** Verifier porównuje podpisane pola permit z rezerwacją, nie przelicza requestHash z przekazanego requestu. Nie jest to samodzielny dowód zdalnego exploitu; znaczenie zależy od granicy zaufania i mutowalności danych.

**Kontrakt i patologie:** ADR-016, R.4; P6/P8.

**Weryfikacja:** Kontrolowana podmiana requestu lub współdzielonego environment między zatwierdzeniem a wykonaniem; brak spawn ma być sprawdzany zewnętrznym licznikiem.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-ADAPTERS](RESEARCH.md#r-adapters).

### A08. Restart nie klasyfikuje automatycznie przerwanych wykonań

**FAKT KODU / RYZYKO.** Nie ma startup reconciliation started→UNKNOWN. Rezerwacja started blokuje ten sam klucz, lecz zmiana preconditions tworzy inny klucz; UNKNOWN jest również wyszukiwane po action_key.

**Kontrakt i patologie:** ADR-003, R.5; P8/P9.

**Weryfikacja:** Realnie zabić broker po efekcie, uruchomić ponownie, zmienić istotny plik i spróbować tej samej operacji. Sprawdzić wymaganie reconciliation niezależne od tekstowej deklaracji.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-GATE](RESEARCH.md#r-gate), [R-E2E](RESEARCH.md#r-e2e).

### A09. Okno completed przed utrwaleniem failure

**FAKT KODU / RYZYKO.** Middleware oznacza rezerwację completed przed output measure i recordFailure. Awaria w tej szczelinie może pozostawić raw failure bez aktywnej blokady powtórki.

**Kontrakt i patologie:** ADR-003, R.4/R.5; P8/P9.

**Weryfikacja:** Przerwać proces dokładnie po completed i przed recordFailure; cold restart ma nie dopuszczać automatycznej powtórki nierozliczonego działania.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-GATE](RESEARCH.md#r-gate).

### A10. Niepełna odbudowywalność projekcji

**FAKT KODU / LUKA KONTRAKTU.** Gate tworzy projekcje, lecz nie zawiera ich replay. ALLOW zapisuje proofFailureId, nie identyfikator zużytego proof; część zmian reservation jest wyłącznie UPDATE.

**Kontrakt i patologie:** ADR-013/015, R.4; P8/P9.

**Weryfikacja:** W kopii storage usunąć tylko projekcje i odtworzyć je z events. Porównać decyzje, jednorazowość proof, statusy i fencing tokens.

**Źródła:** [R-GATE](RESEARCH.md#r-gate), [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-SCHEMA](RESEARCH.md#r-schema).

### A11. Receipt: dozwolona obwoluta a trwałość jej składników

**FAKT KODU / OTWARTE DOPRECYZOWANIE.** ADR-016 dopuszcza receipt w pamięci, więc brak osobnego eventu receipt nie jest sam w sobie błędem. Jednak digest_hash, pełny digest i wszystkie powiązania nie są jawnie utrwalone; dokładnego digestu nie da się po prostu odczytać z raw payload.

**Kontrakt i patologie:** ADR-004/010/016, R.5; P4/P6/P9.

**Weryfikacja:** Po cold restart odzyskać dokładny admitted digest, jego hash, powiązanie obu epok i źródła bez wykorzystania pamięci procesu. Ustalić, co kontrakt wymaga zachować dokładnie.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-ADAPTERS](RESEARCH.md#r-adapters), [R-STATUS](RESEARCH.md#r-status).

### A12. Limit raw na strumień zamiast na wykonanie

**FAKT KODU / KONTRPRZYKŁAD STATYCZNY.** stdout i stderr archiwizuje się niezależnie z pełnym limitem każdy. Przy limicie 4096 B dwa strumienie po 3072 B mieszczą się osobno, ale przekraczają sumę wykonania.

**Kontrakt i patologie:** ADR-017, R.0/R.1; P3/P7.

**Weryfikacja:** Fixture stdout=3072, stderr=3072 przy cap=4096. Sprawdzić wspólny budżet, przerwanie w trakcie i completeness.

**Źródła:** [R-ADAPTERS](RESEARCH.md#r-adapters), [R-LEDGER](RESEARCH.md#r-ledger), [R-RAWTEST](RESEARCH.md#r-rawtest).

### A13. Zamykanie procesów i błędy capture

**FAKT KODU / RYZYKO.** Timeout/raw cap wysyłają SIGTERM bez eskalacji i rozliczenia potomków. Odrzucenie Promise podczas capture czyści timer, ale nie zapewnia zakończenia i reap procesu.

**Kontrakt i patologie:** ADR-003/017, R.2/R.5; P8/P9.

**Weryfikacja:** Proces ignorujący SIGTERM, wnuk trzymający stdout oraz awaria zapisu podczas działania. Mierzyć żywe PID, dalsze efekty i status końcowy.

**Źródła:** [R-ADAPTERS](RESEARCH.md#r-adapters).

### A14. Budżet digestu zmienia się w UNKNOWN wykonania

**FAKT KODU / RYZYKO.** Ograniczanie wykonuje jedną redukcję wybranych pól; duże changed_artifacts lub komunikaty mogą nadal przekroczyć limit i rzucić wyjątek po wykonaniu oraz raw commit.

**Kontrakt i patologie:** ADR-004, R.2/R.5; P4/P7/P9.

**Weryfikacja:** Długie pojedyncze diagnostics i liczne changed_artifacts przy limicie domyślnym. Oddzielić znany wynik procesu od nieudanego renderowania digestu.

**Źródła:** [R-ADAPTERS](RESEARCH.md#r-adapters), [R-MIDDLEWARE](RESEARCH.md#r-middleware).

### A15. Parsery rozpoznają zbyt słaby dowód

**FAKT KODU / RYZYKO.** Test parser uznaje raport po samym numTotalTests:number, bez pełnej walidacji. Compiler i git-diff używają exit_code=0 jako przesłanki recognized. git-diff zgaduje refs z nieflagowych argv, także pathspeców.

**Kontrakt i patologie:** R.2/R.3; P6/P7.

**Weryfikacja:** Zły schemat JSON, sprzeczne sumy, nieznany output z exit 0, pathspec po -- i nazwy rename zaczynające się cyfrą/minusem. Nie przypisywać zerowej liczby błędów nierozpoznanemu raportowi.

**Źródła:** [R-TEST](RESEARCH.md#r-test), [R-COMPILER](RESEARCH.md#r-compiler), [R-DIFF](RESEARCH.md#r-diff).

### A16. SourceHandle i semantyka bajtów

**FAKT KODU / RYZYKO.** Git-diff publikuje stdout jako stream=file, a wspólny unknown fallback może wskazać stream=stdout. Shell wylicza długość zakresu po usunięciu ANSI; dekodowanie invalid UTF-8 wymaga osobnych kontroli offsetów.

**Kontrakt i patologie:** ADR-009, R.2; P4/P6/P7.

**Weryfikacja:** Nierozpoznany git-diff bez stderr: readFragment każdego zwróconego uchwytu. Osobno ANSI, multibyte i invalid UTF-8; porównać z dokładnymi bajtami źródła.

**Źródła:** [R-ADAPTERS](RESEARCH.md#r-adapters), [R-SHELL](RESEARCH.md#r-shell), [R-DIFF](RESEARCH.md#r-diff), [R-LEDGER](RESEARCH.md#r-ledger).

### A17. Brak pomiaru mylony z nieistnieniem pliku

**FAKT KODU.** Shell fileHash przechwytuje każdy błąd odczytu i zwraca MISSING, także dla braku uprawnień lub błędu I/O.

**Kontrakt i patologie:** ADR-008, R.3; P6.

**Weryfikacja:** Rozdzielić ENOENT, EACCES i EIO. Tylko rzeczywisty brak może dać MISSING; inne przypadki nie mogą udawać aktualnego pomiaru.

**Źródła:** [R-SHELL](RESEARCH.md#r-shell).

### A18. Limit 100000 zdarzeń w decyzjach poprawnościowych

**FAKT KODU / RYZYKO.** guardDecisionId, hasUnknownExecution i proofRetryAlreadyUsed skanują pierwszy fragment historii bez paginacji, mimo że Ledger oferuje afterSeq.

**Kontrakt i patologie:** ADR-003, R.4/R.5; P8/P9.

**Weryfikacja:** W disposable storage przekroczyć próg osobno dla guard_decision i execution_unknown; dopiero potem umieścić relewantny event i sprawdzić identyczność decyzji.

**Źródła:** [R-GATE](RESEARCH.md#r-gate), [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-LEDGER](RESEARCH.md#r-ledger).

### A19. Integralność i trwałość: niewystarczający dowód round-trip

**FAKT KODU / HIPOTEZA DO AUDYTU.** Hash eventu obejmuje complete per BlobRef, schema utrwala aggregate capture_status i referencje bez per-ref complete. CAS fsyncuje plik, po rename nie widać fsync katalogu. Nie wykonano testu utraty zasilania ani niezależnej rekonstrukcji hash chain.

**Kontrakt i patologie:** ADR-004/007, R.1; P4/P9.

**Weryfikacja:** Reopen i niezależna rekonstrukcja hashów dla różnych kompletności i kolejności streamów; fault injection publikacji CAS/SQLite oraz spójny backup/restore. Nie utożsamiać readBlob integrity z integralnością całego łańcucha.

**Źródła:** [R-LEDGER](RESEARCH.md#r-ledger), [R-SCHEMA](RESEARCH.md#r-schema).

### A20. Knowledge sandbox nie jest jeszcze granicą admission

**FAKT ZAKRESU / RYZYKO PRZYSZŁEJ INTEGRACJI.** revalidateMemory zwraca zgodność predicates, nie prawdziwość claim ani decyzję o quarantine/utility. Puste predicates mogą dać active; scope i źródła wymagają osobnej polityki admission.

**Kontrakt i patologie:** R.0/R.3; P5/P6/P10.

**Weryfikacja:** Fałszywy claim przy prawdziwych predicates, puste predicates, obcy worktree, quarantined memory. Wyraźnie oddzielić oczekiwany wynik revalidation od prawa do publikacji.

**Źródła:** [R-STATE](RESEARCH.md#r-state), [R-SPEC](RESEARCH.md#r-spec).

### A21. Storage i klucz wymagają faktycznej izolacji hosta

**FAKT KODU / WARUNEK INTEGRACJI.** Klucz ma 0600, ale sam tryb pliku nie jest dowodem niedostępności dla procesu modelu działającego z tym samym UID. Options nie wymuszają storage poza worktree; audit dokumentuje taki układ.

**Kontrakt i patologie:** ADR-002/014/016, R.1; P6/P9.

**Weryfikacja:** Na realnym hoście zbadać uprawnienia odczytu klucza, mutacji DB/CAS oraz native write. Logi/DB nie mogą wejść do własnego manifestu wejściowego.

**Źródła:** [R-MIDDLEWARE](RESEARCH.md#r-middleware), [R-DESKTOP](RESEARCH.md#r-desktop), [R-LEDGER](RESEARCH.md#r-ledger).

### A22. Testy stanów nie dowodzą rzeczywistego crash recovery

**FAKT TESTÓW.** Test broker crash ręcznie tworzy UNKNOWN bez zabicia brokera. Disk-full style używa chmod, nie rzeczywistego ENOSPC. Test missing blob dotyczy odczytu po uprzednim admission. Prawdziwe testy child death i raw overflow istnieją, ale nie pokrywają tych luk.

**Kontrakt i patologie:** S.3/S.6, ADR-003/004; P6/P9.

**Weryfikacja:** Osobny nadzorca zabija proces w kolejnych fazach, mierzy efekty i odbudowę. Porównać każde wymaganie S.3 z realnym mechanizmem testu.

**Źródła:** [R-E2E](RESEARCH.md#r-e2e), [R-RAWTEST](RESEARCH.md#r-rawtest).

### A23. CI i dokumentacja nadal mają elementy przejściowe

**FAKT / NIEJEDNOZNACZNOŚĆ.** CI pomija suity, jeśli katalogi nie istnieją. R.3 odracza state_observations do integracji, a dalszy tekst mówi o etapie State Twin; tabela nie istnieje. AGENTS powiela część SPEC; PR23 jest tylko draftem, nie stanem main.

**Kontrakt i patologie:** ADR-006, R.3, S.1; P1/P2/P5/P6.

**Weryfikacja:** Test usunięcia katalogu testów w disposable branch oraz audyt aktywnych/supersedowanych reguł. Nie zmieniać normatywnego SPEC na podstawie samej rekomendacji.

**Źródła:** [R-CI](RESEARCH.md#r-ci), [R-SPEC](RESEARCH.md#r-spec), [R-SCHEMA](RESEARCH.md#r-schema), [R-AGENTS](RESEARCH.md#r-agents).

### A24. Koszt i tożsamość przyszłej integracji nie są zmierzone

**FAKT KODU / LUKA POMIAROWA.** Pomiar przed i po wykonaniu robi po dwa pełne snapshoty repo; adapter po capture wczytuje całe bloby. Stałe project/session IDs w części middleware oraz pamięciowe liczniki nie tworzą kompletnej telemetrycznej tożsamości wielu agentów. API intercept nie przyjmuje proof, choć Gate go obsługuje.

**Kontrakt i patologie:** R.0/R.3/R.5; P3/P5/P8/P10.

**Weryfikacja:** Benchmark skali plików/outputu/historii oraz koszt na poprawnie zakończone zadanie; test multi-session provenance i realnej ścieżki autoryzowanego recovery ticketu.

**Źródła:** [R-STATE](RESEARCH.md#r-state), [R-ADAPTERS](RESEARCH.md#r-adapters), [R-MIDDLEWARE](RESEARCH.md#r-middleware).

## Mapa F01–F15

Źródło: „Tallystick — rejestr ustaleń audytu”, przekazany przez właściciela, data 2026-09-09, ten sam SHA. Poniższe priorytety zachowują jego klasyfikację; nie przeprowadzono nowych reprodukcji w zadaniu dokumentacyjnym. Relacja oznacza pokrycie tematyczne, nie pełną tożsamość ustaleń.

| ID / priorytet źródłowy | Ustalenie i powiązane A | Próba rozstrzygająca / granica |
|---|---|---|
| F01 · krytyczny | Historyczny brak dowodu broker coverage i admission, świadomie poza MVP-0; [A21/A24](#a21-storage-i-klucz-wymagają-faktycznej-izolacji-hosta). | Macierz ścieżek, marker efektu, wejście modelu i odmowa enforce. Późniejsze raporty poniżej częściowo uzupełniają tę lukę, nie zamykają całego S.6. |
| F02 · wysoki | Limit osobny dla stdout i stderr; [A12](#a12-limit-raw-na-strumień-zamiast-na-wykonanie). | Każdy strumień 0.75L, razem 1.5L: brak kompletnego wyniku poniżej limitu wykonania. |
| F03 · wysoki | Fingerprint node/platform/arch przy dziedziczeniu process.env; caller wybiera zależności; [A02–A04](#a02-środowisko-wykonania-szersze-niż-pomiar). | Zmień PATH, realną instalację zależności, ignorowany plik wejściowy; sprawdź tożsamość bez ujawniania sekretów. |
| F04 · wysoki | Ręczny UNKNOWN nie dowodzi crash recovery; [A08/A22](#a08-restart-nie-klasyfikuje-automatycznie-przerwanych-wykonań). | Zewnętrzny SIGKILL po realnym spawn, restart publiczną ścieżką, brak powtórzonego efektu i reconciliation. |
| F05 · wysoki | Okno completed przed pomiarem i failure; [A09](#a09-okno-completed-przed-utrwaleniem-failure). | Crash/wyjątek w tej szczelinie, reopen i równoważny request. |
| F06 · wysoki | Lease pomiaru i serializacja jednej instancji nie rozliczają całej granicy; [A06](#a06-lease-nie-obejmuje-całego-wykonania). | Mutacja przez drugi proces między pomiarem a spawn, drugi writer i zgodność faktycznych preconditions. |
| F07 · wysoki | Parser git diff: exit 0 i brak rozpoznanych summaries; [A15](#a15-parsery-rozpoznają-zbyt-słaby-dowód). | Rzeczywisty niepusty standardowy patch nie może dać rozpoznanego braku zmian; zły format musi zachować niepewność. |
| F08 · średni | Git diff stream=file, fallback stream=stdout; [A16](#a16-sourcehandle-i-semantyka-bajtów). | Niepusty nierozpoznany stdout, pusty stderr; każdy handle przechodzi readFragment. |
| F09 · wysoki przy długiej historii | Skan pierwszych 100000 zdarzeń, nie najnowszych; [A18](#a18-limit-100000-zdarzeń-w-decyzjach-poprawnościowych). | Przekrocz próg, dodaj nowe guard decision/UNKNOWN/proof; bieżąca blokada nie może zniknąć. |
| F10 · wysoki | SIGTERM childa nie dowodzi zakończenia całego wykonania; [A13](#a13-zamykanie-procesów-i-błędy-capture). | Ignorowanie SIGTERM oraz wnuk trzymający pipe; zakończenie i odzyskiwalny partial bez kooperacji. |
| F11 · wysoki przed enforce | Wiązanie permit/request i izolacja klucza; [A07/A21](#a07-permit-nie-jest-ponownie-wiązany-z-faktycznym-requestem). | Podmiana requestu bez procesu; narzędzia modelu nie czytają klucza ani nie mutują storage. |
| F12 · średni | Cztery przejścia snapshotów i dodatkowe pomiary; [A24](#a24-koszt-i-tożsamość-przyszłej-integracji-nie-są-zmierzone). | p50/p95, bytes read, event growth, peak memory dla małych i dużych repo; bez osłabienia freshness. |
| F13 · średni | Power-loss, restore, retencja, replay i sekrety; [A10/A19/A21](#a19-integralność-i-trwałość-niewystarczający-dowód-round-trip). | Osobno crash procesu i zanik zasilania; brak blobu przy restore nie daje pozytywnego admission; sprawdź zobowiązanie SPEC. |
| F14 · wysoki procesowo | Historyczny odczyt warunkowych suit, protected=false i pustych rulesets; [A23](#a23-ci-i-dokumentacja-nadal-mają-elementy-przejściowe). | Usunięcie wymaganej suite nie może dać PASS. Źródło odczytu: job `102157647534`, branches/main, rulesets?includes_parents=true; nie jest to dzisiejsza kontrola ustawień ani zgoda na zmianę CI. |
| F15 · średni | Testy poprawności nie mierzą wartości produktu; [DR-08](RESEARCH.md#dr-08-eksperyment-compounding-memory-on-kontra-memory-off). | Native vs native+Tallystick; osobno paired memory-on/off, trajektoria przewagi, false blocks i correctness. |

## Raporty operatora — oddzielna klasa dowodu

Źródło: raporty przekazane w rozmowie przez właściciela. Poniżej identyfikatory i skróty wyników, **nie niezależny odczyt prywatnych logów**. Bieżący raport hosta znajduje się w [P0-HOST-REPORT.md](orchestrator/P0-HOST-REPORT.md); jest raportem operatora, nie dowodem S.6. Nie publikujemy lokalnych ścieżek użytkownika, raw trace, kluczy ani konfiguracji. SHA-256 identyfikuje raport właściciela i pozwala sprawdzić dostarczony później oryginał; sam hash nie potwierdza prawdziwości pomiaru. Powiązanie z publicznymi dowodami powinno trafić do [issue #22](https://github.com/korneliuszburian/tallystick/issues/22), które pozostaje otwarte.

Wszystkie poniższe raporty wskazują bazowy SHA tego rejestru i Codex 0.149.1; profile zmieniały się między próbami. Nie łączymy ich wyników w globalny PASS. Datę raportów zachowano z oznaczeń operatora: 2026-09-09.

| Raport | Wynik zadeklarowany przez operatora | SHA-256 raportu |
|---|---|---|
| `baseline-fail` · 2026-09-09T11:03:32Z | npm 12 zablokował install script better-sqlite3; brak bindingu, acceptance FAIL; wynik zachowany. | Niepodany w raporcie rozmowy. |
| `baseline-pass` · 2026-09-09T11:23:05Z | Node 26.2.0/npm 12.0.1, jawna zgoda tylko dla better-sqlite3 12.11.1; SQLite 3.53.2, typecheck, 93 testy i 3 scenariusze demo PASS. | Niepodany w raporcie rozmowy. |
| `app-server-negative-trial-20260909.moJMja` | BLOCKED: code-mode host is disabled, brak item/tool/call; nie zmieniono wyniku po późniejszych próbach. | Niepodany w raporcie rozmowy. |
| `app-server-missing-call-diagnosis-20260909.LonxTx` | Diagnoza źródłowo-behawioralna; gpt-5.6-terra, historyczne tool_mode UNKNOWN. | `011a8d14c0c79ba57b382b395e0ee263c02c0058557d6b6925356e8bc326eca5` |
| `app-server-direct-trial-20260909.BlZY2f` | PASS ujemnego round-trip dynamic tool z gpt-5.5; registry/admission wtedy częściowe. | `9e76355bef5afce5ddcc6c9cd4cf937ad624a0247680d69e20f0112d0a538e29` |
| `app-server-ledger-trial-20260909.GucpHo` | Jedno wykonanie przez middleware; raw 102400 B, receipt; digest 635 B, RPC 770 B; admission wtedy częściowe. | `846893c4891dddf8659f49123b1580bac0e8d6a0b2bf27f435f44d16f9a0a7d7` |
| `app-server-gate-trial-20260909.BswW8i` | Trzy intercept(), jeden proces; EXECUTED/exit 7, BLOCK, BLOCK tej samej porażki. | `bed89c0d2703d95ea64c642352f661f5480e79e4bc5e9d6eaa94724366a0f595` |
| `app-server-admission-trace-20260909.osDauV` | Digest 635 B bez zmian w requestcie; brak pełnego raw w dwóch requestach; wykryto skills.list/read. | `3da83f1a8dd65ea1479074ba521a7d470ac17e1a50c7e63d5f78ed4718fd647a` |
| `app-server-skills-disabled-trial-20260909.mrkpvY` | Wyłączenie skills orchestratora usunęło oba tools; wykonanie i admission bez regresji. | `f056bf2111bf82741159fa4274d39ceb831d2b75d2d54cf709482eb3c4525b80` |
| `app-server-registry-audit-20260909.aotfX7` | Analiza bez nowego turnu; jedyna nierozstrzygnięta rodzina: Hidden MCP; brak dowodu rzeczywistego bypassu. | `ec5d6e2855e59ef551600ea916e20e539108556f8b54b4e58fdc6ee6ea92fc9f` |
| `app-server-mcp-zero-qualification-20260909.5eO1pH` | Brak handlerów MCP domknięty źródłowo-konfiguracyjnie dla nowej instancji; zero inference. | `b27ea5925a6cd26b798ba639b6e2b622ee00b156b00c549b41a6502542d667b3` |
| `app-server-startup-gate-20260909.oTGqHY` | Lokalne warunki: 12/12 testów; dodatnia regresja; warstwy zarządzane niezakwalifikowane w tym runie. | `43a48a9d585e8d2afb4ecaebdcd56040b74888f8d9b7c1364dffb16b0ea93ff7` |
| `app-server-managed-layers-gate-20260909.EaPmHZ` | 20/20 kontrolera; jeden App Server, zero threadów i inference; dwa zgodne odczyty nie zamykają TOCTOU. | `758f16b87fbd0f8407d15b6b68cd2c12553aecae735081af86b84a5535feb510` |
| `app-server-config-activation-decision-20260909.K9hSZV` | Aneks proponuje walidację materializowanego Config przy aktywacji/refreshu i jawny opt-in; implementacja niewykonana w raporcie. | `8e76d4f65fc95181f8e8c6154eb1034a5b5e63b689616128ebf05bbe4fdaa2c3` |

Dodatkowe zachowane identyfikatory pomiarów operatora: raw 102400 B `x` — `8b77ec70310a4f694fff9ad0bf5f1e9da39b97ec5ccb3ced6a6261ac4effee4c`; digest admission — `640ccc5766225e0c0620da81693e4049dd42cb8f4d2552e8c604418e179d91f5`; FailureRecord — `1a56a233-dc9f-4749-b240-eb8cc5904185`. Nie są dowodem bieżącego checkoutu ani uniwersalną gwarancją.

## Otwarte rozstrzygnięcie integracyjne

Ostatni aneks operatora wskazuje TOCTOU między odczytem konfiguracji a jej aktywacją przez hosta. W rozmowie właściciel dopuścił przygotowanie eksperymentalnego patcha poza Tallystick; **zatwierdzenie kierunku nie jest wykonanym patchem ani zmianą ADR**. Baza badanego hosta: `openai/codex@ff29a44391deccde0aba0f8390337d7f3c319ea4`. Zmiana hosta wymaga własnego commitu, testów i ponownej walidacji profilu.

**Całe S.6: niezaliczone.** Kryteria zamknięcia są w [audycie integracji](DESKTOP-INTEGRATION-AUDIT.md). Crash/resume, deduplikacja transportowa, brak evidence przed admission i zakończenie przy raw overflow zachowują osobne statusy; udany scenariusz Gate ich nie zalicza.
