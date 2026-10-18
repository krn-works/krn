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

## LON-286 — neutral host pnpm store discovery (2026-10-17)

[POLICY] This bounded continuation of LON-284 isolates the immutable-base-selected pnpm host store query from mutable repository workspace configuration using a fresh owned standalone probe under validated repository state/tmp parents. Candidate workspace manifests, package manifests, lockfiles, and application dependencies remain legitimate sandboxed inputs; do not blanket-refuse workspace changes, replace candidate dependencies, or overlay candidate files. Preserve LON-219/PR44 script, registry, protected-surface, regular-file, size, teardown, and honest-source controls.

[POLICY] The synthetic owned-canary observer establishes the targeted boundary only. It does not claim a real host-home/credential exploit, universal hostile-process qualification, Full R1 execution, or acceptance of the implementation. Production changes remain pending public assertion RED and subsequent proof.

## Operator-approved S1 — foreman abort fencing (2026-10-18, LON-287)

[POLICY] This records accepted S1 source scope, not implementation acceptance, review, or unconditional merge approval. The previously authorized conditional integration/publication mandate remains subject to all required exact-head proof; this source author does not exercise publication authority. This does not grant Full R1 qualification, provider access, host/relay/trace API changes, or generic checkpoint recovery. Implementation acceptance and final review remain pending.

[EMPIRICAL] On unchanged head `cc355e70dbbbdc317b75e5bc2466d2eacda4cbe5`, the named microtask-race test failed with one assertion and zero isolation skips: `relay.checkpoint` was entered after abort, HEAD changed, the lease remained checkpointed, and dirty work disappeared.

[CODE] Once abort is observed, do not create a new intent, start another session, or enter a new checkpoint transaction. If a durable pending checkpoint exists at entry, finish its existing owned recovery path consistently before stopping. A checkpoint transaction entered before abort may finish its prepared-object/CAS/publish/record path, but must not start the next worker. Preserve dirty work and truthful lease/fact recording when stopping before checkpoint entry; do not create a commit to make the stop appear clean.

[CODE] The reproduced gap is after the asynchronous checkpoint-request wrapper checks abort and before `finishCheckpoint` resumes to prepare a fresh commit. The sole bounded source-boundary exception is a synchronous `AbortBeforeCheckpoint` guard in `src/foreman/checkpoint.ts` immediately before `prepareCheckpoint` in the no-pending branch; `src/foreman/session.ts` routes that sentinel through existing `finishSession` fact/CAS handling. Existing pending-checkpoint recovery and already-entered transaction paths remain unguarded and unchanged.

[CODE] Foreman owns cancellation for a running session and must await physical cleanup/error evidence before returning a normal stopped outcome. During asynchronous `onStarted` binding/trace work, abort must make the prompt ineligible and preserve binding-before-trace plus the existing post-cleanup CAS lease handback. Cleanup uncertainty, trace errors, and CAS conflicts remain observable failures, never clean stopped acknowledgements. CodexHost's maintained cancellation owner remains authoritative; do not add a second process controller.

[CODE] The public proof seam is `runJob`, using existing disk/Git checkpoint, relay, trace, host-ownership, and fixture helpers where relevant. Keep non-abort, ordinary startup, cleanup/CAS, dirty-state, and interrupted-checkpoint controls meaningful. No provider calls, board writes, generic W2b recovery, CLI-stop annotation expansion, or host/relay/trace API changes are included. No checkpoint API or recovery method is added; the synchronous fresh-entry guard above is the only checkpoint-source exception.
