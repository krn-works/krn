# Tallystick — reguły pracy

[Start](README.md) · [Kontrakty](SPEC.md) · [Motywacje](docs/ARCHITECTURE.md)

> **Rola:** reguły pracy i kryteria dokumentacji. **Status:** OBOWIĄZUJE W TYM CHECKOUCIE.  
> **Źródła:** [SPEC.md](SPEC.md); zatwierdzony zakres zadania właściciela.  
> **Kiedy ten dokument traci aktualność:** po jawnej zmianie reguł pracy lub kontraktów/odsyłaczy; obowiązuje wersja z badanego checkoutu, nie kopia z pamięci.

## Kontekst projektu

Tallystick otacza istniejący runtime Codexa; granicę systemu i zakres MVP-0 określa [SPEC](SPEC.md#cel-i-granica-systemu).

## Nazewnictwo

Nazwa produktu w nowej dokumentacji: **Tallystick**; repo, ścieżki i slug: `tallystick`. **LEDGER** jest historycznym aliasem tego samego designu, nie osobnym produktem. Zachowuj go w cytatach, historycznych tytułach, istniejących kontraktach i rzeczywistych nazwach technicznych (`Event Ledger`, `createLedgerMiddleware`, `LEDGER CI`, `ledger-acceptance`). Normalizacja redakcyjna nie upoważnia do rename API, modułów, pakietu, workflow ani ADR.

## Źródło wymagań

Implementuj DOKŁADNIE [SPEC.md](SPEC.md). Aktualne refs, kod, PR, issues i CI sprawdzaj w GitHub; `main` jest bazą, nie dowodem statusu lokalnego checkoutu. [ISSUES.md](ISSUES.md) jest historyczną mapą etapów. [Baseline](docs/MVP-0-STATUS.md) potwierdza własny SHA.

Przed zadaniem przeczytaj [ADR](SPEC.md#decyzje-niepodlegące-negocjacji), właściwy moduł w [R](SPEC.md#r-mvp-0-implementation-spec), kryteria w [S](SPEC.md#s-mvp-0-acceptance-tests) i zależności etapu. Przy rozbieżności opisu implementacji z kodem kod opisuje stan faktyczny, ale SPEC nadal określa wymagane zachowanie. Rozbieżności motywacyjnej nie naprawiaj przez przepisywanie historii. Research i raport operatora nie są nowym ADR ani niezależną weryfikacją repo.

## Kod, wymagania i dowody

Kod na wskazanym SHA pokazuje, co jest zaimplementowane; rzeczywisty run pokazuje, co wykonano i sprawdzono. SPEC/ADR określają wymagane zachowanie, nie poświadczają jego realizacji. Opis implementacji sprzeczny z kodem wymaga korekty opisu; kod sprzeczny z kontraktem wymaga testu i naprawy w zatwierdzonym zakresie, nie przepisania SPEC pod istniejący błąd. Sprzeczność samych wymagań podlega procedurze STOP poniżej.

Po odczytaniu właściwych wymagań przejdź do typów, implementacji, wywołań i testów danego modułu — [mapa kodu](README.md#mapa-rdzenia). Docs czytaj selektywnie dla uzasadnień decyzji, odrzuconych alternatyw, języka domeny, kryteriów i dowodów. Nie ładuj całego researchu jako obowiązkowego wprowadzenia do każdej zmiany.

Czytelność utrzymuj w kodzie: jednoznaczne nazwy, spójne formatowanie, małe jednostki odpowiedzialności i istniejący podział typów oraz implementacji. Nie przykrywaj niezrozumiałego kodu opisującym go Markdownem ani komentarzem powtarzającym instrukcje. To nie zgoda na niezlecony refaktor lub zmianę API.

Rejestr badawczy jest indeksem hipotez i prób: ustalenie wiąż ze źródłem, SHA i reprodukcją. Przy kolizji identyfikatorów zachowaj prefiks źródła (np. SD:F01, SR:F16); zmiana dokumentacji nie oznacza naprawy ani zamknięcia ustalenia.

## Reguły pracy

- Nie zmieniaj architektury, API, nazw modułów ani plików bez jawnej zgody; nie edytuj po cichu historii ADR, a nowa decyzja supersedująca zachowuje wcześniejszy zapis — [SPEC](SPEC.md#decyzje-niepodlegące-negocjacji).
- Przy znanym dozwolonym bypassie brokera odmów startu `enforce`, bez observer fallback; bez dowodu pokrycia nie deklaruj potwierdzonej integracji — [ADR-002](SPEC.md#adr-002--enforcement-działa-fail-closed), [S.6](SPEC.md#s6-dodatkowa-bramka-wdrożenia--poza-mvp-0).
- Guard i zatwierdzony zamiar muszą poprzedzać `spawn`; nie uruchamiaj procesu bez poprawnego, niezużytego permit — [R.4](SPEC.md#r4-failure-antibody-gate), [ADR-016](SPEC.md#adr-016--kompozycja-middleware-zużycie-permit-klucz-i-obwoluta-receipt).
- `UNKNOWN` oznacza zero automatycznych retry i reconciliation przed kontynuacją — [ADR-003](SPEC.md#adr-003--nieznany-wynik-wykonania-nie-uprawnia-do-retry), [R.5](SPEC.md#r5-cienkie-złożenie-w-srcindexts).
- Nie dopuszczaj digestu bez zatwierdzonego receipt ani nie zastępuj jedynego raw evidence przez summary/digest — [ADR-004](SPEC.md#adr-004--dowód-poprzedza-admission), [R.1](SPEC.md#r1-event-ledger).
- Nie wykonuj wywołań LLM w hot path — [ADR-005](SPEC.md#adr-005--hot-path-jest-deterministyczny).
- Nie traktuj pamięci językowej ani odpowiedzi modelu jako stanu repo — [R.3](SPEC.md#r3-state-twin).
- Nie zmieniaj epoki przez zapis failure, wyniku testu, timestampu lub obserwacji — [ADR-001](SPEC.md#adr-001--epoka-świata-jest-oddzielona-od-rewizji-wiedzy).
- Nie rozszerzaj MVP-0 o piąty moduł, provider/model loop ani elementy poza zakresem i nie dodawaj niezatwierdzonych zależności — [R.0](SPEC.md#r0-zakres-środowisko-i-struktura).
- Nie pomijaj edge cases ani nie zastępuj testów rzeczywistych procesów mockowanym LLM — [R](SPEC.md#r-mvp-0-implementation-spec), [S](SPEC.md#s-mvp-0-acceptance-tests).
- Przed zapisem przedstaw plan plików i uzyskaj zgodę właściciela; realizuj zatwierdzony zakres bez samowolnego rozszerzania.

## Sprzeczności i brak rozstrzygnięcia

**STOP:** przy sprzeczności wymagań zatrzymaj realizację i zgłoś konflikt zamiast samodzielnie zmieniać kontrakt — [SPEC](SPEC.md#decyzje-niepodlegące-negocjacji).

Zgłoszenie zawiera dokładne cytaty i odsyłacze, dotknięty invariant/publiczne API oraz test-case bez jednoznacznej implementacji. Diagnostic STOP nie jest ukończeniem pracy. Nie obchodź konfliktu zmianą API, poluzowaniem testu, dodatkową zależnością ani obejściem fail-closed.

## Kolejność i bramki ukończenia

Kolejność i warunek rozpoczęcia kolejnego modułu: [ADR-006](SPEC.md#adr-006--kolejność-implementacji-jest-zamrożona). Ukończenie: zgodne API, invariants i edge cases w [R](SPEC.md#r-mvp-0-implementation-spec), testy w [S](SPEC.md#s-mvp-0-acceptance-tests) oraz regresja wcześniejszych modułów. Bramka MVP-0: [S.1–S.5](SPEC.md#s1-sekwencja-obowiązkowa); rzeczywista integracja: osobne [S.6](SPEC.md#s6-dodatkowa-bramka-wdrożenia--poza-mvp-0).

## Konwencje commitów i PR

- Twórz atomowe commity per test-case; opis: `module: co i dlaczego`.
- Podaj powiązane issue, zmieniony test-case i rzeczywiste wyniki; użyj [szablonu PR](.github/pull_request_template.md).
- Bez bezpośredniego push do `main`; zmiany przez PR. Merge podlega [autoryzacji właściciela](#merge-po-zgodzie-właściciela).
- Nie obchodź branch protection/required checks ani nie włączaj auto-merge dla ukrycia czerwonego wyniku.
- Bez `continue-on-error`, pomijania suit i osłabiania asercji w celu uzyskania pozornego sukcesu.

PR dokumentacyjny opisuje decyzje, kryteria lub dowody; convenience script wymaga jawnego zakresu. Implementacyjny realizuje konkretne zlecenie i SPEC z testami oraz regresją. Diagnostic STOP stosuje procedurę powyżej. Żaden typ nie upoważnia do niezatwierdzonej zmiany ADR/API.

### Merge po zgodzie właściciela

Jawne polecenie lub zgoda właściciela upoważnia agenta do merge wskazanego PR, również autorstwa agenta. Zapisz źródło zgody w PR; nie pytaj ponownie o tę samą zgodę przy niezmienionym zakresie. Nowy zakres lub konflikt wymaga odrębnego rozstrzygnięcia, a zmiana head/base — ponownej weryfikacji.

Przed scaleniem odczytaj aktualne head/base, wykonaj re-review dokładnego diffu, potwierdź wymagane checks dla aktualnej rewizji i rozlicz blokujące uwagi. Własny re-review nie zastępuje wymaganego niezależnego review. Brak zgody, wymaganych dowodów albo pozytywnych checków oznacza brak merge’u; nie obchodź zabezpieczeń repo.

Użyj obsługiwanej operacji merge PR z kontrolą oczekiwanego head SHA, bez force-push lub administracyjnego bypassu. Po operacji odczytaj stan PR, merge commit i main. Przy nieznanym wyniku najpierw odczytaj stan zamiast ponawiać operację w ciemno. Zgoda na merge nie obejmuje usuwania gałęzi ani zmiany ustawień repo.

Ta reguła określa zgodę w repozytorium; nie zmienia uprawnień narzędzi ani instrukcji i ustawień hosta. Ich ograniczenia należy zgłosić, nie obchodzić.

## Porządek gałęzi po merge

Jedna aktywna gałąź na aktywny PR, domyślnie z aktualnego main; nie zostawiaj porzuconych ani zbędnych stacked branches. Zamknij superseded PR; linked issue dopiero po potwierdzeniu kryteriów i sprawdzeniu closing keywords; następnie rozlicz head branch.

Przed usunięciem porównaj aktualne SHA: `ahead_by=0` i `behind`/`identical` potwierdzają zawarcie historii. Zamknięty PR, podobne pliki i squash merge nie wystarczają. Zmiana head wymaga nowego porównania; rozbieżność — osobnego przeglądu. Bez force-delete na podstawie nazwy lub starej listy. Usunięcie gałęzi wymaga zgody właściciela.

Zmiana ustawień repo wymaga osobnej zgody; branch protection/auto-merge dopiero po potwierdzeniu stabilnych wymaganych checków. Pojedynczy zielony run nie jest zgodą. Zapis czynności: [checklista](docs/REPOSITORY-HYGIENE.md).

## Wyniki i evidence

FACT wymaga dowodu; TODO oznacza niewykonaną pracę. PASS/FAIL/BLOCKED zawsze mają zakres: zmierzone naruszenie to FAIL, brak wystarczającego pomiaru to BLOCKED. Jednoczesny FAIL i BLOCKED nie dają PASS. Plan ani kod testu nie zastępują uruchomienia. Raport operatora oznacz jako taki, gdy nie odczytano źródłowych logów.

Wynik wiąż z SHA, środowiskiem, profilem i źródłem. Nie przenoś wyników między rewizjami; nie sumuj różnych profili do jednego PASS. Odczyt konfiguracji nie jest atestacją jej późniejszego użycia.

## Dokumentacja

- Dokument w docs/ istnieje tylko, jeśli koduje decyzję, kryterium testu, dowód albo mapę prowadzącą do tych źródeł. Dokument procesowy lub mapa są krótkie i linkują źródła normatywne zamiast je kopiować.
- Jedna reguła = jedno kanoniczne miejsce. SPEC.md jest jedyną kopią kontraktów; AGENTS.md jedyną kopią reguł pracy.
- Każdy plik w `docs/` ma jedną rolę, jednego właściciela i nazwanego konsumenta. Jego nagłówek podaje rolę, status, zakres, źródła i warunek utraty aktualności; brak któregoś z tych pól zatrzymuje publikację. `README.md`, `AGENTS.md`, `SPEC.md` i `ISSUES.md` mają własne kontrakty i nie dziedziczą tego szablonu.
- Każdy fakt w dokumencie ma dowód (plik, run, commit, sekcja SPEC) przypięty do stałego punktu: rewizji, środowiska, profilu i daty. Dokument bez linii utraty aktualności nie może wejść do docs/.
- Research jest skompilowaną pamięcią decyzji, nie notatnikiem, transcriptem ani dziennikiem przebiegu. Nowe evidence aktualizuje kanoniczną stronę i oznacza poprzedni wniosek jako superseded; nie tworzymy drugiego bieżącego podsumowania tego samego tematu.
- Promocja z `.krn/runs/` do `docs/` wymaga przyszłego konsumenta, kanonicznego miejsca, pochodzenia i reguły usunięcia albo supersesji. Raw, prompty, odpowiedzi modeli i logi pozostają poza Git. Temat bez konsumenta usuwamy z drzewa, zachowując historię Git.
- PR dokumentacyjny wykazuje w opisie, którym elementem filtra zarabia każdy nowy lub zmieniony plik.
- Nie dodawaj dokumentacji, która opowiada to, co egzekwuje kod lub test.

README jest mapą. Jeden plik ma jeden cel; nowy wymaga uzasadnienia filtrem. Bez przymiotników oceniających bez pomiaru, fikcyjnych badges PASS i rozbudowanych kopii tego samego summary. Wyjątkiem od unikania powtórzeń są krytyczne jednolinijkowe instrukcje agenta z odsyłaczem do SPEC w sekcji Reguły pracy.

### Wspólny szablon

Wspólna jest struktura informacji, nie obowiązek wypełniania pustych rozdziałów:

```markdown
# Tallystick — jednoznaczny cel

> **Rola:** decyzja / kryterium / dowód / mapa
> **Status:** status decyzji lub wynik o jawnym zakresie
> **Właściciel:** osoba lub workflow odpowiedzialny za aktualność
> **Konsument:** konkretna decyzja, komenda, issue albo workflow używający dokumentu
> **Zakres:** data, rewizja, profil albo obszar obowiązywania
> **Źródła:** kanoniczne dokumenty i dowody
> **Kiedy ten dokument traci aktualność:** konkretny warunek

## Ustalenie
## Uzasadnienie
## Dowody lub kryteria PASS / FAIL / BLOCKED
## Granice i dalsze rozstrzygnięcie
```

Nazwy rozdziałów dopasuj do roli; pomiń niemające zastosowania. Zachowuj stabilne identyfikatory i istniejące odsyłacze. Polskie nagłówki/proza, oryginalne nazwy API/statusów. Nie wymieniaj istniejących nazw plików wyłącznie dla estetyki.

### ADR i źródła historyczne

ADR pozostaje w SPEC, bez drugiej kopii w `docs/adr/`. Nowy zatwierdzony ADR ma identyfikator/tytuł, status i zakres, **Regułę**, **Uzasadnienie**, źródła/kryterium oraz jawną relację zastępowania. Brak decyzji właściciela = REKOMENDACJA — NIEZAMROŻONE. Szablon nie upoważnia do edycji starych ADR ani kosmetycznego przepisania SPEC.

Historyczne wyniki i cytaty zachowują własne daty, nazwy i identyfikatory. Skrót lub przeniesienie wskazuje nowe miejsce albo permalink do niezmiennego oryginału. Research nie aktualizuje po cichu dawnego wyniku: osobno zapisuj późniejszy dowód i jego ograniczenia. Pełne raw, sekrety i lokalne klucze nie trafiają do publicznego repo; identyfikatory raportów nie są same dowodem prawdziwości ich wniosków.

<!-- krn-adoption:start -->
<!-- Generated by `krn adopt`; rerun it to refresh this block. -->
# Delivery rules

- **R-1** When work is managed, the lead MUST keep task status in `tasks/<id>.json` with `krn task`; workers MUST NOT edit tracker files.
- **R-2** When agent state is written, the author MUST keep it under `.krn/`, which is ignored by git.
- **R-3** When a change is ready, the author MUST obtain a green `ci / Check` on the exact HEAD; the repository has no other required gate.
- **R-4** When a commit completes a managed task, its last trailer paragraph MUST carry `Ticket: <id>` (`Refs: <id>` while the task stays open).
<!-- krn-adoption:end -->

<!-- krn-standards:start -->
<!-- Generated by `krn adopt` from .agents/standards.json; rerun it to refresh this block. -->
# Standards

- **s-tests-tracked** The repository tracks automated tests next to the code they cover. _(checked by `krn standards check`: `git ls-files | grep -qE '(^|/)(tests?|__tests__|spec)/|(_test\.go|_test\.py|(^|/)test_[^/]*\.py|\.(test|spec)\.[cm]?[jt]sx?)$'`)_
- **s-test-command** The repository declares one test command that runs its tests, never a placeholder. _(checked by `krn standards check`: `if [ -s package.json ]; then node -e 'const t=(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts||{}).test||"";process.exit(t.trim()===""||/no test specified/.test(t)?1:0)'; elif [ -f composer.json ] || [ -f phpunit.xml ] || [ -f phpunit.xml.dist ]; then if [ -f phpunit.xml ] || [ -f phpunit.xml.dist ]; then true; else node -e 'const s=(JSON.parse(require("fs").readFileSync("composer.json","utf8")).scripts||{}).test;process.exit(s===undefined||/no test specified/.test(JSON.stringify(s))?1:0)'; fi; elif [ -f go.mod ]; then git ls-files | grep -q '_test\.go$'; elif [ -f Cargo.toml ]; then true; elif [ -f pyproject.toml ] || [ -f setup.cfg ] || [ -f setup.py ] || [ -f tox.ini ] || [ -f pytest.ini ]; then git ls-files | grep -qE '(^|/)(test_[^/]*|[^/]*_test)\.py$'; else grep -qE '^test:' Makefile 2>/dev/null; fi`)_
- **s-test-exit-code** The test command exits non-zero when a test fails: no `|| true`, `; exit 0` or leading `-` masks its status. _(checked by `krn standards check`: `{ [ ! -s package.json ] || node -e 'const s=JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts||{};const bad=Object.entries(s).filter(([k,v])=>/^test/.test(k)&&/\|\|\s*(true|:|exit 0)|;\s*exit 0\s*$/.test(String(v)));if(bad.length){console.error("masked: "+bad.map(b=>b[0]).join(", "));process.exit(1)}'; } && { [ ! -f Makefile ] || awk '/^test[a-zA-Z0-9_-]*:/{t=1;next} /^[^\t]/{t=0} t&&(/\|\| *(true|:)/||/^\t-/){bad=1} END{exit bad}' Makefile; }`)_
- **s-ci-runs-tests** Continuous integration runs the tests on every pull request. _(checked by `krn standards check`: `ci=$(cat .github/workflows/*.yml .github/workflows/*.yaml .gitlab-ci.yml 2>/dev/null); printf '%s\n' "$ci" | grep -qE 'pull_request|merge_request' && printf '%s\n' "$ci" | grep -qE '(pytest|tox|nox|unittest|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|node --test|go test|cargo test|make test|uv run|hatch run|poetry run|phpunit|composer( run)? test)|uses: *[^ ]*/[^ ]*ci\.ya?ml'`)_
- **s-no-secrets-tracked** No tracked file is a credential file or holds a private key or provider token. _(checked by `krn standards check`: `! git ls-files | grep -vE '\.env\.(example|sample|template|dist)$' | grep -qE '(^|/)(\.env(\.[^/]*)?|id_rsa|id_ecdsa|id_ed25519|[^/]*\.pem|[^/]*\.p12|\.netrc|\.git-credentials)$' && ! git grep -qIE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e 'AKIA[0-9A-Z]{16}' -e 'gh[pousr]_[A-Za-z0-9]{36}' -e 'xox[abp]-[0-9A-Za-z-]{20,}'`)_
- **s-no-dependency-dirs-tracked** Installed dependencies, caches and bytecode are never tracked. _(checked by `krn standards check`: `! git ls-files | grep -qE '(^|/)(node_modules|__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox)/|\.py[co]$'`)_
- **s-linter-configured** A formatter or linter is configured for the stack, so style is checked by a tool, not by review. _(checked by `krn standards check`: `for f in biome.json biome.jsonc .eslintrc .eslintrc.* eslint.config.* .prettierrc .prettierrc.* prettier.config.* ruff.toml .ruff.toml .flake8 .pylintrc .golangci.yml .golangci.yaml .golangci.toml rustfmt.toml .rustfmt.toml phpcs.xml phpcs.xml.dist .phpcs.xml phpstan.neon phpstan.neon.dist .php-cs-fixer.php .php-cs-fixer.dist.php pint.json psalm.xml; do [ -e "$f" ] && exit 0; done; grep -qE '^\[tool\.(ruff|black|flake8|pylint)' pyproject.toml 2>/dev/null || grep -qE '"(@biomejs/biome|eslint|prettier)"' package.json 2>/dev/null || cat .github/workflows/*.y*ml 2>/dev/null | grep -qE 'gofmt|go vet|golangci|cargo fmt|cargo clippy'`)_
- **s-readme-test-command** The README states how to run the tests. _(checked by `krn standards check`: `cat README* readme* 2>/dev/null | grep -qiE '(pytest|tox|nox|unittest|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|node --test|go test|cargo test|make test|uv run|hatch run|poetry run|phpunit|composer( run)? test)'`)_
- **s-no-conflict-markers** No tracked file holds an unresolved merge conflict marker. _(checked by `krn standards check`: `! git grep -qIE '^(<<<<<<<|>>>>>>>) '`)_
- **s-one-instruction-file** A repository keeps one instruction file for agents, AGENTS.md; any other agent instruction file is a link to it or points to it. _(checked by `krn standards check`: `for f in CLAUDE.md GEMINI.md .cursorrules .github/copilot-instructions.md; do [ ! -e "$f" ] || [ "$(readlink "$f")" = AGENTS.md ] || grep -q 'AGENTS.md' "$f" || { echo "$f does not point to AGENTS.md" >&2; exit 1; }; done`)_
- **s-clean-checkout-tests** The test suite gives the same verdict on a clean checkout: no test depends on untracked local state such as an earlier build or the enclosing repository. _(checked by `krn standards check`: `[ ! -s package.json ] || node -e 'const fs=require("fs"),cp=require("child_process");const s=JSON.parse(fs.readFileSync("package.json","utf8")).scripts||{};if(/\b(build|tsc|tsup|esbuild|rollup|webpack)\b/.test([s.pretest,s.test].join(" ")))process.exit(0);const files=cp.execFileSync("git",["ls-files","-z"],{encoding:"utf8"}).split("\0");if(files.some(f=>/(^|\/)dist\//.test(f)))process.exit(0);const bad=files.filter(f=>/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\/.*\.[cm]?[jt]sx?$/.test(f)&&fs.existsSync(f)&&/["\x27`][^"\x27`\s]*\bdist\/[^"\x27`\s]*\.[cm]?js["\x27`]/.test(fs.readFileSync(f,"utf8")));if(bad.length){console.error("tests read untracked dist/ output but the test script builds nothing: "+bad.slice(0,3).join(", "));process.exit(1)}'`)_
- **s-regression-lowest-layer** A fixed defect gets its regression test at the lowest layer that reproduces it. _(advisory, not checked)_
- **s-plainest-input** When a task names an input or output format, at least one test feeds the plainest hand-written example of that format exactly as the task words it. _(advisory, not checked)_
- **s-receiver-evidence** Every integration or forward is tested against its real receiver or a verbatim capture of the receiver's output, never against a hand-made imitation. _(advisory, not checked)_
- **s-role-names** Files, functions, tests and work are named by purpose and role, never by phase, ticket, round, date or version. _(advisory, not checked)_
- **s-exit-codes** Every error path has a stated exit code (64 usage, 65 invalid data, 70 internal, 75 temporary) and a message on stderr. _(advisory, not checked)_
- **s-secrets-redacted** Values that may hold credentials, multiline ones included, are redacted before they are logged, persisted or forwarded. _(advisory, not checked)_
- **s-no-shared-stash** Never change the git stash stack with a bare `git stash` or `git stash pop`; set work aside with a commit. _(advisory, not checked)_
- **s-semantic-commits** Commit subjects are semantic: `type(scope): outcome` with a conventional type such as feat, fix, docs, chore or refactor. _(checked by `krn standards check`: `! git rev-parse -q --verify HEAD >/dev/null 2>&1 || ! git log --no-merges -n 20 --format=%s | grep -vE '^(Revert "|(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?: )' | grep -q .`)_
- **s-noninteractive-remote-commands** Tracked shell scripts run ssh and scp with `-o BatchMode=yes` and apt-get install with `-y`, so they fail instead of waiting for a prompt. _(checked by `krn standards check`: `! git grep -hIE '^[[:space:]]*(sudo[[:space:]]+)?(ssh|scp)[[:space:]]|apt-get[[:space:]]+install' -- '*.sh' | grep -vE 'BatchMode=yes|apt-get[[:space:]]+install[^#]*[[:space:]]-y' | grep -q .`)_
- **s-no-whitespace-errors** Uncommitted changes pass `git diff --check`: no trailing whitespace, no space-before-tab, no conflict markers. _(checked by `krn standards check`: `! git rev-parse -q --verify HEAD >/dev/null 2>&1 || git diff --check HEAD`)_
<!-- krn-standards:end -->
