# Tallystick — kryteria audytu integracji

[Start](../README.md) · [Kontrakty](../SPEC.md) · [Reguły pracy](../AGENTS.md)

> **Rola:** kryteria testu i wymagane evidence · **Status:** S.6 — DO OCENY DLA KONKRETNEGO PROFILU
> **Właściciel:** operator audytu hosta · **Konsument:** wykonawca S.6 i właściciel issue #22
> **Zakres:** jeden SHA, wersja hosta, transport i zestaw dozwolonych ścieżek
> **Źródła:** [SPEC S.6](../SPEC.md#s6-dodatkowa-bramka-wdrożenia--poza-mvp-0); wyniki w [rejestrze](AUDIT-REGISTER.md)
> **Kiedy ten dokument traci aktualność:** zmiana SHA, wersji/config hosta, transportu, narzędzi lub admission wymaga ponownej walidacji dotkniętych granic.

## Cel i status

**FACT — kontrakt:** [SPEC.md S.6](../SPEC.md) wymaga sprawdzenia rzeczywistego hosta po testach biblioteki; ADR-002, ADR-003, ADR-004, R.0, R.2, R.4 i R.5 określają granice wykonania i admission. [MVP-0 baseline](MVP-0-STATUS.md) potwierdza testy lokalnego wycinka, nie to połączenie.

**Status checklisty:** kryteria do oceny konkretnego profilu, nie raport wykonania. Przy publikacji pierwotnej wersji brakowało pomiarów hosta; późniejsze [raporty operatora](AUDIT-REGISTER.md#raporty-operatora--oddzielna-klasa-dowodu), w tym [P0 hosta](orchestrator/P0-HOST-REPORT.md), są osobną klasą dowodu i nie zamykają S.6. Pola poniżej nie są automatycznie zaliczane wynikami z różnych konfiguracji. Całe S.6 pozostaje bez deklaracji PASS.

Checklistę wykonuje człowiek na małym, izolowanym worktree. Ten dokument nie uruchamia Codexa ani nie zleca jego uruchomienia z Chat/Work; nie dodaje nowego runtime'u, provider loop ani funkcji Tallystick. Nie zakłada nieudokumentowanych hooków, flag lub vendor-internal behavior.

## 1. Wymagania wstępne — TODO

- [ ] Dostęp do `korneliuszburian/tallystick`, Git, Node i npm; zapisane wersje i system operacyjny. Środowisko referencyjne i granice transferu wyniku: [baseline CI](MVP-0-STATUS.md#fact--zakres-i-identyfikacja-dowodu); nie jest to gwarancja kompatybilności środowiska desktopowego.
- [ ] Zainstalowany, dostępny lokalnie Codex CLI lub SDK, oraz konfiguracja MCP, jeżeli wybrana ścieżka go używa; zapisane dokładne wersje i źródło informacji o dostępnych interfejsach.
- [ ] Czysty checkout konkretnego commitu; brak równoległego writera badanego worktree; lokalny filesystem dla SQLite/CAS, nie NFS.
- [ ] Działające `npm ci`, wszystkie pięć suit, typecheck i demo na desktopie; rzeczywiste exit codes, nie wyłącznie obecność komend.
- [ ] SQLite >= 3.51.3 zmierzone przez połączenie `better-sqlite3`; wersja systemowego `sqlite3` nie jest dowodem tej zależności.
- [ ] Możliwość obserwacji granicy proposal/guard/spawn oraz faktycznych model-facing tool results przed admission; ekran czatu lub końcowe podsumowanie modelu nie wystarczają.

Brak narzędzia, uprawnień albo obserwowalności daje BLOCKED dla odpowiedniego punktu. Zarejestrowane naruszenie daje FAIL, nie BLOCKED.

## 2. Przygotowanie lokalne — TODO

W nowym katalogu sklonuj repo; istniejącego checkoutu nie resetuj ani nie czyść destrukcyjnie. Ustal testowany commit i zachowaj jego SHA. Poniższy setup wymaga Bash; polecenia są planem audytu, nie twierdzeniem o wykonaniu na desktopie.

```bash
git clone https://github.com/korneliuszburian/tallystick.git
cd tallystick
git fetch origin --prune
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
```

Przerwij, jeżeli checkout nie jest czysty lub jego SHA nie jest tym, który zamierzasz badać. Przeczytaj SPEC/AGENTS z tego checkoutu. Nie zakładaj, że historyczny baseline i bieżący main są identyczne.

Zapisz evidence poza repo i kontrolowanym worktree. Funkcja zapisuje komendę, pełny output i jej rzeczywisty exit code; błąd zatrzymuje sekwencję.

```bash
set -euo pipefail
umask 077
export AUDIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tallystick-audit.XXXXXX")"
printf '%s\n' "$AUDIT_ROOT"
run_logged() {
  local name="$1" rc
  shift
  printf '%q ' "$@" >> "$AUDIT_ROOT/commands.log"
  printf '\n' >> "$AUDIT_ROOT/commands.log"
  if "$@" > "$AUDIT_ROOT/$name.log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  cat "$AUDIT_ROOT/$name.log"
  printf '%s exit=%s\n' "$name" "$rc" >> "$AUDIT_ROOT/results.log"
  return "$rc"
}
run_logged commit git rev-parse HEAD
run_logged node node --version
run_logged npm npm --version
run_logged git git --version
run_logged install npm ci
run_logged typecheck npx --no-install tsc --noEmit
run_logged acceptance npm run test:acceptance
run_logged demo npm run demo
run_logged sqlite node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); console.log(db.prepare("SELECT sqlite_version() AS version").get()); db.close();'
```

Wynik pomiaru SQLite porównaj z wymaganiem SPEC; samo powodzenie zapytania nie sprawdza minimalnej wersji. Zanotuj też datę UTC, OS, architekturę, shell i wersję/config Codexa oraz serwera MCP. Sposób odczytu wersji CLI/SDK ustal z pomocy i dokumentacji faktycznie zainstalowanej wersji, nie z domniemanych flag.

Domyślne `npm run verify` jest jedynie skrótem acceptance + demo; nie zastępuje instalacji, typecheck ani S.6.

## 3. Mały kontrolowany worktree i plan spike'a — TODO

- [ ] Utwórz pod `AUDIT_ROOT` osobne tymczasowe repo Git z jednym plikiem zależności, np. `state.txt`, i początkowym commitem; to badany worktree, nie produkcyjny projekt.
- [ ] Wydziel obok worktree lokalną bazę, katalog CAS i katalog evidence; klucz `<databasePath>.harness-key` pozostaje prywatny, poza kontekstem modelu i Git.
- [ ] Ustal rzeczywisty sposób podłączenia istniejącego `createLedgerMiddleware` do dostępnego interfejsu hosta; zapisz dokumentację, konfigurację i minimalny plan pomiaru, zanim uruchomisz próbę.
- [ ] Sprawdź sposób emisji/ładowania biblioteki i dostępność `schema.sql`; demo z ADR-018 jest wzorcem kompilacji, nie gotowym adapterem Codex/MCP. Nie zakładaj mapowania `.js` na źródłowy `.ts` ani nie dodawaj loadera w celu obejścia kontraktu.
- [ ] Gdy potrzebnego pre-execution hooka, brokera lub model-facing boundary nie da się wykazać, zapisz BLOCKED; nie udawaj integracji przez samo wywołanie biblioteki obok hosta.
- [ ] Ogranicz eksperyment do inertnych poleceń, niewrażliwych fixture'ów i lokalnych efektów; nie używaj produkcyjnych repo, sekretów ani nieidempotentnych usług zewnętrznych.

Spike mierzy wykonalność istniejącego kontraktu. Brakująca integracja może wymagać późniejszego, odrębnie zatwierdzonego zadania; ta checklista nie upoważnia do nowego API, piątego modułu lub model loop. Próby diagnostyczne nie są ogłoszeniem profilu enforce ani fallbackiem do observer mode. Profil enforce pozostaje niedopuszczony do czasu potwierdzenia pokrycia.

## 4. Macierz ścieżek wykonania — TODO

Zbuduj inwentarz na podstawie rzeczywiście dostępnych narzędzi i konfiguracji. Native shell, narzędzia plikowe, wywołania MCP, ścieżki SDK/delegowania lub wznowienia są kategoriami do sprawdzenia, **nie twierdzeniem, że dana wersja hosta je udostępnia**. Uwzględnij także ścieżki uruchamiające kolejne narzędzia, jeżeli są dozwolone.

| ID / execution path | Dostępna? | Dozwolona w profilu? | Punkt kontroli przed efektem | Dowód przejścia przez broker albo skutecznego wyłączenia | Wynik |
|---|---|---|---|---|---|
| Do uzupełnienia z pomiaru | TODO | TODO | TODO | TODO | BLOCKED do pomiaru |

Wyłączenie native tool wymaga dowodu faktycznej niedostępności, a nie instrukcji tekstowej dla modelu. Sukces jednego wywołania MCP nie dowodzi pokrycia pozostałych ścieżek. Niewyjaśniona ścieżka blokuje globalne PASS.

## 5. Testy S.6 i granic kontraktu — TODO

### A. Wszystkie dozwolone ścieżki wykonania przechodzą przez broker

- [ ] Dla każdego wiersza macierzy wywołaj inertną próbę przez realny host i skoreluj proposal/request, decyzję guarda, permit/reservation, wykonanie i evidence.
- [ ] Wykonaj próbę negatywną bez dostępnego brokera lub bez ważnego permit w izolowanym środowisku; brak procesu/efektu ma wynikać z granicy kontrolnej, nie z prośby do modelu.
- [ ] Zapisz także dowody skutecznego wyłączenia ścieżek niedozwolonych w badanym profilu.

**PASS:** pełny inwentarz i dowód dla każdej dozwolonej ścieżki; żadna nie wykonuje efektu poza brokerem. **FAIL:** zaobserwowany dozwolony bypass. **BLOCKED:** niepełny inwentarz, brak hooka albo brak obserwowalności.

### B. Failure Gate działa przed uruchomieniem procesu

- [ ] Przez host uruchom kontrolowane polecenie kończące się rozpoznawalną porażką; zapisz actual exit code, raw event i failure record.
- [ ] Zaproponuj drugą i trzecią równoważną próbę bez escape proof, przy niezmienionych argv, środowisku, Git HEAD i `dependencyPaths`.
- [ ] Zmierz liczbę faktycznych uruchomień niezależnie od odpowiedzi modelu: łącznie jeden proces, a powtórki BLOCK z odniesieniem do wcześniejszej porażki.
- [ ] Nie pozwól, by licznik prób, logi lub timestampy instrumentacji zmieniały relevant preconditions i pozornie legalizowały retry.
- [ ] Sprawdź negatywnie niepoprawny/zużyty permit, jeżeli interfejs testowy pozwala go bezpiecznie podać; nie twórz bypassu wyłącznie po to, by wykonać test.

**PASS:** zatwierdzona decyzja poprzedza spawn, a zablokowane próby nie powodują procesu ani efektu. **FAIL:** BLOCK następuje dopiero po spawn lub równoważny retry wykonał się. **BLOCKED:** dostępne są wyłącznie post-execution notifications albo nie można wykazać kolejności i liczby uruchomień.

### C. Surowy wynik nie dociera do modelu przed filtrem

- [ ] Wygeneruj fixture z co najmniej 100 KiB inertnego raw outputu oraz rozpoznawalnym znacznikiem; nie umieszczaj pełnej treści fixture w promptach.
- [ ] Zarejestruj raw na granicy brokera, źródłowe bloby/event i rzeczywisty payload przekazywany przez host do model-facing admission.
- [ ] Sprawdź kolejność blob publish → event commit → receipt/admission oraz brak wcześniejszego raw streamu lub dodatkowej kopii raw w model-facing komunikatach.
- [ ] Rozróżnij prywatny raw log, output widoczny operatorowi i wejście modelu; sam brak raw na ekranie nie dowodzi braku raw w wejściu modelu.
- [ ] Bezpiecznie odtwórz brak receipt lub niedostępne evidence wyłącznie w disposable storage; brak źródła nie może dawać poprawnego wyniku.

**PASS:** dowód z granicy hosta potwierdza admission dopiero po filtrze i zatwierdzonym evidence, bez pełnego raw; brak źródła blokuje wynik. **FAIL:** raw dociera przed filtrem lub wynik bez dowodu jest admitted. **BLOCKED:** host nie udostępnia obserwacji tej granicy; deklaracja modelu nie zastępuje pomiaru.

### D. Wynik przekazywany modelowi jest ograniczonym typed digestem

- [ ] Zapisz rzeczywisty serializowany tool result z hosta, nie tylko obiekt zwrócony przez demo lub middleware w izolacji.
- [ ] Zmierz bajty UTF-8 części digestu po serializacji i sprawdź limit skonfigurowany w harnessie (domyślnie 4096 B); oddzielnie zapisz rozmiar i pola transportowej obwoluty hosta.
- [ ] Sprawdź typ digestu, source handles, receipt/raw event references, completeness i brak pełnego raw także w dodatkowych polach obwoluty.
- [ ] Odzyskaj raw z CAS i porównaj rzeczywiste bajty/hash; sukces kompresji bez recoverable evidence nie jest PASS.
- [ ] Dla kontrolowanego przekroczenia raw limit sprawdź zakończenie procesu w trakcie capture, `RAW_LIMIT_EXCEEDED` i niekompletny, odzyskiwalny zapis (ADR-017).

**PASS:** rzeczywista granica model-facing zachowuje ograniczony typed digest albo BLOCK i wymagane evidence, bez przemycenia raw przez inne pola. **FAIL:** przekroczony limit digestu, pełny raw, fałszywa kompletność lub brak źródła przy admission. **BLOCKED:** można zmierzyć tylko wynik biblioteki, nie hosta. Nie wymyślaj sposobu serializacji hosta; zmierz go.

### E. Natywne obejście oznacza fail-closed, bez observer mode

- [ ] Podejmij kontrolowane próby wykorzystania rzeczywiście dostępnych native execution paths z macierzy, w tym ścieżek alternatywnych wobec MCP.
- [ ] Zapisz observed bypasses, dokładną konfigurację i najmniejszą reprodukcję; nie uznawaj braku przypadkowego użycia native tool za dowód jego wyłączenia.
- [ ] Jeżeli istnieje dozwolony bypass, sprawdź odmowę startu konfiguracji enforce i brak automatycznego przejścia do observer mode.

**PASS testu fail-closed:** konfiguracja z wykrytym bypassem odmawia enforce. **FAIL testu fail-closed:** enforce startuje mimo bypassu lub cicho przechodzi w obserwację. **BLOCKED:** brak możliwości pomiaru. Sam PASS odmowy startu nie oznacza PASS integracji: profil z nierozwiązanym dozwolonym bypassem nadal nie spełnia A i nie jest enforce-ready.

## 6. Dowody wymagane dla każdego testu

- [ ] SHA Tallystick i fixture repo, status worktree, wersje narzędzi, data UTC, system, wybrany host/transport i rzeczywista konfiguracja dozwolonych ścieżek.
- [ ] Komendy z argumentami, exit codes, pełny output w prywatnym archive, logi przed spawn i z admission oraz identyfikatory proposal/guard/reservation/raw event/receipt umożliwiające korelację.
- [ ] Bajty/hash raw, rozmiar serializowanego digestu, completeness, liczba procesów i obserwowane skutki; screenshots tylko jako materiał uzupełniający, nie zamiennik nieobserwowalnej granicy.
- [ ] PASS / FAIL / BLOCKED każdego podtestu z uzasadnieniem, observed bypasses i odnośnikami do evidence; brak dowodu pozostaje jawny.

Nie publikuj harness key, tokenów, haseł ani wrażliwego raw. Oryginały przechowuj w kontrolowanym miejscu, a do issue dołącz zredagowane kopie z opisem redakcji i stabilnymi identyfikatorami dowodów. Zachowaj prywatne oryginały do weryfikacji integralności; nie nadpisuj ich summary.

## 7. Decyzja końcowa i procedura po wyniku

| Wynik | Kryterium | Dalszy krok |
|---|---|---|
| PASS | Wszystkie A–E mają wystarczające dowody dla jednego, dokładnie opisanego profilu; nie pozostała dozwolona ścieżka bypass ani nieobserwowalna granica. | Zapisać evidence i zakres wyniku w issue; właściciel zatwierdza decyzję integracyjną/ADR przed zmianą deklarowanego profilu. |
| FAIL | Co najmniej jedno zmierzone naruszenie invariantu, w tym nieusunięty dozwolony bypass. | Nie dopuszczać enforce; zapisać reprodukcję w issue i wskazać ADR/kontrakt wymagający naprawy lub jawnej decyzji. |
| BLOCKED | Brak naruszenia wykazanego pomiarem, lecz niepełna obserwowalność, brak narzędzia, hooka lub dowodu. | Zapisać brakujące evidence i warunek odblokowania w issue; nie zastępować wyniku przypuszczeniem ani observer mode. |

Jeżeli występują jednocześnie FAIL i BLOCKED, wynik całości to FAIL, a blokady pozostają zapisane osobno. UNKNOWN execution oznacza zero automatycznych retry i reconciliation procesu, worktree i skutków przed kontynuacją; nie jest usprawiedliwieniem ponownego wykonania.

Użyj istniejącego [issue #22 — Desktop integration audit: validate Tallystick enforce path with Codex/MCP](https://github.com/korneliuszburian/tallystick/issues/22), zamiast tworzyć drugi tracker. Kolejne wyniki dopisuj do tego issue zamiast produkować duplikaty. Każda proponowana zmiana architektury musi wskazać naruszony ADR i uzyskać jawną decyzję supersedującą; nie edytuj historii ani API po cichu. Brak konieczności zmiany kontraktu nie wymaga sztucznego nowego ADR, lecz wymaga wskazania obowiązujących decyzji w wyniku audytu.

Zmiana SHA, wersji/config Codexa/MCP, transportu, dozwolonych narzędzi lub sposobu admission wymaga ponownej walidacji dotkniętych granic. PASS jednego profilu nie jest uniwersalnym certyfikatem produkcyjnym.
