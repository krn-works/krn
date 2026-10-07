# G1 — review architektury: szkielet `krn` + plan E1 (Opus, read-only, 2026-10-07)

**Werdykt: GO-WITH-CHANGES.** Szkielet jest mały i w większości zgodny z blueprintem. Plan E1 w obecnej kolejności
prowadzi jednak prosto do tripwire'u „kolejna linia bez realnego użycia”. Do tego dwa mechanizmy, które szkielet
deklaruje jako egzekwowane (dryf AGENTS.md, granica `core`), są dziurawe. Sprawdziłem to empirycznie.

Metoda: przeczytałem w całości blueprint v4, charter, plan E1 i każdy plik w `~/coding/krn/active/krn`. Gate
uruchomiłem na kopii w scratchpadzie (`mise exec node@24.21.0 -- npm run gate`: 5/5 testów zielonych, exit 0) i tam
też robiłem sondy falsyfikacyjne. Na miejscu sprawdziłem źródła kamieniołomu: wszystkie cytowane pliki istnieją,
a PR #357 ma 4 commity i +481 linii (`run-cli.mjs` 257, `run.test.mjs` 191).

## 1. Zgodność szkieletu z §3/§7/§9/§10 i charterem

Zgodne:
- Zestaw modułów jest taki jak w charterze [CODE src/*/index.ts].
- Jeden pakiet [CODE package.json:2].
- Flagi tsconfig z §7 [CODE tsconfig.json:6-10].
- Node 24.21.0, TS 7 tylko jako typechecker, Biome i `node:test`.
- Zero zależności runtime (K10).
- `Job {id,issue,worktree,epoch}` bez statusu [CODE src/core/index.ts:2-7].
- Forwarder ma guard rekursji z kodem 70 [CODE src/cli/main.ts:25-32]. Self-target przez symlink też jest
  blokowany, w drugim przeskoku przez `KRN_FORWARDED` [OURS-EVIDENCE sonda: exit 70].

Rozbieżności i dziury:
- **Test dryfu jest tautologią i zmienia plik w repo.** `test/agents-render.test.ts:4` importuje
  `scripts/render-agents.ts`. Moduł ma efekt uboczny na top-levelu: bez `--check` zapisuje AGENTS.md
  [CODE scripts/render-agents.ts:42-44]. Sonda: dopisałem regułę-śmieć do AGENTS.md, a test przeszedł i nadpisał plik
  (md5 się zmienił). Cały `npm run gate` po dryfie też kończy się exit 0, bo `npm test` „naprawia” plik przed
  `rules --check` [OURS-EVIDENCE]. Zabezpieczenie przed dryfem, deklarowane w §10.6, nie działa.
- **Test granicy `core` daje fałszywe negatywy.** Sonda: `import '../hosts/index.ts'` (import bez `from`) oraz
  `await import('../ledger/index.ts')` w `src/core/leak.ts` dają zielony wynik [OURS-EVIDENCE]. Regex wymaga
  `from` [CODE test/import-boundary.test.ts:14], a `readdir` nie schodzi do podkatalogów [CODE :7].
- **Spec v0 jest użyty pozornie.** Format rekordu i wzorzec `When …, ROLE MUST …` się zgadzają. Ale:
  - KRN-01–03 kopiują reguły globalnego kontraktu (config/AGENTS.md:55, przepisane w §10.8 #2). §10.6 każe trzymać
    w rejestrze wyłącznie reguły repozytorium. Generator stworzył więc drugie źródło tych samych reguł, czyli dokładnie
    to, co miał usunąć [CODE spec/rules.json:4-26; POLICY §10.6].
  - 3 z 6 egzekucji wskazują sprawdzenia, które w tym repo nie istnieją: `gate: readback`,
    `gate: changes check --before`, `gate: brief review`. Skrypty gate mają tylko check/lint/test/rules
    [CODE package.json:13-19]. „brief review” to przegląd modelem, nie gate.
  - Brakuje `CONTEXT.md` ze słownikiem, którego wymaga §10.4.
  - AGENTS.md nie mówi workerom Luna niczego, czego potrzebują w E1: komendy gate, układu katalogów, K3/K7/K8/K10
    [CODE AGENTS.md:1-9].
- **Forwarder odbiega od §3.3.** Zmienna nazywa się `KRN_LEGACY_BIN` bez domyślnej wartości, a blueprint przewiduje
  `KRN_LEGACY_ENTRY` z domyślną ścieżką. `--version` nie pokazuje obu wersji [CODE src/cli/main.ts:7-16; POLICY §3.3].
  `realpath` nie jest używany.
- **K3 („bez index.ts”) jest złamane** we wszystkich 9 modułach. `cli/index.ts` (`dispatch`) nie jest nigdzie
  podpięty. `NotImplemented` w `core` to kod spekulatywny [CODE src/cli/index.ts:4-6; src/core/index.ts:11-16].
- **ADR 0001 wskazuje na ignorowany katalog roboczy.** Odsyła do blueprintu w `krn-codex-skills/.krn/runs/…`, który
  jest objęty `.gitignore` (`.krn/runs/.gitignore:2`) [CODE docs/adr/0001-product-krn.md:13-14; OURS-EVIDENCE
  check-ignore]. Wiążąca decyzja produktu nie ma trwałego źródła, a świeża sesja w `krn` jej nie znajdzie.
- **Brakuje** `docs/architecture.md` z diagramem Mermaid (§8), remote'u Git i CI (`git remote -v` jest pusty).
  Bez tego „PR-sized, independently mergeable” nie ma powierzchni merge'a.
- **Dodatkowe ryzyko:** bin `.ts` uruchamiany z `node_modules` nie przejdzie type-strippingu Node
  [HYPOTHESIS; dotyczy ścieżki instalacji w E1-09].

## 2. Czy `Job` to właściwy prymityw

Kierunek jest dobry: jeden mały identyfikator, który przechodzi przez wszystkie porty. Kształt przemyca jednak drugą
władzę, choć nie statusu, tylko **fencingu**:

- `epoch` to licznik CAS, a jego źródłem prawdy jest kapsuła („CAS na job.id+epoch”, §4.1). Szkic J1 w samym
  blueprincie używa `capsule.epoch`, nie `job.epoch` [CODE blueprint-v4.md:262,269]. W `Job` ta wartość jest
  zbędną kopią, która rozjedzie się przy pierwszym resecie. Poprawka: `Job = {id, issue, worktree}` jako
  niezmienna tożsamość. Epoka żyje wyłącznie w kapsule lub dzierżawie zwracanej przez `relay.load` i jest
  przedstawiana jako token przy zapisie.
- K1 jest wewnętrznie sprzeczne: „Status nie należy do Job; `Job.state` jest tylko projekcją” [CODE
  blueprint-v4.md:216]. Poprawka: `Job` nigdy nie ma `state`. `ledger.readContract` zwraca osobny
  `BoardView {status, revision, observedAt, stale}`, który nie jest nigdzie zapisywany.
- Brakuje reguły tożsamości. Jeśli `id` jest losowe, dwa wywołania `krn start LON-1` dają duplikat pracy, czyli
  falsyfikator `foreman` z §3.2. Unikalność per issue powinien gwarantować przydział lub checkout w Paperclip, nie
  lokalne `id` [HYPOTHESIS].

## 3. Plan E1

- **Żywe J1 jest na samym końcu.** E1-10 zależy od E1-01..09, a poza tym od czterech zewnętrznych bramek pilota
  Paperclip, grantu instalacji i kwalifikacji SQLite [CODE E1-plan.md:5,96]. Przy merge commitach (polityka repo)
  to co najmniej 1+9×2 commitów przed pierwszym realnym wznowieniem. Tripwire „przed 15. commitem” odpali więc
  z konstrukcji albo zostanie obejściem przez squash [OURS-EVIDENCE: `krn` ma dziś 1 commit].
- **Pionowość jest pozorna.** Kroki E1-03..06 to warstwy (adaptery), nie przekroje. Każdy wymyśla własny interfejs,
  a pierwsza kompozycja z prawdziwym `verdict` następuje dopiero w E1-10, bo E1-07 jest „isolated from E1-08 until
  integration” [CODE E1-plan.md:69,78]. Nie ma osobnego kroku integracji.
- **Przebrane ceremonie (goal-0039: „eval modules that prove schemas but not product lift”**, krn-gastown
  goal-0039.md):
  - E1-01: test schematu pliku baseline'u;
  - E1-02: test „brak pola status”;
  - E1-05: kwalifikacja SQLite przed pierwszym użyciem;
  - E1-08: cztery soczewki sędziowskie dla wrappera J1.
- **Falsyfikatory:**
  - E1-09 jest **już zielony** w szkielecie [CODE test/cli.test.ts:46-53], więc nie może być pokazany jako czerwony
    na bazie.
  - E1-02..08 są czerwone na bazie tylko dlatego, że moduł nie istnieje. Plan musi wymagać, żeby test padał na
    asercji, a nie na imporcie.
  - E1-06 i E1-10 to testy na żywo wrzucone do `node --test`, czyli do `npm run gate`. Każdy gate kosztowałby tokeny
    Luny, a E1-10 **przy każdym uruchomieniu przesuwałby realne issue Paperclip do `in_review`** [CODE
    E1-plan.md:59,95; package.json:16]. To mutacja władzy schowana w teście.
- **Izolacja plików.** Moduły są rozdzielone, ale wspólne są `package.json` i lockfile (Zod w E1-02) oraz kontrakty
  między `relay`, `hosts` i `foreman`. Izolacja istnieje na poziomie plików, nie decyzji.
- **Baseline jest źle umieszczony i źle dobrany.**
  - Blokuje całą implementację [CODE E1-plan.md:15], choć kod nie dotyka celów. Wystarczy, że poprzedza pierwszy
    przebieg ramienia B.
  - Zadania baseline'u („6 tanich napraw instrukcji”, §12 E0) to zadania jednosesyjne, których nikt nie przerywa.
    Porównanie mediany minut −30% z J1, którego teza dotyczy wznowienia po przerwaniu, jest wtedy porównaniem
    różnych klas zadań. Kryterium zabicia staje się nieinterpretowalne [HYPOTHESIS].
- **Środowisko sesji workera jest pominięte.**
  - Globalny hook SessionStart w `~/.codex/hooks.json` uruchamia `krn_capsule.py` w każdej sesji Codex, także tej
    startowanej przez foremana. Hook wstrzykuje legacy kapsułę `.krn/runs/delivery-loop` i frontier
    `krn task next` [CODE ~/.codex/hooks.json; scripts/hooks/krn_capsule.py:155,214]. Worker dostanie dwa źródła
    „następnej akcji”: tę kapsułę i projekcję `relay`.
  - Do tego `krn checkpoint` wywołany z sesji trafi do starego binu. Zamiana binu jest poza zakresem E1-09, więc
    E1-10 ma ukrytą zależność od instalacji [CODE E1-plan.md:84].

## BLOCKING

1. **Żywe wznowienie przenieść na krok 5** (kolejność poniżej). Pierwszy żywy przebieg nie zapisuje nic do boardu
   i nie wymaga verdictu: realne issue, przerwanie po checkpoincie, świeża sesja Luna, `n=1` z etykietą pilota.
   E1-10 z `in_review` zostaje jako drugi przebieg na żywo.
2. **Testy na żywo wyjąć z gate'u.** Nowy skrypt `npm run live` (opt-in `KRN_LIVE=1`) nie wchodzi w `gate`. E1-10
   to przebieg dowodowy plus *read-only* readback (`evals/journeys/*.json`), nie plik `*.test.ts`.
3. **Naprawić test dryfu.** Zapis w `render-agents.ts` ma wykonywać się tylko jako entrypoint
   (`import.meta.main`). Test porównuje bez zapisu. Czerwień pokazać przez dopisanie linii do AGENTS.md.
4. **Jeden kanał ciągłości w sesji workera.** Najmniejsza poprawka: `relay` zapisuje kapsułę w istniejącym ABI
   (`capsule-abi.mjs`, ścieżka czytana przez hook). Daje to jeden kanał, a hook jest już sprawdzony, zgodnie z
   „zachowaj ABI” z §3.2. Foreman przekazuje workerowi absolutną ścieżkę nowego CLI dla `checkpoint`, bez
   globalnej instalacji.
5. **Usunąć `epoch` z `Job`, a status zostawić tylko w `BoardView` ledgera.** Falsyfikator E1-02 zmienić na:
   zniekształcony payload Paperclip daje `Result.error`, a nie wyjątek. Poprawić brzmienie K1.
6. **Przebudować rejestr reguł.**
   - Usunąć KRN-01..04 (należą do globalnego właściciela).
   - Dodać reguły repozytorium: `npm run gate` MUST pass, K3, K7, K10, testy na żywo tylko opt-in.
   - W `--check` sprawdzać, że każde `test:` odpowiada istniejącemu tytułowi testu, a każde `gate:` skryptowi.
     W przeciwnym razie egzekucja to `none` z terminem migracji.
7. **E1-09 dostaje nowy czerwony falsyfikator.** Na przykład `KRN_LEGACY_ENTRY` z domyślną wartością i `realpath`
   po obu stronach. Do tego test, że potomek legacy wywołujący `krn` z PATH nie dostaje fałszywego 70: dziś
   `KRN_FORWARDED=1` dziedziczą wszyscy potomkowie [CODE src/cli/main.ts:35; HYPOTHESIS].
8. **Baseline: 3 zadania tej samej klasy co J1** (wielosesyjne, przerywalne). Bramkują pierwszy przebieg ramienia B,
   a nie implementację.

## NON-BLOCKING

- Kopię blueprintu (lub §3, §9, §10) przenieść do `krn/docs/` i przepiąć ADR 0001. Zrobić przed E1-02.
- Test granicy: `core` nie importuje niczego spoza `src/core`; obsłużyć importy bez `from` i dynamiczne oraz
  rekursję po podkatalogach.
- Zmienić nazwy `index.ts` na pliki konkretne (K3). Usunąć `cli/index.ts` i `NotImplemented`.
- `trace` dla J1 jako append-only JSONL z fsync. SQLite dopiero, gdy JSONL okaże się niewystarczający; to zdejmuje
  kwalifikację RC przed żywym przebiegiem [HYPOTHESIS; odstępstwo od POLICY §7 do decyzji leada].
- `verdict` w J1: deterministyczny gate plus jedna soczewka Spec. Pozostałe soczewki po E1.
- Tożsamość zadania: unikalność per issue przez checkout lub przydział w Paperclip.
- Bramka read-only zamiast zapisu: w L1 ledger tylko czyta (GET) albo używa ręcznego kontraktu (K6).
- Utworzenie worktree nie ma właściciela w żadnym kroku. Przypisać je do `krn start` (S4).
- Remote, CI, `CONTEXT.md` i `docs/architecture.md` dodać przed pierwszym merge'em PR.
- Wartość `--version` dla obu wydań; kod wyjścia 128+n przy sygnale.
- Sprawdzić, czy `codex exec --json` raportuje tokeny [HYPOTHESIS §4.2]. Odpowiedź daje S2, nie E1-05.

## Poprawiona kolejność E1

| # | Krok | Falsyfikator (czerwony na asercji) |
|---|---|---|
| B0 | Baseline 3 zadań klasy J1, równolegle z S1–S4, przed L1 | brak testu; JSON z `n` i etykietą, readback leada |
| S1 | `core`: `Job{id,issue,worktree}`, `Result`, Zod dla payloadu Paperclip; typ `Deps` w `foreman/run.ts`; naprawy B3/B6 | zniekształcony payload daje `Result.error` |
| S2 | `hosts/codex` start/wait/cancel, parsowanie tokenów | jednostkowo: anulowanie zabija drzewo procesów (fake proces); na żywo w `npm run live` |
| S3 | `relay`: kapsuła w ABI legacy, CAS epoki, `krn checkpoint` | zapis ze starej epoki odrzucony |
| S4 | `foreman.runJob` ≤40 linii, `trace` JSONL, `krn start` z worktree; po „done” stop i `human_decision` | kill po checkpoincie: nowa sesja ma nowe ID i wykonuje akcję raz |
| **L1** | **Żywe przerwane wznowienie realnego zadania (bez zapisu do boardu)** | przebieg dowodowy `n=1`; ok. commit 6–10 |
| S5 | `ledger` board-only submit | mutacja bez credentiali lub spoza allowlisty odrzucona |
| S6 | `verdict` na dokładnym SHA | submit po zmianie HEAD odrzucony |
| S7 | raport minut i tokenów z `trace` | brak zdarzenia po ponownym otwarciu wykryty |
| S8 | utwardzenie forwardera (B7) | `realpath` i potomek legacy |
| L2 | Żywe J1 z `in_review` (po bramkach pilota) | przebieg dowodowy i readback |

## 4. Największe ryzyko piątej zatrzymanej linii

Ryzykiem jest to, że produkt zostanie zbudowany, zanim ktokolwiek go użyje. Pierwszy realny dowód tezy (świeża sesja
wznawia bez rekonstrukcji przez operatora) zależy dziś od 9 zmergowanych warstw, 4 bramek Paperclip, grantu
instalacji i kwalifikacji SQLite. Każda z tych zależności może utknąć niezależnie od pozostałych. Szkielet już
pokazuje ten wzorzec: najbardziej dopracowane są szwy, czyli forwarder i generator, a rdzeń wartości (wznowienie)
ma zero kodu.

**Jedna zmiana, która najbardziej obniża to ryzyko:** L1, czyli żywe przerwane wznowienie bez zapisu do boardu, ma
być kryterium akceptacji kroku 5 i bramką G2. Wszystko inne dobudowujemy do pętli, która już działa na realnym
zadaniu.
