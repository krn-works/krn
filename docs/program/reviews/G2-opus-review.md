# G2: czy L1 może ruszyć (review Opusa, read-only, 2026-10-07)

**Werdykt: GO-L1-WITH-CHANGES.** L1 może ruszyć dopiero po jednym slice'ie naprawczym (B1–B7) i po readbacku B0.

Metoda:
- Przeczytałem blueprint v4 (§4, §9), charter, plan E1, raport G1, raporty J-S1..4 i S*, każdy plik `krn` na `9ffb1d7` oraz hook `~/.codex/hooks/krn_capsule.py`.
- Gate na klonie w `/tmp/krn-g2` dał 16/16 i exit 0.
- Sondy z prawdziwym `relay`, `trace`, CLI i `CodexHost` oraz fałszywym plikiem wykonywalnym `codex` [OURS-EVIDENCE].
- Klon i sondy usunąłem. Prawdziwy checkout jest czysty.

Ścieżka szczęśliwa działa end-to-end. Gdy komenda checkpointu jest wykonywana bezpośrednio przez proces `codex`, przebieg wygląda tak: commit A, checkpoint, sesja 2 z nowym ID, commit B, `human_decision: S5/S6 verdict path is not enabled` [OURS-EVIDENCE]. Mechanizm przerwania, sprzątanie procesów i wybór repo są jednak nieprawdziwe albo niezweryfikowane dla realnego Codexa.

## BLOCKING

**B1. Przerwanie zależy od niezweryfikowanej topologii procesów i może skłamać.**
- Mechanizm: `krn checkpoint` zabija grupę procesów *rodzica* (`process.kill(-parentGroup())`) [CODE src/cli/index.ts:44-68]. Działa to tylko wtedy, gdy rodzicem CLI jest sam `codex`.
- Sonda: narzędzie uruchomione we własnej grupie procesów, za powłoką, która nie robi `exec` (`bash -c "cd … && node …"`).
  - Ginie tylko komenda narzędzia (`SIGTERM`), a sesja 1 przeżywa i pracuje dalej.
  - Gdy sesja nie commituje: foreman i tak uznaje ją za przerwaną (`hasCheckpoint`), startuje sesję 2 i raportuje „wznowienie”, choć sesja 1 nigdy nie została przerwana. To fałszywy dowód G2.
  - Gdy sesja commituje dalej: `human_decision: HEAD changed`, a kapsuła zostaje w stanie bez wyjścia [OURS-EVIDENCE].
- Czy Codex 0.160 uruchamia komendy w osobnej grupie (setpgid/PTY): [HYPOTHESIS]. W binarce nie ma symboli, źródła nie ma lokalnie.
- Skutek uboczny: zabity w połowie tury `codex exec` nie emituje `turn.completed`. Tokeny sesji 1 wynoszą wtedy 0 [CODE src/hosts/codex.ts:136-141]. `--ephemeral` nie zostawia rolloutu, więc nie ma ich skąd odzyskać.
- **Poprawka:**
  - CLI `checkpoint` tylko zapisuje i nigdy nie sygnalizuje.
  - Prompt mówi: „po checkpoincie zakończ turę”.
  - `runSession` w trakcie `wait()` co ~1 s sprawdza `trace.hasCheckpoint`. Jeśli proces nie wyjdzie sam w ciągu ≤60 s, woła `cancelTree`. Foreman zna pgid, bo sam spawnował proces z `detached`.
  - Falsyfikator integracyjny (czerwony dziś): prawdziwy `relay` + `trace` + CLI i fałszywy `codex`, który odpala checkpoint przez `bash -c` w nowej grupie. Asercja: sesja 1 nie żyje przed startem sesji 2, a `usage` sesji 1 jest różne od zera.

**B2. Osierocony worker po przerwaniu foremana.**
- Sonda: `SIGINT` do procesu `live-l1` zabija foremana. `codex` (osobna grupa, `detached: true`) zostaje przepięty pod subreapera i dalej commituje oraz checkpointuje. Timeout ginie razem z foremanem, bo `timer.unref()` siedzi w martwym procesie [OURS-EVIDENCE; CODE src/hosts/codex.ts:83-93].
- Ctrl-C operatora, czyli naturalny abort L1, daje więc niekontrolowaną sesję Luny bez limitu czasu.
- **Poprawka:**
  - W `scripts/live-l1.mjs` handlery `SIGINT/SIGTERM/SIGHUP`: `cancelTree` wszystkich żywych sesji, potem exit 130.
  - `CodexHost.cancelAll()` (≈6 linii).
  - pgid w zdarzeniu `session_started`, na potrzeby ręcznego `kill`.

**B3. `npm run live` zawsze tworzy worktree z repozytorium `krn`. Nie ma też wejścia wznowienia.**
- npm uruchamia skrypt z cwd równym katalogowi pakietu. Sonda: `cwd=/tmp/krn-g2`, a `INIT_CWD` to katalog wywołania [OURS-EVIDENCE].
- `krn start` używa `process.cwd()` [CODE src/cli/index.ts:29; scripts/live-l1.mjs:25-29]. Prawdziwe issue z frontend-system lub krn-codex-skills jest więc nieosiągalne.
- `krn` nie ignoruje `.krn/`. Kapsuła i trace są tam nieśledzone i do zacommitowania przez workera. `krn state check` zwraca błąd `runs-not-ignored` [OURS-EVIDENCE].
- Ponowne `npm run live` z tym samym `--job` pada: `already exists` [OURS-EVIDENCE]. Po awarii foremana nie da się wznowić, chociaż `runJob` by to umiał.
- **Poprawka:**
  - Wymagany `--repo <abs>`, przekazany jako cwd dla `start`.
  - Odmowa, gdy `git check-ignore .krn/runs/x` zawiedzie.
  - `--worktree <abs>` pomija `start` (tryb wznowienia).

**B4. Checkpoint nie niesie treści, a stan dzierżawy zajmuje `nextAction`.**
- `nextAction` służy jako maszyna stanów: `session active` i `resume after checkpoint` [CODE src/relay/index.ts:143-151,175-198; src/foreman/session.ts:116].
  - Worker nie może zapisać następnej akcji ani decyzji, choć §4.2 krok 3 mówi „worker aktualizuje decyzje przez `krn checkpoint`”.
  - Hook SessionStart w sesji 2 czyta kapsułę już po `bindSession`. Wstrzykuje więc „next bounded action: session active”, a prompt mówi „resume after checkpoint”.
- Skutek dla G2: L1 nie odróżni ciągłości z kapsuły od odkrywania stanu z `git log`.
- `validate` nie sprawdza też brudnego drzewa [CODE src/relay/index.ts:108-115], więc „dokładnie raz” jest niezdefiniowane dla niezacommitowanej pracy.
- **Poprawka:**
  - `krn checkpoint --next "<≤200 znaków, jedna linia>" [--decision "<tekst>"]`.
  - Checkpoint odmawia przy brudnym drzewie (pliki ignorowane się nie liczą).
  - Dzierżawa przechodzi do `Evidence observed: session=…; lease=active|checkpointed`. `nextAction` zostaje wyłącznie dla workera.

**B5. Tekst transkryptu trafia do trace i może rozjechać ABI.**
- `trace.log` zapisuje cały `CodexSessionResult`. Pole `reason` to końcowa wiadomość agenta albo stderr (≤1 MB) [CODE src/foreman/session.ts:99; src/hosts/codex.ts:194-198]. Sonda: wieloliniowa wiadomość agenta zapisana dosłownie w JSONL [OURS-EVIDENCE].
- To łamie akceptację S2 („without persisting transcripts”) i §4.1 („podsumowanie hosta jest jednorazowe”) [POLICY].
- `refreshCAS` wkleja `end.reason` w `nextAction` bez escapowania [CODE src/relay/index.ts:163-165]. Znak `\n` rozbija linie ABI, a >8000 znaków rzuca wyjątek. Wyjątek w `recoverLease` jest poza `try` [CODE src/foreman/run.ts:16].
- **Poprawka:**
  - Trace zapisuje `{exitCode, signal, threadId, usage, reasonKind, reasonSha256, reasonLength}`.
  - Kapsuła dostaje tylko `reasonKind`.
  - `renderAbi` odrzuca `\n` w każdej wartości.

**B6. Koperta 1 MB na cały stdout zabije realną sesję.**
- `outputLimit` obejmuje cały JSONL sesji. Po przekroczeniu sesja jest anulowana, a `usage` przepada [CODE src/hosts/codex.ts:8,226-236].
- Logi naszych sesji Luna S1–S4 mają 0,16–3,9 MB i 91–226 tys. tokenów [OURS-EVIDENCE reports/S*.log]. Że `--json` ma podobny rozmiar: [HYPOTHESIS].
- **Poprawka:** parsowanie JSONL przyrostowe, linia po linii. Zostają tylko `threadId`, ostatnia wiadomość i suma `usage`. Limit dotyczy pojedynczej linii (np. 256 KB), nie sumy.

**B7. Sandbox workera jest niejawny.**
- Host nie podaje `--sandbox` [CODE src/hosts/codex.ts:69-82], a `~/.codex/config.toml` nie ma `sandbox_mode`. Ścieżka worktree rozwiązuje się do `/mnt/storage/…`, poza zaufanym `/home/krn` [OURS-EVIDENCE].
- Efektywny tryb jest nieznany [HYPOTHESIS]:
  - read-only: L1 pada;
  - danger-full-access, w którym działały briefy leada (S4.log: `sandbox: danger-full-access`): worker może pisać poza worktree, a `~/.paperclip/auth.json` istnieje.
- **Poprawka:**
  - `--sandbox workspace-write --add-dir <git-common-dir>`. Commit w linked worktree pisze do `.git` głównego repo.
  - Tryb zapisany w `session_started`.
  - Workspace-write domyślnie odcina sieć, co daje strukturalne „bez zapisów do boardu” z powłoki. MCP `github` zostaje włączony, więc w prompcie potrzebny jest zakaz, a po przebiegu readback.

Każdą poprawkę B1–B7 pokrywa jeden falsyfikator, pokazany najpierw jako czerwony. Wystarczą dwa nowe testy: integracyjny dla B1 i B2 oraz jednostkowy dla B4 i B5. B3, B6 i B7 to wiring sprawdzany sondą. Dalej `npm run gate` na zmergowanym punkcie i judge Luna z poleceniem uruchomienia sondy kompozycyjnej.

## Kontrakt wznowienia: co jest dobrze

- **Intent przed startem:** jest, i to mocniej niż w szkicu. Najpierw `trace.intent`, potem `bindSession` CAS i `trace.started`, a dopiero potem `spawn`, bo `onStarted` biegnie przed spawnem [CODE src/hosts/codex.ts:61-64].
- **Świeże ID sesji:** `randomUUID` per sesja [OURS-EVIDENCE sonda: różne ID].
- **Strażnik CAS:** dwa równoległe `runJob` mogą przejść `recoverLease` w stanie checkpointu, ale wygrywa jeden CAS, a przegrany nie spawnuje [CODE src/relay/capsule-store.ts:206-238].
- **Fencing nieaktualnej sesji:** stary checkpoint dostaje `checkpoint session is stale` [CODE src/relay/index.ts:186]. Fencingu systemu plików nie ma, stąd wagi B1 i B2.
- **Awaria między bind a spawn:** kapsuła `session active` bez `session_ended` daje trwałe `already running`. Ten fail-safe wymaga ręcznej decyzji (nowy `--job`) [CODE src/foreman/session.ts:118-123].
- **Budżet:** `maxResets ≤3` (do 4 sesji) i `maxRepairs ≤2` walidowane [CODE src/foreman/types.ts:120-128]. Naprawy są nieużyte, bo verdict jest wyłączony. Brakuje cooldownu z §4.3.
- **ABI i `krn state check`:** zgodne, gdy `.krn/runs` jest ignorowane (zostają tylko ostrzeżenia). Hook wstrzykuje kapsułę relay, a linia kolejki `krn task next` jest wtedy wyciszona (`has_continuing`). Kanał jest więc jeden [OURS-EVIDENCE: uruchomiony hook; CODE krn_capsule.py:225-235]. Globalny SessionStart ma wpis `trusted_hash` [OURS-EVIDENCE config.toml:815-819].
- **Strażnik `KRN_LIVE`, binarka i Paperclip:**
  - `KRN_LIVE` działa [CODE scripts/live-l1.mjs:8-11].
  - Binarka Codex to absolutna ścieżka daemon 0.160, bez wrapperów `~/.local/bin` [CODE src/hosts/codex.ts:13-16].
  - Kod nie dotyka Paperclip.
  - „Gotowe” zawsze kończy się uczciwym `human_decision`.

## NON-BLOCKING

1. **Kształt kodu (§9).**
   - `run.ts` ma 36 linii, ale limit osiągnięto przez przeniesienie *polityki* (`recoverLease`, `finishSession`) do `session.ts`. Jego nagłówek mówi przy tym o „I/O”.
   - `foreman/types.ts` duplikuje `Capsule/RepoFacts/SessionEnd/Cas/Validation` z `capsule-store.ts`.
   - Barrele i zaślepki `NotImplemented` nadal są (`foreman/index.ts`, martwe `hosts/index.ts`, `ledger`, `verdict`, `memory`): K3, uwaga z G1.
   - `withFindingsCAS` i wrapper `writeCapsule` są nieużywane albo tylko pod testy.
   - Sztuczne `Promise.resolve` na operacjach synchronicznych.
   - `Deps.trace.log` z jednym literałem zdarzenia.
2. **Testy.**
   - `interrupted-resume` fake'uje `relay` i `trace`, które nie są portami (K8). Asercję „akcji” liczy sam fake, a ścieżka CLI z kill nie jest nigdzie testowana. To dokładnie to miejsce, które pada w B1.
   - Test relay ma twardą ścieżkę `/mnt/storage/…/krn-codex-skills/scripts/krn.mjs`, więc pęknie w CI.
3. **`cancelTree` zabija tylko grupę `codex`.** Komendy narzędzi we własnych grupach mogą przeżyć [HYPOTHESIS]. Po L1 trzeba sprawdzić procesy z cwd w worktree.
4. **Trace w worktree.** Worker może go dopisać lub sfałszować. Trace znika z `git worktree remove`, więc przed sprzątaniem trzeba go skopiować.
5. **Dwuetapowy checkpoint nie jest atomowy.** Najpierw kapsuła, potem trace. Przegrany wyścigu zapisuje `failure` pod kluczem intentu zwycięzcy.
6. **Minuty operatora.** `operator_start` przy `krn start` i ręczne `krn stop` mierzą zegar ścienny, nie minuty operatora. Trzeba prowadzić ręczny log.
7. **Budżet dla L1.** `maxResets` jest na sztywno 3. Dla L1 wystarczy 1, co ogranicza zasięg szkody.
8. **Brak remote'u i CI w `krn`** [OURS-EVIDENCE].

## Jakość sędziów Luna (eksperyment Luna-only)

- **Co złapali:** dwa prawdziwe błędy (S3: ID sesji w `Restart state`; S4: dwie równoległe sesje). Rzetelnie sprawdzali literę akceptacji: czerwone/zielone, liczbę linii, gate.
- **Czego nie złapali:** B1–B7. Żaden sędzia nie złożył prawdziwej kompozycji ani nie przetestował przerwania czy sygnałów. J-S2 zatwierdził limit 1 MB bez skonfrontowania go z rozmiarem realnej sesji. J-S1 nie miał dostępu do blueprintu, więc §9 nie oceniono.
- **Sygnał:** Luna jest dobrym audytorem akceptacji i słabym adwersarialnym integratorem.
- **Rekomendacja:** briefy sędziów dostają obowiązkową sondę „prawdziwe moduły + fałszywy plik wykonywalny + sygnał”. Bramki G zostają przy Opusie.

## Procedura L1 dla leada (po merge B1–B7)

**Warunki wstępne (wszystkie muszą być spełnione):**
1. **B0:** `krn/evals/journeys/j1-baseline.json`, `n=3`, zadania klasy J1, z etykietami. Lead robi readback i zapisuje go w `reports/L1-run.md`. Dziś pliku nie ma [OURS-EVIDENCE].
2. **Naprawy:** B1–B7 zmergowane, `npm run gate` zielony na fixed poincie, sonda B1 czerwona→zielona, raport sędziego.
3. **Wybór issue:**
   - repo: `krn-codex-skills` albo `frontend-system` (oba mają `main` i ignorują `.krn/runs`) [OURS-EVIDENCE];
   - realne issue Paperclip z dwoma rozdzielnymi krokami A i B; każdy kończy się commitem i deterministycznym checkiem;
   - około 20 minut Luny;
   - rewizja kontraktu (`updatedAt` issue) z GET-a tylko do odczytu.
4. **Repo docelowe:** główny checkout czysty, na `main` równym `origin/main`; zapisać SHA.
5. **Snapshot Paperclip (tylko odczyt):** status, assignee, `updatedAt`, liczba aktywności. Do tego `git -C <repo> ls-remote origin`.
6. **Brak innych przebiegów:** `pgrep -af 'codex exec'` jest puste i nie trwa żaden inny live run.
7. **Pomiar:** ręczny log minut operatora (start/stop przy każdym dotknięciu) i licznik promptów rekonstrukcyjnych.

**Przebieg:**
1. Uruchomienie:
   ```
   cd ~/coding/krn/active/krn && KRN_LIVE=1 mise exec node@24.21.0 -- npm run live -- \
     --repo <abs> --job L1-<ID> --issue <ID> --revision <rev> --prompt "<P>"
   ```
2. Prompt `<P>`:
   - cel issue;
   - „Krok A, commit `step A`, potem uruchom komendę checkpoint z `--next 'krok B: …'` i zakończ turę”;
   - „Jeśli następna akcja to krok B, wykonaj tylko B, commit, `<check>`, koniec”;
   - „Nie pushuj, nie twórz PR, nie dotykaj Paperclip ani GitHub”.
3. W drugim terminalu obserwacja:
   - `tail -f <wt>/.krn/runs/foreman/L1-<ID>.jsonl`. Oczekiwana kolejność: intent → `session_started`(S1) → `checkpoint`(S1) → `session_ended`(S1) → intent → `session_started`(S2≠S1) → `session_ended`(S2);
   - `watch -n5 'pgrep -af "codex exec"'`: najwyżej jeden proces naraz.
4. Wariant mocniejszy (opcjonalny, wymaga B3): po zdarzeniu `checkpoint` wysłać `SIGTERM` do foremana, sprawdzić, że `codex` nie żyje, i wznowić przez `--worktree <wt>`.

**Readback po przebiegu:**
- Outcome to `human_decision: S5/S6 verdict path is not enabled`.
- `git -C <wt> log --format='%h %s %cI'`: dokładnie jeden commit A (przed checkpointem) i jeden B (po starcie S2).
- `node ~/coding/krn/active/krn-codex-skills/scripts/krn.mjs state check --root <wt> --json` bez błędów.
- Paperclip, `ls-remote` i status głównego checkoutu są identyczne jak przed przebiegiem.
- Żaden proces nie ma cwd w `<wt>`.
- Tokeny: `usage` z obu `session_ended`.
- Zapis w `reports/L1-run.md`:
  - minuty: ścienne i operatora;
  - czas do pierwszej użytecznej akcji S2 (od startu S2 do commita B);
  - prompty rekonstrukcyjne (cel: 0);
  - ograniczenia: `n=1`, pilot, checkpoint wyreżyserowany, verdict wyłączony.
- Plik dowodowy w repo powstaje przez PR workera Luna.
- Na koniec `node src/cli/main.ts stop …`, skopiowanie trace i kapsuły, `git worktree remove`.

**Kryteria przerwania:**
- jakakolwiek zmiana w Paperclip, remote albo poza `<wt>`;
- dwa żywe procesy `codex`;
- więcej niż 1 checkpoint;
- S1 trwa >15 min bez checkpointu;
- outcome: `already running`, `HEAD changed` albo `worker or trace failure`.

Sposób przerwania:
1. `SIGTERM` do foremana.
2. Weryfikacja przez `pgrep`; w razie potrzeby `kill -TERM -<pgid>` z `session_started`.
3. Worktree zostaje do analizy, a ten `--job` nie jest używany ponownie.
4. Wynik zapisuję jako negatywny dowód L1. Najwyżej jedna ponowna próba po nazwanej poprawce.
