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
   wystąpi ≥1 uciekający defekt P0/P1. Klauzula interwencji jest oceniana tylko, gdy B0 `lead_interventions` > 0; przy zerowej
   bazie raportuje się ją jako `not-evaluable` (bez PASS/FAIL), a D1 rozstrzygają pozostałe klauzule. Minuty operatora pozostają
   metryką pomocniczą. Baseline B0 trzeba przeliczyć (R1-06).
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

## Operator batch02 (2026-10-15, LON-275)

[POLICY] Supervised bounded checkpoint recovery is authorized directly to the batch02 lead: one branch/worktree,
implementation/tests, commits, push and one PR. No merge or author `krn/judge-*` publication; independent review is
performed in a second instance. Full R1, live model sessions, external submission, host/CLI changes and other defects
remain outside this grant. The operator prompt takes precedence over the Full R1 authorship route for this batch.

[CODE] P-017 implements this contract through an optional authoritative pending checkpoint containing the exact prepared
Git SHA, parent, intent and capsule epoch. The capsule/session/request and repository anchors must agree before HEAD
publication or reconciliation. The existing capsule history and projection limits apply to the complete transition before
HEAD changes. Legacy ambiguous HEAD remains fail-closed. A recovered `done` still runs deterministic verification;
`continue` reaches the next worker action only after reconciliation. Source: checkpoint/relay implementation and the
assertion-based disk/Git tests in `test/foreman/interrupted-resume.test.ts`.

## Operator-approved A′ — LON-277 (2026-10-16)

[POLICY] The operator approved A′ for implementation and test/documentation work only. This records scope, not code acceptance, review, merge, or access to secret values. The bounded checkpoint tripwire is not a TypeScript parser or complete DLP system.

[CODE] C1 recognizes the published finite explicit credential-marker families anywhere in a file, independent of source context. C2 recognizes nonempty URI userinfo and nonempty credential-named query parameters while allowing ordinary hosts, ports, paths, versions, and metadata. C1 matching and C2 URI extraction must make monotonic, linear progress; do not add marker-value allowlists, context exemptions, metadata exceptions, generic entropy checks, or dependencies.

[CODE] C3 is a bounded lexical heuristic for `password`, `secret`, `api[_-]?key`, and `access[_-]?token`: locate recognized `:`/`=` bindings or `.default(`/`.catch(` values within 80 characters on the same line; inspect every qualifying literal, each at most 256 characters. A qualifying literal is static, one token, non-whitespace, and at least six characters; digits are not required. Comparisons and `.describe` are not bindings. If a qualifying value cannot be resolved within the literal cap, refuse with a distinct analysis-limit reason. No full-language or semantic guarantee is claimed.

[CODE] C4 deliberately retains the existing unquoted `secretPattern` guard. It can refuse nonsecret references such as `password: PasswordInput`; this remains documented compatibility debt, not evidence that a secret exists.

[POLICY] Exactly five existing test outcomes are authorized to change: (1) nonsensitive `.default('hunter2')`, (2) nonsensitive `.default('hunter2-secret')`, (3) nonsensitive `.catch('hunter2-secret')`, and (4) nonsensitive `.describe('hunter2-secret')` now pass, each paired with refusal when a real synthetic C1 marker occupies the same form; (5) `password` default `guest` followed by `.catch('fallback')` now refuses because the later eight-character fallback qualifies, paired with acceptance when that fallback is short. Other existing outcomes remain unchanged unless separately authorized.

[POLICY] Differential proof compares only production C1 and C2 results against the frozen b954 SHA `b954079dc377010ad7e8d3736b81aa6d31ed2c9a` on deterministic short inputs (about 200 characters maximum) covering marker families, boundaries, separators, and URI cases. Long/adversarial inputs never reach the old oracle. Any C1/C2 discrepancy outside this contract requires returning to the operator; a different component may not mask a lost result.

## Operator-approved LON-278 — startup lease handback (2026-10-16)

[POLICY] The operator authorizes the bounded startup-handback implementation, focused tests and scope documentation. This is not code acceptance, review, full-R1 qualification, unattended confinement, installation authority or a general W2b crash-recovery decision. Do not wire live-l1 scope inference in this slice.

[CODE] After CodexHost verifies cancellation of the exact owned process for an onStarted rejection or false result, an optional post-cancellation acknowledgement may let foreman release only the successfully bound active capsule lease. The relay transition must CAS the bound epoch and session identity, change only lease/session identity plus epoch, preserve all other capsule fields, and fail closed on cleanup or CAS errors. No acknowledgement follows unverified cleanup; ordinary successful starts are unchanged.

[POLICY] Once an accepted-contract candidate passes all required exact-head gates, the lead merges without procedural reapproval. Stop and return for changed scope or rights, or missing required proof. This is a conditional integration mandate, not code approval or a waiver of independent exact-head review, CI, or main-CI readback.

## Operator-approved LON-283 — registered startup scope (2026-10-17)

[POLICY] This is scope authorization only: add bounded positive systemd registration before the existing startup callback, persist validated evidence, fail closed for legacy/missing/malformed evidence on the existing inactive-scope recovery path, and wire the real live-l1 observer only behind that evidence. This is not code acceptance, a new generic recovery method, unattended confinement, or full-R1 authority.

[CODE] A registration witness identifies the generated job/session unit, its validated cgroup path, and a process PID/start-time identity observed live in that cgroup before callback/prompt eligibility. Host commands derive the unit from trusted job/session inputs; witness text is not command authority.

[POLICY] Legacy or invalid proof remains `already running`; a positive witness may gate only the existing known-inactive scope recovery. W2b and broader crash recovery remain deferred. Pending-launch cancellation must terminate the exact owned launcher safely and verify closure plus exact-unit drain before acknowledging cleanup. Preserve PR58 bind-before-trace startup lease handback.

## Operator-approved LON-284 — trusted evaluator tool selection (2026-10-17)

[POLICY] The immutable trusted base selects the host package-manager executable and host-side store probe. Candidate package manifests, lockfiles, and application dependencies remain the inputs installed and checked inside the sandbox: do not substitute base dependencies or blanket-refuse manifest changes. Preserve the accepted LON-219/PR44 script, registry, protected-surface, regular-file, size, teardown, and honest-source controls.

[POLICY] This is a bounded host tool-authority correction, not evidence that mise installs tools or that a pnpm exploit has run. Broader provenance security, provider trials, generic W2b recovery, CI changes, and global tool configuration are excluded. Scope acceptance does not approve unimplemented B runtime code or constitute Full R1 execution.

[CODE] The bounded implementation was accepted and merged as PR #60. This status does not relabel or replace the original proof record.

## LON-286 — neutral host pnpm store discovery (2026-10-17)

[POLICY] This bounded continuation of LON-284 isolates the immutable-base-selected pnpm host store query from mutable repository workspace configuration using a fresh owned standalone probe under validated repository state/tmp parents. Candidate workspace manifests, package manifests, lockfiles, and application dependencies remain legitimate sandboxed inputs; do not blanket-refuse workspace changes, replace candidate dependencies, or overlay candidate files. Preserve LON-219/PR44 script, registry, protected-surface, regular-file, size, teardown, and honest-source controls.

[POLICY] The synthetic owned-canary observer establishes the targeted boundary only. It does not claim a real host-home/credential exploit, universal hostile-process qualification, Full R1 execution, or acceptance of the implementation. Production changes remain pending public assertion RED and subsequent proof.

[CODE] The bounded implementation was accepted and merged as PR #61. This status does not relabel or replace the original proof record.

## Operator-approved S1 — foreman abort fencing (2026-10-18, LON-287)

[POLICY] This records accepted S1 source scope, not implementation acceptance, review, or unconditional merge approval. The previously authorized conditional integration/publication mandate remains subject to all required exact-head proof; this source author does not exercise publication authority. This does not grant Full R1 qualification, provider access, host/relay/trace API changes, or generic checkpoint recovery. Implementation acceptance and final review remain pending.

[CODE] The S1 implementation was accepted and merged as PR #62. This status does not relabel or replace the original proof record.

[EMPIRICAL] On unchanged head `cc355e70dbbbdc317b75e5bc2466d2eacda4cbe5`, the named microtask-race test failed with one assertion and zero isolation skips: `relay.checkpoint` was entered after abort, HEAD changed, the lease remained checkpointed, and dirty work disappeared.

[CODE] Once abort is observed, do not create a new intent, start another session, or enter a new checkpoint transaction. If a durable pending checkpoint exists at entry, finish its existing owned recovery path consistently before stopping. A checkpoint transaction entered before abort may finish its prepared-object/CAS/publish/record path, but must not start the next worker. Preserve dirty work and truthful lease/fact recording when stopping before checkpoint entry; do not create a commit to make the stop appear clean.

[CODE] The reproduced gap is after the asynchronous checkpoint-request wrapper checks abort and before `finishCheckpoint` resumes to prepare a fresh commit. The sole bounded source-boundary exception is a synchronous `AbortBeforeCheckpoint` guard in `src/foreman/checkpoint.ts` immediately before `prepareCheckpoint` in the no-pending branch; `src/foreman/session.ts` routes that sentinel through existing `finishSession` fact/CAS handling. Existing pending-checkpoint recovery and already-entered transaction paths remain unguarded and unchanged.

[CODE] Foreman owns cancellation for a running session and must await physical cleanup/error evidence before returning a normal stopped outcome. During asynchronous `onStarted` binding/trace work, abort must make the prompt ineligible and preserve binding-before-trace plus the existing post-cleanup CAS lease handback. Cleanup uncertainty, trace errors, and CAS conflicts remain observable failures, never clean stopped acknowledgements. CodexHost's maintained cancellation owner remains authoritative; do not add a second process controller.

[CODE] The public proof seam is `runJob`, using existing disk/Git checkpoint, relay, trace, host-ownership, and fixture helpers where relevant. Keep non-abort, ordinary startup, cleanup/CAS, dirty-state, and interrupted-checkpoint controls meaningful. No provider calls, board writes, generic W2b recovery, CLI-stop annotation expansion, or host/relay/trace API changes are included. No checkpoint API or recovery method is added; the synchronous fresh-entry guard above is the only checkpoint-source exception.

## Operator-authorized LON-289 — strict host test evidence (2026-10-18)

[POLICY] This authorization is limited to the local host gate. Strict test mode, pinned to the repository `.node-version`, succeeds only when the explicit file selection or complete project test glob is nonempty, every selected file has real native declared-test evidence, and all tests pass with no skip, todo, cancellation, failure, or incomplete/malformed evidence. The strict child boundary removes inherited `NODE_OPTIONS` and `NODE_TEST_*` variables. Ordinary non-strict CI behavior and existing isolation-capability handling remain unchanged.

[CODE] A native event reporter records only bounded test event fields under an owned `.krn/tmp` directory; it does not patch Node internals. A version-1 `KRN_TEST_SUMMARY_JSON` contains `success`, global `counts` (`tests`, `passed`, `failed`, `skipped`, `todo`, `cancelled`), and matching per-file counts. Counts must cohere, and every selected file must show positive real declared-test coverage. The local status publisher requires the last structured summary to validate, clean tracked and nonignored untracked state both before and after the gate, and unchanged HEAD. It retains the existing `N tests, 0 isolation skips` description. The publisher removes `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, and `GIT_OBJECT_DIRECTORY` from its Git-check, gate, and status child processes so they inspect and publish for the checkout at `cwd`.

[EMPIRICAL] The lead reproduced round-two G1 at both base and candidate: inherited Git context could make a dirty actual checkout pass the clean check and publish against a clean foreign repository. Although the inheritance mechanism existed at base, it blocks this slice's new actual-checkout clean-HEAD guarantee.

[POLICY] The prior Git-context residual deferral is reversed based on the round-two Adversarial FAIL and lead reproduction. This is the final authorized repair round: one post-review runtime repair preceded it; any fresh full-panel FAIL blocks the task with no override or further repair.

[CODE] Strictness is per wrapper invocation. Strict mode always refuses `KRN_SCOPE_PROBE=1`, regardless of inherited `NODE_TEST_CONTEXT`, emits failed structured evidence, and does not pass the strict flag to test processes. In non-strict mode only, `KRN_SCOPE_PROBE=1` with inherited `NODE_TEST_CONTEXT` performs discovery only: it emits sorted absolute project test paths as `KRN_DISCOVERED` JSON, runs no tests, and emits no test-success summary. Discovery anchors at `realpath(cwd)/test`, which must be a real nonsymlink directory; all resolved discovered files must remain inside it. Tests remain cooperative same-UID evidence; this design does not claim protection from a deliberate same-UID event or summary forger.

[POLICY] LON-264's CI-mode skip-authenticity residual remains open. This work does not change CI authenticity, evaluator isolation, hosts, or broader delivery architecture. LON-288 remains the orchestration mandate: lead-owned proof and publication, independent exact-head review and required CI remain binding; this authorization gives the source author no publication authority.

[EMPIRICAL] INITIAL/HISTORICAL RED: at unchanged production base `73d5141e312b5af1ce05679c356924afb1771977`, `src` tree `cb8bd012e75cbd261922c764b070f87c578e6f69` was paired with original base `test` tree `ad01c24a371d55c3c7e55edf8eb61a638bf11c3f`; the exercised initial candidate used `test` tree `f48d9982b750b62f60c3cb089864ebccb19f7ec8` containing exact test blob `fc5e921090df35e1d6187192d77aafa62f189c04`. Its assertion transcript recorded 25 tests including three group parents, 23 failures, two passing controls, and zero isolation skips. Lead-verified archive: `.krn/tmp/continuous-delivery/s4/red-final-tests.log` and `.krn/tmp/continuous-delivery/s4/red-final-receipt.json`. These actual assertion failures with passing controls are RED evidence, distinct from mechanical or setup-failure red-first runs. This INITIAL/HISTORICAL RED does not establish GREEN or implementation acceptance.

[POLICY] D7 — general lead-owned host RED/GREEN proof rule for authorized implementation slices. The lead binds assertion-based RED on the unchanged base and GREEN on the exact implementation head to their respective `src` and `test` tree identities. Actual assertion RED with passing controls at the unchanged, tree-bound base is valid RED evidence; mechanical or invalid red-first runs (including setup failures, missing imports, or changed/unbound trees) are not. A nonpassing implementation head is not GREEN. Independent judges assess the actual transcripts; the lead does not self-judge. D7 classifies proof evidence only: it does not change the flow classifier, weaken existing controls, or replace required exact-head gates, reviews, or CI.

## Operator-authorized LON-289 extra startup-signal repair (2026-10-18)

[POLICY] The operator grants exactly one additional bounded startup-signal repair after the standing two-round limit was exhausted. This exception supersedes only the prior LON-289 stop for this one repair; it does not amend the standing repair limit, waive independent review, or override any FAIL. Two post-review runtime repairs preceded this extra round. Any fresh full-panel FAIL blocks the task, with no further repair or override.

[CODE] The scoped startup repair installs SIGINT/SIGTERM handlers before awaited setup can create reporter state. If cancellation is observed before runner spawn, it skips the runner, cleans owned event state, emits failed structured evidence, and returns 130/143 after cleanup; cleanup uncertainty remains nonzero.

[EMPIRICAL] Historical status at authorization: GREEN proof and fresh full review were pending. Subsequent disposition: PR #63 was accepted and merged; base `73d5141e312b5af1ce05679c356924afb1771977`, reviewed head `5ce4f47d6e8bfc313998b2b2bf5834a30674a3b3`, merge commit `8d93337cb1a95870ba3bd76e33eb80fcc2afe969`; host evidence `404/404`; complete fresh panel PASS; exact-head CI run `39131532969` and main CI run `39132604787` both SUCCESS. These records do not replace the original historical RED evidence.

## LON-290 — S2 delivery metadata (2026-10-18)

[POLICY] The bounded S2 scope derives checkpoint `Ticket` and `R1-task` trailers only from the accepted Paperclip contract, refuses duplicate or malformed task declarations before relay/trace/host/projection writes, and admits PR descriptions through the existing Paperclip issue transport without imposing the execution contract's 8-KiB or `krn-contract` requirements. The execution contract's existing size limit remains unchanged. No host, core, relay, trace, session, ledger API, or publication behavior is expanded.

[POLICY] PR admission accepts either zero `R1-task` lines in both the Paperclip description and commit trailers, or one valid declaration paired with exactly one equal trailer. An extra trailer when the description omits the field, a missing trailer when it is declared, duplicates, malformed lines, and mismatches remain refusals. Delivery `Ticket` identifiers use a positive decimal suffix with no leading zero; PR titles remain LON-specific.

[CODE] The ledger owns the shared delivery-ticket and R1-task grammar used by foreman and preflight. Optional final checkpoint metadata parameters preserve existing callers; pending recovery uses the same accepted metadata and exact prepared-body verification. Pre-S2 prepared commits are never reconstructed or rewritten: matching identifiers can cause exact-body recovery to refuse, so run only with no live pending checkpoint (the supervised trial uses a fresh clone).

[EMPIRICAL] Historical final RED-stage observation: the lead verified assertion RED on unchanged production base `8d93337`, source tree `cb8bd012e75cbd261922c764b070f87c578e6f69`, and frozen test tree `63aeccba864a936bad2d63ef2d70567c6a9d0043`: 22 tests, 14 pass and 8 fail, with zero skips, todos, or cancellations; typecheck passed. The six intended leaf assertions and two failing parents are distinct from the fourteen passing controls, including the short default-transport and foreign-identity controls. Receipt: `.krn/tmp/continuous-delivery/s2/red-final-receipt.json`.

[EMPIRICAL] The lead reports focused GREEN on working-candidate source tree `a1ea557474cd30a4cffe300bdc3654135e4f345c` with frozen test tree `63aeccba864a936bad2d63ef2d70567c6a9d0043`: 22/22 passed, zero failed/skipped/todo/cancelled, typecheck exit 0. This focused run was against the working candidate, not the committed base. It does not replace the required exact-head full gate, independent review, or CI; LON-290/PR records own the implementation disposition.

## LON-291 repair2 — trace outcome integrity (2026-10-18)

[POLICY] Under the LON-288 continuous-delivery mandate, the root authorizes one bounded repair of findings A-D from the failed LON-291 panel. The competing `trace.started()` session-row result must first be tested with one deterministic two-process observer on both unchanged base `35225b773d8c2425bc5e003d89208eabefdbcc8c` and candidate `8798ea154ea3030b52b5ca3dca096a640e0d9099`; if both fail by the same behavioral assertion, record it as a pre-existing prerequisite without attributing it to S3a. The source author has no review or publication authority.

[EMPIRICAL] The frozen observer `test/trace/index.test.ts` blob `fa5485f4c40a9137a27d3a98c58f1183881a61e8` failed the same assertion on base `35225b` (`src` tree `c5249e957e66d373878ca2f6d9dae04ced84386a`) and candidate `8798ea1` (`src` tree `628e80855facce5213abd8b2031195cb71d30917`): two independent callers returned accepted although only one immutable `session_started` row existed. Receipts: `.krn/tmp/continuous-delivery/s3a/repair2/proof/red-session-start-35225.log` and `.krn/tmp/continuous-delivery/s3a/repair2/proof/red-8798-frozen-with-scratch.log`. This is a pre-existing trace-integrity prerequisite for downstream consumers, not a newly introduced S3a regression.

[CODE] Safe error-type reporting is shared by trace persistence and live CLI JSON; trace lock liveness recognizes a verified zombie as dead while unreadable identity remains unknown; session-start acceptance follows the immutable row that won deduplication; setup cancellation awaits actual owned stop settlement. Stateful `krn start` is not interrupted by the live signal controller.

[POLICY] Repeated-signal hard exit is rejected. Signal handling stays with the idempotent cleanup owner so the runner cannot bypass physical `host.cancelAll()` verification. No forced termination, session/checkpoint change, or additional cleanup owner is authorized. This records scope and disposition only; implementation, proof, review, gates, and publication remain pending.

## LON-291 repair3 — truthful cancellation and runner outcomes (2026-10-18)

[POLICY] The operator grants exactly one additional bounded author repair after the standing two rounds were exhausted. The root expanded this same exception once, after readback of new empirical cancellation findings, to cover the reproduced falsy `runJob` rejection result, fresh-clone `live/outcome` fixture setup failure, Paperclip setup cancellation verification propagation, and Codex internal timeout cancellation settlement. Prior FAIL records remain active; this is not a verdict override, review grant, publication grant, or another routine repair round. No further author repair is authorized under this exception.

[EMPIRICAL] A registered Paperclip systemd scope whose `systemctl show` verification failed during setup SIGTERM was physically cleaned afterward, but `live-l1` emitted the same `stopped`/exit-130/error-null result as its no-fault control. The transport’s swallowed `cancelAll()` rejection is pre-existing; the candidate’s structured false-success result is not. `cancelAll()` must await its active-call snapshot and surface distinct physical-verification failures, including a failure whose call left the active set before aggregation. Ordinary abort remains nonfatal, and verified no-fault setup SIGTERM remains stopped/130.

[EMPIRICAL] A registered Codex scope with a post-registration `systemctl show` fault caused `session.wait()` to reject while detached timeout cancellation also raised an uncaught `AggregateError` on both candidate and base. Internal cancellation errors must be handled and joined into the existing `wait()` result even when the cancellation promise settles before close. The explicit external `cancelTree()` call must continue to reject when cleanup verification fails.

[CODE] A caught `runJob` rejection is a failure regardless of the rejection value, including `false`, `null`, `undefined`, `0`, and the empty string. The live CLI and durable outcome use the rejection state to report exit 1 and `runjob-error`, while the existing `runJob` rejection contract and verified normal completion remain unchanged. The live outcome fixture creates its `.krn/tmp` parent before `mkdtemp`, so the canonical project runner works in a fresh clone with no pre-seeded ignored state.

[POLICY] The supported supervised trial claim remains the default `systemd_scope` backend with deliberate SIGTERM. Automatic recovery after SIGKILL or orphan-lock reclamation is not claimed; bounded fail-closed refusal requires manual disposition. Namespace cleanup hazards remain owned by LON-288 for separate verification and repair. No claim is made that every backend cleanup path is bounded, and repeated-signal hard exit remains rejected pending physical cleanup verification.

## LON-291 trace durability prerequisite (2026-10-19)

[POLICY] The repair3 exception remains exhausted and continues to authorize no further work under that exception. The root records a conflict between that limit and the existing LON-288 continuous-delivery mandate plus the user's earlier quoted instruction, “masz jak co na wszystko zgodę”. Interpreting that existing higher-priority mandate, the root authorizes exactly one bounded source completion of the original trace append/dedup/fsync contract for this empirically confirmed prerequisite. This is a lead interpretation of existing authority, not a new operator reply, a FAIL override, or blanket/unlimited repair authority. The author still has no review or publication authority.

[EMPIRICAL] Independent exact-fd, two-process fsync-fault probes reproduced same-session `trace.started()` acceptance before the owning append's fsync result on candidate `66d625d0d686fd9ccd246d3a0785be3785132569` and original base `35225b773d8c2425bc5e003d89208eabefdbcc8c`. On 66 the other-session append waited on the owned lock; the duplicate-session read bypassed it. The behavior predates this candidate and leaves the accepted durability contract incomplete. Receipt: `.krn/tmp/continuous-delivery/s3a/verification-lock-durability/REPORT.md` and `logs/summary.json`.

[POLICY] One bounded fix may move `started()` duplicate acceptance under its existing owned append lock and require fsync of the exact existing trace before accepting its immutable matching row, including a row left visible by a prior writer's fsync error or death. Preserve registration/session matching, error behavior, path safety, bounded lock refusal, and all existing append callers. Scope is limited to `src/trace/index.ts`, its existing `test/trace/index.test.ts`, and this disposition. Do not change session/checkpoint flow, host adapters, public API, state ownership, namespace or submit behavior. Preserve previous FAIL findings. Completion still requires frozen assertion RED on unchanged 66 (and original-base comparison), same-observer GREEN, cleanup readback, and one final full gate; no self-review or publication.

## LON-291 final59 bounded error-conversion correction (2026-10-19)

[POLICY] The previous repair limits and FAIL findings remain in force. The root records the conflict between the exhausted repair limits and the existing user mandate to continue scoped delivery through completion. Interpreting that existing mandate, rather than claiming a new operator reply or a general waiver, the root authorizes exactly one bounded correction to the accepted durable error-outcome contract after the complete final59 panel returned FAIL. This grants no review, publication, gate-status, or further repair authority.

[EMPIRICAL] Standards, Spec, and Adversarial sessions `21369df2-1d01-4bb2-a74e-6c1389294da0`, `d5052bb6-35e4-48ba-f88f-3cf8c6e48a30`, and `fd77ae8d-f93b-4fcd-847a-42c94f632e73` independently identified unguarded error inspection/coercion in `boundedError`: an unprintable rejection such as `Object.create(null)` can throw before the required `job_outcome` row is appended. Exact review evidence is retained in `.krn/tmp/continuous-delivery/s3a/review-final59/`.

[CODE] The correction is limited to guarded bounded error conversion in `src/trace/index.ts` and one focused observer in `test/trace/index.test.ts`. Ordinary Error messages and the existing fixed type allowlist remain; arbitrary objects are not stringified; inspection, coercion, or normalization failures yield a fixed safe fallback, while existing credential redaction remains active. The frozen observer must assert RED at unchanged `59ff579c0d2ff98b702ca4533f3f0dfaf54c0a86` and GREEN with the same test tree after correction.

[POLICY] The independent strict owner-publication unsafe-path failure and waiter rejection remain unknown and root-owned. This correction does not repair or dismiss them; no full gate or publication is claimed here. Fresh independent review and the required final gates remain pending.

## LON-291 lock-disappearance correction (2026-10-19)

[POLICY] The earlier repair limits and exceptions are consumed and prior FAIL findings remain active. The root records the conflict and interprets the existing user mandate for continuous scoped completion to authorize exactly one separate bounded correction of the accepted concurrent-append contract. This is not a new operator reply, general repair waiver, Opus approval, or FAIL override. The source author has no review or publication authority.

[EMPIRICAL] The deterministic real two-process observer reproduced a lock-owner unlink race on both candidate `59ff579c0d2ff98b702ca4533f3f0dfaf54c0a86` and `66d625d0d686fd9ccd246d3a0785be3785132569`: contender B opened the existing primary lock read-only with no-follow/nonblocking flags and matching dev/inode, then owner A completed real trace fsync and its normal token/inode-checked unlink. B's same fd then had link count zero and the exact expected `/proc` deleted-path suffix; the unchanged code rejected `verdict()` as unsafe. This mechanism predates the candidate delta. Its causal relation to the historical strict-gate failure remains unproven. Evidence: `.krn/tmp/continuous-delivery/s3a/strict-publication-diagnosis/deterministic/recovery/REPORT.md` and `receipt.json`.

[CODE] The correction is limited to `src/trace/index.ts` and one deterministic public-API two-process falsifier in `test/trace/index.test.ts`. Only a read-only primary-lock observation with the exact expected path (or exact deleted suffix) and a regular open fd proven by `fstat` to have link count zero is classified as a transient unlink; only `readTraceLockOwner` consumes this private state. The existing bounded acquisition loop then retries. Trace files, unavailable procfs, wrong paths, symlinks, hardlinks, nonregular files, and all other mismatches retain fail-closed behavior. No public API, framework, dependency, host, live, session/checkpoint, namespace, or orphan-recovery changes are authorized.

[POLICY] Opus returned only a quota/session-limit error for a targeted design call; no review or advice was obtained. Frozen assertion RED on unchanged `c83e80eed372a76a95a6a52068889989f8524407`, same-observer GREEN, local commit, and one final full gate are required. Fresh independent review, strict local gate, CI, and publication remain pending; the source author may not self-review or publish.

## LON-291 error snapshot and lock-observer coverage (2026-10-19)

[POLICY] The prior repair limits remain consumed and prior FAIL findings remain binding. The root interprets the existing continuous-completion mandate to authorize a narrow bounded completion of the accepted durable error-outcome contract and coverage of the already-shipped lock-disappearance behavior. This is not a new operator reply, general waiver, or review/publication grant.

[CODE] Snapshot `Error.message` exactly once before type checking and normalization so a changing getter cannot substitute unscanned text. Keep the existing safe type allowlist, ordinary message behavior, credential redaction, and bounded fallback. The public lock observer table covers both verified unlink timings and preserves refusal for hardlink, symlink replacement, and non-suffix rename. This slice does not change lock runtime.

[POLICY] The author must retain the frozen assertion RED on unchanged b6, identical GREEN after the source correction, the real lock-fd and child-identity receipts, and a local commit. Independent review and required gates remain separate; the author has no self-review or publication authority.

## LON-291 stale-reclaimer EEXIST correction (2026-10-19)

[POLICY] The previous bounded interpretations and repair limits remain consumed; earlier FAIL findings remain binding. After empirical confirmation of the same loss race on b6 and its immediate parent, the root interprets the existing continuous-completion mandate to authorize exactly one narrow stale-reclaimer correction. This is not a new operator reply, general repair waiver, review grant, or publication grant.

[EMPIRICAL] The frozen public two-process falsifier uses a real stale-owner process whose PID and start ticks are sampled while live and verified gone before the lock record is written. B observes the reclaimer absent and pauses. A removes the verified stale primary lock under its own reclaimer and pauses after observing absence. B then performs a real O_EXCL primary-lock create and pauses before fsync; A's primary create receives real EEXIST. Unchanged b6 rejects A and leaves only B's row. The race also occurred on the direct parent, so it predates b6. Evidence is retained under `.krn/tmp/continuous-delivery/s3a/reclaimer-completion/`.

[CODE] Only `EEXIST` from the primary-lock create after the stale-owner absence check is retried. The existing reclaimer is released in its existing `finally`, then the existing bounded loop proceeds. Other create errors propagate, and the stale-owner identity comparison, reclaimer ownership checks, path validation, and lock safety controls remain unchanged.

[POLICY] Require the same frozen assertion observer to fail on unchanged b6 and pass after this correction, with both public verdict calls resolving, both immutable rows durable, actual PIDs quiescent, and both lock paths absent. Run one full repository gate after all focused proof and local commits. Independent review and publication remain separate; the author may not self-review or publish.

## LON-292 S3b repair1 outcome correlation and usage integrity (2026-10-19)

[POLICY] After the first complete S3b panel returned FAIL and independent public-producer falsifiers confirmed the gaps, the root interprets the existing continuous-completion mandate to authorize one bounded repair round, first of at most two post-review repairs. This is not a new operator reply, a general repair waiver, an override of any FAIL, or authority to review, publish, submit, or activate a trial. The accepted change is limited to the existing trace/evaluator/CLI seams, their focused tests, and this disposition.

[CODE] Correlate each session with the first later job outcome, select the latest supported stop before the final completed outcome, and require a started-and-ended session from that stop's own run. Supported producer stops remain SIGINT/SIGTERM/SIGHUP with exit 130 or wall-timeout with exit 124. Preserve the recorded signal, reason kind, nullable session exit, and process result; do not invent an `interrupted` reason or require session exit 130. Durable done checkpoint plus commit and a verified completed/0/null job outcome establish completion independently of the host process exit. A cleanup-unconfirmed event/outcome or intent/session/checkpoint/commit activity after the final outcome is a typed refusal; a delayed operator-window close remains allowed.

[CODE] A stopped run, unended session, incomplete/invalid observation, saturated counter, per-session total overflow, or aggregate overflow never contributes a known total. Preserve each session's safely representable observed token/turn counters; keep an exact representable aggregate, including zero, only when every started session has a complete valid observation and every session total and aggregate fit safely. On overflow, return null with a bounded reason and affected session IDs; never clamp. Compare commit and HEAD SHA values case-insensitively while preserving observed spelling. Existing null-HEAD refusal and closed-window counting semantics remain.

[CODE] If the per-job `repo.json` exists, read it via the existing verified no-follow trace boundary, validate canonical anchors, confirm its worktree appears in the explicit repository's read-only `git worktree list`, and read job HEAD/status through an opened read-only directory descriptor. Invalid, foreign, or symlinked descriptors refuse. If no descriptor exists, use only the explicit `--repo` context. Do not create descriptors, rediscover with `repoRecord`, update the index, import relay, or write repository state.

[POLICY] This is not a claim of an actual model journey or supervised trial. The current accepted operating boundary remains default `systemd_scope` with deliberate SIGTERM supervision; automatic SIGKILL, orphan-reclaim recovery, `--submit`, Full R1, and unattended support remain unclaimed. Preserve all earlier FAIL records. Completion requires frozen assertion RED/GREEN, one full gate at a committed fixed point, independent review, and root-owned lifecycle disposition.

## LON-292 S3b repair2 snapshot and Git read boundaries (2026-10-19)

[POLICY] The root authorized exactly the second and final bounded S3b source repair under the existing LON-288 completion mandate. This records scope only; it is not a new operator reply, a FAIL override, implementation acceptance, review authority, publication authority, or a third-repair waiver. Preserve the b5, 163, and f8 evidence and all prior review dispositions.

[CODE] In both raw-trace and descriptor-backed reporting, require `--repo` to resolve to its canonical Git top level. Verify the common Git directory, confirm the descriptor worktree belongs to that shared repository, and keep later worktree queries bound to the verified Git directory and opened worktree. Refuse configured clean or process filters before dirty-state collection; never report an unverified dirty state.

[CODE] Treat `reason: cleanup-unconfirmed` as cleanup uncertainty on every outcome even if its cleanup field says verified. If any `session_started` row is malformed, keep valid per-session observations but make the aggregate token total unknown and include a bounded event marker without copying the malformed identifier. Preserve the `invalid_event_data` refusal.

[CODE] Bound only the public `readTraceSnapshot` read to 33,554,432 bytes and 100,000 nonempty rows. Check size before allocation, keep reads bounded if the opened file grows, and count rows before parsing event objects. Exceeding either limit yields the existing `trace_unavailable` CLI refusal without partial journey or hash claims. Preserve exact under-limit bytes, torn-tail behavior, no-follow checks, lock checks, and the separate unbounded writer/recovery readers.

[POLICY] Proof, local commit, the one final full gate, and independent exact-head review remain required. No S5 trial, `--submit`, host/relay/producer change, or broader recovery claim is included.
