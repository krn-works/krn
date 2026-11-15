# LEDGER — SPEC.md

## DECYZJE NIEPODLEGĄCE NEGOCJACJI

### ADR-001 — Epoka świata jest oddzielona od rewizji wiedzy

**Reguła:** `epoch_id` zależy od wejść świata: manifestu plików, Git HEAD, środowiska i konfiguracji zależności; `state_revision_id` opisuje snapshot wiedzy obejmujący atestacje, a zapis failure, obserwacji, timestampu lub nowego eventu NIE tworzy nowej epoki eksperymentu.

**Uzasadnienie:** Gdyby samo zapisanie porażki zmieniało epokę, guard traktowałby każdą kolejną próbę tego samego padającego testu jako eksperyment w zmienionych warunkach.

### ADR-002 — Enforcement działa fail-closed

**Reguła:** Jeżeli jakakolwiek dozwolona ścieżka wykonania omija brokera, profil `enforce` odmawia startu; nie istnieje automatyczny fallback do „cichej obserwacji”.

**Uzasadnienie:** Kontrola wykonywana po uruchomieniu procesu nie może zagwarantować zablokowania niedopuszczalnego efektu.

### ADR-003 — Nieznany wynik wykonania nie uprawnia do retry

**Reguła:** Crash po `spawn`, ale przed zatwierdzeniem wyniku, oznacza `execution_status=UNKNOWN`, zero automatycznych retryów i obowiązkowe reconciliation.

**Uzasadnienie:** Proces mógł już wykonać efekt, którego ponowienie spowodowałoby jego duplikację.

### ADR-004 — Dowód poprzedza admission

**Reguła:** Blob jest publikowany przed eventem wskazującym go, a digest bez zatwierdzonego Evidence Receipt nie wraca do modelu.

**Uzasadnienie:** Zatwierdzona obserwacja musi wskazywać istniejące, weryfikowalne i odzyskiwalne źródło.

### ADR-005 — Hot path jest deterministyczny

**Reguła:** Moduły Event Ledger, Acquisition Adapters, State Twin i Failure Antibody Gate nie wykonują żadnych wywołań LLM w hot path.

**Uzasadnienie:** Zapis raw evidence, obliczanie epoki, rozpoznawanie identycznego eksperymentu i decyzja przed `spawn` nie mogą zależeć od odpowiedzi modelu.

### ADR-006 — Kolejność implementacji jest zamrożona

**Reguła:** Implementacja i testowanie przebiegają wyłącznie w kolejności `Event Ledger → Acquisition Adapters → State Twin → Failure Antibody Gate → integration E2E`, a kolejny etap rozpoczyna się dopiero po zielonych testach poprzedniego.

**Uzasadnienie:** Każda kolejna warstwa opiera swoje gwarancje na działających invariantach warstwy wcześniejszej.

### ADR-007 — Kompletność capture jest własnością eventu, nie blobu

**Reguła:** `BlobReceipt` (hash, bytes, complete) opisuje pojedyncze przechwycenie strumienia. Ponieważ CAS deduplikuje po zawartości, dwa różne przechwycenia tych samych bajtów (jedno pełne, jedno przerwane) mają ten sam hash. Dlatego `capture_status` eventu nie może być wywnioskowany z samych hashy i musi być przekazany jawnie przy `append()`.

**Uzasadnienie:** content-addressable storage utożsamia obiekty po treści; status kompletności jest cechą operacji zapisu, nie cechą bajtów.

### ADR-008 — changed_artifacts z lokalnego pomiaru filesystem, nie z komunikatu procesu

**Reguła:** W `ShellDigest.changed_artifacts` wartości before/after pochodzą z deterministycznego pomiaru zawartości plików wskazanych w `dependencyPaths` (SHA-256 przed spawn i po zakończeniu procesu; `"MISSING"` dla nieistniejących), nigdy z komunikatu procesu typu `"wrote file"`. W etapie adapterów pomiar ten implementuje sam adapter, lokalnie, bez modułu State Twin. State Twin (R.3) to osobny moduł epok, manifestów i revalidation; jego późniejsze powstanie nie zmienia kontraktu adapterów.

**Uzasadnienie:** R.2 zakazuje pochodzenia `changed_artifacts` z tekstu procesu — intencją jest pomiar, nie deklaracja. Lokalny hash przed/po realizuje ten invariant deterministycznie i bez wywołań LLM, a ADR-006 dotyczy kolejności modułów, nie zakazuje użycia fs i crypto w adapterze.

### ADR-009 — BlobRef niesie strumień źródła

**Reguła:** `BlobRef` rozszerza się o opcjonalne pole `stream?: "stdout" | "stderr" | "file" | "payload"` z wartością domyślną `"payload"`. Ledger zapisuje `stream ?? "payload"` jako `event_blobs.stream_name`. `SourceHandle` jest rozwiązywalny przez `readFragment` wyłącznie wtedy, gdy potrójka `(event_id, blob_hash, stream)` istnieje w storage. Przy obliczaniu `event_hash` wartość domyślna stream jest aplikowana przed hashowaniem, więc `{hash, complete}` oraz `{hash, complete, stream: "payload"}` dają ten sam hash.

**Uzasadnienie:** R.2 wymaga oddzielnych, adresowalnych strumieni stdout/stderr; bez stream w referencji uchwyty adapterów nie byłyby rozwiązywalne. Pole opcjonalne z domyślną wartością rozszerza kontrakt bez łamania go.

### ADR-010 — receipt_id wskazuje zatwierdzone zdarzenie evidence w Ledgerze

**Reguła:** W `DigestMeta` pola `receipt_id` i `raw_event_id` odnoszą się do `event_id` zdarzenia `kind="tool_output"`, commitowanego w Event Ledgerze PO zalodowaniu raw blobów i PRZED zwróceniem digestu. Payload tego zdarzenia zawiera `requestId` oraz `reservationId` z `ExecutionPermit`. Pełny Evidence Receipt z R.5 (wiążący `proposal_id`, `guard_decision_id`, `input_epoch`, `output_epoch`) jest kompozycją warstwy middleware w issue #6 i odwołuje się do tego samego zdarzenia raw; wtedy `receipt_id` wskaże nowe zdarzenie receipt, a `raw_event_id` pozostanie przy raw. Pola pozostają rozdzielne w kontrakcie nawet gdy przechodnio niosą tę samą wartość.

**Uzasadnienie:** ADR-004 wymaga, by dowód istniał przed admission — na etapie adapterów najsilniejszym dostępnym dowodem jest commitowane, hash-chained zdarzenie ze zweryfikowanymi blobami. Dane wiązane dopiero przez Gate i State Twin (decyzja guarda, epoki) nie istnieją przed issue #4/#5 i nie mogą być udawane.

ADR-011 — epochFor(request, world) wylicza epokę preconditions jako H(git_head, environment_fingerprint, hashes plików z request.dependencyPaths pobrane z manifestu world); zmiana pliku spoza dependencyPaths nie zmienia epoki eksperymentu.

### ADR-012 — State Twin jest wiązany z Ledgerem przy konstrukcji

Reguła: Publiczne API State Twin uzupełnia fabryka createStateTwin(options: { ledger: EventLedger; sessionId: Id; correlationId: Id }): StateTwin. Samodzielnie eksportowany computeStateEpoch(input) wykonuje wyłącznie czysty pomiar (kroki 1–11 algorytmu R.3) bez zapisu i bez wymogu posiadania ledgera. Metoda StateTwin.computeStateEpoch(input) wykonuje pomiar oraz krok 12: utrwala wynik jako zdarzenie kind="state_epoch" z pełnym StateEpoch w payload, z sessionId i correlationId z konstrukcji. epochFor i revalidateMemory są czyste i niczego nie zapisują.

Uzasadnienie: R.3 wymaga trwałego zapisu obserwacji, ale zamrożone sygnatury metod nie niosą kontekstu storage. Wiązanie przy konstrukcji realizuje zapis bez zmiany sygnatur i powtarza zatwierdzony wzorzec createAdapters. Czysta funkcja pozostaje dostępna do testów i użytku bez ledgera.

### ADR-013 — Gate jest wiązany ze storage przy konstrukcji

Reguła: Publiczne API Gate uzupełnia fabryka createFailureGate(options: { ledger: EventLedger; databasePath: string; signingKey: string }): FailureGate. Tabele failures, reservations i consumed_escape_proofs są projekcjami odbudowywalnymi z append-only events; Gate otwiera własne połączenie better-sqlite3 do tego samego pliku bazy i tworzy je przez CREATE TABLE IF NOT EXISTS (idempotentnie, dla baz istniejących przed ich dodaniem do schema.sql). Autorytatywną historią decyzji pozostają zdarzenia ledgera: każdy ALLOW i BLOCK jest zapisywany jako kind="guard_decision" z pełnym kontekstem decyzji w payload.

Uzasadnienie: preflight wymaga atomowych transakcji BEGIN IMMEDIATE i fencing tokenów, których event-sourced scan nie zapewnia; projekcje w tej samej bazie dają atomowość bez ruszania zamrożonego API ledgera. Wzorzec fabryki powtarza createAdapters i createStateTwin.

### ADR-014 — Escape proof jest podpisany kluczem harnessu

Reguła: Podpis EscapeProof to HMAC-SHA256(signingKey, canonical({ schema: "escape-proof/v1", id, failureId, kind, evidenceEventIds, expiresAt })) w notacji hex. signingKey jest trzymany przez harness i przekazywany do Gate przy konstrukcji; model nigdy nie widzi klucza. Weryfikacja proof sprawdza podpis, ważność expiresAt, zgodność failureId, istnienie evidenceEventIds w ledgerze i jednorazowość zużycia.

Uzasadnienie: R.4 wymaga podpisu "zgodnego z kontraktem brokera" bez definiowania mechanizmu; HMAC z kluczem harnessu daje deterministyczną, testowalną autoryzację bez zewnętrznego PKI.

### ADR-015 — Transakcja Gate działa na połączeniu Ledgera

Reguła: EventLedger zyskuje metodę transactionImmediate<T>(fn: (db: DatabaseHandle) => T): T, która wykonuje fn w jednej transakcji BEGIN IMMEDIATE na własnym połączeniu Ledgera. Wywołany wewnątrz ledger.append dołącza do tej samej transakcji przez savepoint. DatabaseHandle to minimalna powierzchnia (prepare, exec) przeznaczona dla modułów first-party. Gate wykonuje cały preflight — odczyty i zapisy projekcji oraz zapis zdarzenia guard_decision — wewnątrz jednej transactionImmediate. Tabele projekcji tworzy przez CREATE TABLE IF NOT EXISTS wewnątrz transactionImmediate przy konstrukcji.

ADR-015 zastępuje klauzulę ADR-013 o własnym połączeniu Gate: SQLite dopuszcza jedną transakcję zapisu naraz, więc drugie połączenie podczas BEGIN IMMEDIATE daje SQLITE_BUSY (wykazano diagnostycznie). Fabryka createFailureGate(options: { ledger: EventLedger; signingKey: string }) — databasePath z ADR-013 nie jest już potrzebne.

Uzasadnienie: R.4 wymaga atomowego utrwalenia rezerwacji, zużycia proof i zdarzenia decyzji w jednej transakcji. Właścicielem połączenia i hash chain pozostaje Ledger.

### ADR-016 — Kompozycja middleware, zużycie permit, klucz i obwoluta receipt

Reguła:
- createLedgerMiddleware(options: { repositoryRoot, databasePath,
  blobDirectory, digestByteLimit, maxRawBytesPerExecution }) składa ledger,
  state twin, gate i adapters w jeden pipeline R.5; nie jest piątym modułem.
- signingKey harnessu jest generowany losowo przy pierwszym otwarciu
  i utrwalany w pliku <databasePath>.harness-key z uprawnieniami 0600;
  model nigdy go nie widzi.
- verifyAndConsumePermit w middleware: weryfikuje HMAC permit z signingKey,
  sprawdzi rezerwację (status reserved, zgodny requestHash) i atomowo przez
  transactionImmediate oznacza ją started przed spawn oraz completed po
  wyniku. Permit niezgodny, zużyty albo nierozpoznany = brak spawn.
- errorSignature dla recordFailure jest deterministyczny:
  shell → sha256(canonical({exit_code, salient_errors[].signature}));
  test-runner → sha256(canonical({failure_signatures}));
  compiler → sha256(canonical({kody diagnostyk error}));
  git-diff → brak recordFailure (diff nie jest eksperymentem z failure).
  recordFailure wywoływane wyłącznie gdy wykonanie zakończyło się porażką
  (exit_code != 0 albo rozpoznane failed tests/errors).
- Receipt to obwoluta w pamięci zwracana z intercept(): wiąże
  proposal_id, guard_decision_id, execution_id (raw event), input_epoch,
  output_epoch, digest_hash, capture_completeness. Jej składowe są trwałymi
  zdarzeniami/blobami w ledgerze; receipt_id/raw_event_id zgodnie z ADR-010.
  Nie powstaje nowy rodzaj zdarzenia.
- scripts/demo.ts uruchamia się przez "demo": "node scripts/demo.ts"
  (Node 24 wykonuje erasable TypeScript bez flag); żadnych nowych
  zależności.

Uzasadnienie: R.5 wymaga jednej ścieżki proposal → preflight → execution →
raw archive → digest → state update; powyższe reguły domykają szwy bez
zmiany zamrożonych API czterech modułów.

### ADR-017 — Limit raw zatrzymuje proces podczas strumieniowego capture

Reguła: Adaptery przechwytują stdout/stderr strumieniowo W TRAKCIE wykonania
procesu, nie po jego zakończeniu. Przekroczenie maxRawBytesPerExecution
kończy proces potomny (SIGTERM), zatrzymuje dalszy zapis, a wynik ma
capture_complete=false i termination_signal="RAW_LIMIT_EXCEEDED".
Częściowe przechwycenie jest zachowywane i odzyskiwalne; nie powstaje
pozytywna atestacja kompletności. Buforowanie całego outputu procesu
w pamięci jest zabronione.

Uzasadnienie: R.0 wymaga, by przekroczenie limitu kończyło proces. Limit
egzekwowany po zakończeniu procesu nie zatrzymuje ani procesu, ani wzrostu
pamięci harnessu. Defekt wykryty testem integracyjnym issue #6.

### ADR-018 — Demo uruchamia skompilowane artefakty

Reguła: npm run demo wykonuje tsc -p tsconfig.demo.json (emit do
.demo-dist, rootDir ".", include: src i scripts, dziedziczy strict)
i uruchamia node .demo-dist/scripts/demo.js. Specifiery .js w źródłach
nie są zmieniane; nie wprowadza się loaderów ani nowych zależności.
.demo-dist jest objęte .gitignore.

Uzasadnienie: Node 24 nie mapuje specyfierów .js na pliki .ts, a repo
używa NodeNext, gdzie specifiery .js są poprawne po emisji. Kompilacja
demo dodatkowo weryfikuje, że pakiet emituje się poprawnie.

## Cel i granica systemu

LEDGER jest zewnętrzną warstwą transaction/control plane otaczającą istniejący runtime Codexa.

Codex pozostaje odpowiedzialny za sesję, reasoning, interakcję z modelem, tool calling i execution loop.

LEDGER nie implementuje własnego runtime’u agentowego, provider adapters, OpenAI/Anthropic HTTP loop ani dodatkowego agenta orkiestrującego Codexa.

Centralny invariant:

> Każda wykonana akcja ma uprzednio zatwierdzony zapis zamiaru, każda obserwacja dopuszczona do Codexa ma odzyskiwalne źródło, a każde publikowane twierdzenie o aktualnym stanie ma ważny dowód odnoszący się do jego rzeczywistych preconditions.

MVP-0 realizuje cztery moduły niezbędne do kontrolowanego wykonania, capture, state verification i blokowania powtórzonych porażek. Nie implementuje całej architektury docelowej.

## R. MVP-0 IMPLEMENTATION SPEC

### R.0. Zakres, środowisko i struktura

#### Dokładnie cztery moduły

1. Event Ledger.
2. Acquisition Adapters.
3. State Twin.
4. Failure Antibody Gate.

`src/index.ts` zawiera publiczne eksporty i cienkie złożenie middleware; nie jest piątym modułem.

#### Poza zakresem MVP-0

- Context Atlas i pełny Context Assembler.
- Pamięć semantyczna, semantyczna ekstrakcja i konsolidacja memories.
- Utility promotion, Compounding Evaluator i automatyczna promocja doświadczeń.
- Pełny zestaw ośmiu adapterów; poza MVP-0 pozostają adaptery file read, directory listing, search i HTML.
- Audyt integracji MCP z rzeczywistym Codexem.

Punkty przechwycenia opisane w tym dokumencie pozostają kontraktem integracyjnym. Wyłączenie audytu MCP z zakresu MVP-0 nie uchyla ADR-002: bez potwierdzenia pokrycia ścieżek nie wolno deklarować ani uruchamiać profilu `enforce` dla rzeczywistej integracji Codexa.

Typ `MemoryRecord` jest kontraktem wejściowym revalidation, nie zobowiązaniem do implementacji pełnego systemu pamięci w MVP-0.

#### Środowisko

- Node.js.
- TypeScript z `strict: true`.
- TypeScript z `noUncheckedIndexedAccess: true`.
- TypeScript z `exactOptionalPropertyTypes: true`.
- `better-sqlite3`.
- Vitest.
- `@types/node`.
- SQLite w wersji co najmniej `3.51.3`.
- `PRAGMA synchronous = FULL`.
- `PRAGMA journal_mode = WAL`.
- Lokalny storage SQLite; nie NFS.
- Jeden aktywny writer na kontrolowany worktree.
- Publiczne API w `src/index.ts`.
- Jeden pakiet npm.

Bezpośrednie zależności pakietowe wynikające z tej specyfikacji to `better-sqlite3`, `typescript`, `vitest` i `@types/node`. Dodatkowych zależności nie wolno dodawać bez jawnej akceptacji zmiany specyfikacji.

Wersję SQLite należy sprawdzić w rzeczywistym połączeniu używanym przez `better-sqlite3`, a nie na podstawie wersji systemowego polecenia `sqlite3`.

Do uruchomienia CI wymagane są implementacyjne `package.json`, `package-lock.json` i konfiguracja TypeScript. Same dokumenty startowe i workflow nie stanowią działającej implementacji.

#### Struktura pakietu

```text
src/
  ledger/
    index.ts
    schema.sql
    types.ts
  adapters/
    index.ts
    shell.ts
    test-runner.ts
    compiler.ts
    git-diff.ts
    types.ts
  state/
    index.ts
    types.ts
  guards/
    index.ts
    types.ts
  index.ts

test/
  ledger/
  adapters/
  state/
  guards/
  integration/
  fixtures/

scripts/
  demo.ts
```

Nie zmieniać nazw modułów, plików ani publicznych symboli określonych w specyfikacji.

#### Domyślne limity

| Parametr | Wartość |
|---|---:|
| Maksymalny context-facing digest | 4096 bajtów UTF-8 |
| Maksymalny raw output pojedynczego wykonania | 64 MiB |
| SQLite busy timeout | 1000 ms |
| Aktywni writerzy na worktree | 1 |
| Domyślne wykonanie procesu | `shell: false` |
| Automatyczne retry po `UNKNOWN` execution | 0 |
| Domyślne retry równoważnej znanej porażki bez escape proof | 0 |
| Autoryzowane retry bez zmiany preconditions w jednym failure lineage | Maksymalnie 1 |

Przekroczenie limitu raw output kończy proces, zapisuje niekompletny capture i nie może wygenerować pozytywnej atestacji kompletnego wyniku.
Egzekwowanie limitu jest strumieniowe i przerywa proces (ADR-017).

#### Rozdzielenie klas danych

| Klasa | Zawartość | Zakaz |
|---|---|---|
| Transcript | Wiadomości oraz jawnie wyemitowane decyzje | Nie stanowi aktualnego stanu świata |
| Persistent memory | Pochodne twierdzenia i zobowiązania | Sam zapis nie jest dowodem prawdziwości |
| Verified world state | Pomiary plików, Git, środowiska i atestacje | Nie może pochodzić z odpowiedzi modelu |
| Tool observations | Przechwycone bajty i deterministyczne digesty | Output nie jest zaufaną instrukcją |
| Learned experience | Procedury i lekcje z preconditions | Nie stanowi gwarancji transferu na nowe zadanie |

Raw evidence oznacza prawdę o tym, co zaobserwowano na kontrolowanej granicy, nie automatyczną prawdziwość tekstu wygenerowanego przez narzędzie.

#### Typy wspólne

```ts
export type Id = string;
export type Hash = string;
export type ISODate = string;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type SourceIds = readonly [Id, ...Id[]];

export interface SourceHandle {
  event_id: Id;
  blob_hash: Hash;
  stream: "stdout" | "stderr" | "file" | "payload";
  byte_start: number;
  byte_end: number; // exclusive
}

export interface Predicate {
  kind:
    | "file_hash"
    | "environment_hash"
    | "git_head"
    | "test_fingerprint"
    | "evidence_exists";
  key: string;
  expected: string;
}

export interface EventRecord {
  event_id: Id;
  seq: number;
  schema_version: number;
  project_id: Id;
  session_id: Id;
  correlation_id: Id;
  parent_event_ids: readonly Id[];

  kind:
    | "user_message"
    | "assistant_decision"
    | "tool_proposal"
    | "guard_decision"
    | "tool_started"
    | "tool_output"
    | "file_observation"
    | "test_outcome"
    | "state_epoch"
    | "memory_write"
    | "compaction"
    | "recovery"
    | "contradiction"
    | "execution_unknown";

  source_timestamp: ISODate;
  ingested_at: ISODate;
  payload: Json;
  payload_hash: Hash;
  raw_blob_hashes: readonly Hash[];
  previous_event_hash: Hash | null;
  event_hash: Hash;
  capture_status: "complete" | "partial" | "not_applicable";
}

export interface StateEpoch {
  epoch_id: Hash;
  git_head: string | null;
  dirty_tree_hash: Hash;
  touched_file_hashes: Readonly<Record<string, Hash | "MISSING">>;
  test_result_hashes: Readonly<Record<string, Hash>>;
  environment_fingerprint: Hash;
  created_at: ISODate;

  manifest_hash: Hash;
  state_revision_id: Hash;
  completeness: "verified" | "unknown";
}

export interface MemoryRecord {
  id: Id;
  kind:
    | "fact"
    | "decision"
    | "preference"
    | "convention"
    | "failure"
    | "procedure"
    | "open_question";

  claim: {
    key: string;
    value: Json;
    wording: string;
  };

  scope: {
    project_id: Id;
    worktree_id: Id | null;
    paths: readonly string[];
  };

  source_event_ids: SourceIds;
  created_at: ISODate;
  state_epoch: Hash | null;
  confidence: number;
  validity:
    | "candidate"
    | "active"
    | "stale"
    | "superseded"
    | "quarantined"
    | "tombstoned";

  retrieval_keys: readonly string[];
  utility_score: number | null;

  dependency_predicates: readonly Predicate[];
  supersedes: Id | null;
  revalidated_at_epoch: Hash | null;
  utility_status: "unmeasured" | "probation" | "promoted" | "rejected";
}

export interface FailureRecord {
  id: Id;
  tool: string;
  normalized_args_hash: Hash;
  state_epoch: Hash;
  error_signature: Hash;
  preconditions: readonly Predicate[];
  attempted_fix: string | null;
  escape_condition: readonly Predicate[];
  recurrence_count: number;
  source_event_ids: SourceIds;

  action_key: Hash;
  source_world_epoch: Hash;
  unchanged_retry_count: number;
  status: "active" | "escaped" | "superseded";
}
```

Pola `MemoryRecord` dotyczące utility pozostają częścią kontraktu typu; MVP-0 nie implementuje utility promotion.

### R.1. Event Ledger

#### Cel

Zapewnić append-oriented, recoverable log, stabilne event IDs, content-addressable raw blob storage, integralność bajtów oraz źródłowe timestampy.

Compaction nie może usuwać raw events ani jedynej kopii dowodu.

#### Public API

```ts
export interface LedgerOptions {
  databasePath: string;
  blobDirectory: string;
  projectId: string;
  maxRawBytesPerExecution: number; // default: 64 MiB
}

export interface BlobReceipt {
  hash: Hash;
  bytes: number;
  complete: boolean;
}

export interface BlobRef {
  hash: Hash;
  complete: boolean; // status tego konkretnego przechwycenia, z BlobReceipt
  stream?: "stdout" | "stderr" | "file" | "payload"; // default: "payload"
}

export interface AppendEventInput {
  eventId: Id;
  sessionId: Id;
  correlationId: Id;
  kind: EventRecord["kind"];
  sourceTimestamp: ISODate;
  payload: Json;
  blobs: readonly BlobRef[]; // było: blobHashes: readonly Hash[]
}

export interface DatabaseHandle {
  prepare(sql: string): {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  };
  exec(sql: string): unknown;
}

export interface EventLedger {
  append(input: AppendEventInput): EventRecord;

  transactionImmediate<T>(
    fn: (db: DatabaseHandle) => T
  ): T;

  archive(
    chunks: AsyncIterable<Uint8Array>
  ): Promise<BlobReceipt>;

  readBlob(hash: Hash): Promise<Uint8Array>;

  readFragment(
    handle: SourceHandle
  ): Promise<Uint8Array>;

  getEvent(id: Id): EventRecord | undefined;

  scan(query: {
    sessionId?: Id;
    kind?: EventRecord["kind"];
    afterSeq?: number;
    limit: number;
  }): readonly EventRecord[];

  close(): void;
}

export function openLedger(
  options: LedgerOptions
): EventLedger;
```

`transactionImmediate` jest przeznaczone dla modułów first-party wymagających atomowych projekcji na tym samym połączeniu co append-only Ledger.

#### SQLite schema — część Event Ledger

Plik: `src/ledger/schema.sql`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA recursive_triggers = ON;
PRAGMA busy_timeout = 1000;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  capture_status TEXT NOT NULL
    CHECK(capture_status IN ('complete','partial','not_applicable'))
);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE event_blobs (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  stream_name TEXT NOT NULL,
  PRIMARY KEY(event_id, blob_hash, stream_name)
);

CREATE INDEX events_session_seq
  ON events(session_id, seq);

CREATE INDEX events_kind_time
  ON events(kind, source_timestamp);

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER event_blobs_no_update
BEFORE UPDATE ON event_blobs
BEGIN
  SELECT RAISE(ABORT, 'event sources are immutable');
END;

CREATE TRIGGER event_blobs_no_delete
BEFORE DELETE ON event_blobs
BEGIN
  SELECT RAISE(ABORT, 'event sources are immutable');
END;
```

Triggery chronią przed błędem aplikacji, nie przed administratorem uprawnionym do zmiany schema. Właścicielem storage jest sidecar, nie proces Codexa.

#### Invariants

- `event_id` pozostaje stabilny przy ponownym dostarczeniu tego samego upstream eventu.
- Ten sam `event_id` i ten sam payload nie tworzą nowego eventu.
- Ten sam `event_id` i inny `payload_hash` oznaczają błąd, nie overwrite.
- Blob jest publikowany przed eventem wskazującym go.
- Content hash obejmuje dokładne bajty.
- Zatwierdzony event nie może wskazywać nieistniejącego blobu.
- `INSERT OR REPLACE` jest zabronione dla eventów.
- UPDATE i DELETE eventów są blokowane przez storage.
- Raw archive pozostaje niezależne od digestów i przyszłego compaction.
- `append()` zapisuje `blob.stream ?? "payload"` jako `stream_name` w `event_blobs`.
- `capture_status` eventu jest wyliczane z `blobs[].complete` w chwili `append()`:
  - jeśli `blobs` jest puste → `"not_applicable"`;
  - jeśli wszystkie `complete: true` → `"complete"`;
  - jeśli choć jeden `complete: false` → `"partial"`.
- Dwa eventy mogą wskazywać ten sam blob i mieć różny `capture_status`.

#### Kolejność zapisu raw

```text
capture do spoolu poza worktree
→ obliczenie content hash i liczby bajtów
→ fsync
→ publikacja blobu CAS
→ commit referencji w SQLite
→ możliwość zatwierdzenia digestu
```

Blob opublikowany przed transakcją może zostać osierocony. Nie wolno rozwiązywać tego ryzyka przez odwrócenie kolejności i zatwierdzanie eventów przed blobami.

Przerwany capture jest zapisywany jako niekompletny. Nie wolno przedstawiać go jako pełnego outputu.

#### Edge cases

- Disk-full.
- Przerwany stream.
- Binary output.
- Niepoprawne UTF-8.
- Duplicate delivery.
- Konflikt event ID.
- Crash między blob seal a DB commit.
- Brak blobu po odtworzeniu backupu.
- Przekroczenie 64 MiB raw output.

Przekroczenie limitu kończy proces i zapisuje `capture_status=partial`; nie powstaje pozytywna atestacja kompletnego wyniku.

#### Testy modułu

- Append-only.
- Reopen durability.
- Duplicate idempotency.
- Conflicting duplicate rejection.
- Raw integrity.
- Binary round-trip.
- Orphan detection.
- Incomplete capture.

Obowiązują również odpowiadające temu modułowi asercje sekcji S.

#### Codex interception point

Raw capture znajduje się w wykonawcy MCP/subprocess wrapperze, przed zwróceniem wyniku narzędzia.

MVP-0 implementuje lokalny kontrakt przechwycenia. Audyt rzeczywistej integracji MCP pozostaje poza zakresem.

### R.2. Acquisition Adapters

#### Cel

Zaimplementować dokładnie cztery adaptery:

- `shell`.
- `test-runner`.
- `compiler`.
- `git-diff`.

Raw output trafia do Event Ledger. Do context-facing odpowiedzi trafia wyłącznie bounded typed digest.

#### Public API

```ts
export type AdapterKind =
  | "shell"
  | "test-runner"
  | "compiler"
  | "git-diff";

export interface ExecutionRequest {
  requestId: Id;
  sessionId: Id;
  goalId: Id;
  kind: AdapterKind;
  executable: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  dependencyPaths: readonly string[];
  timeoutMs: number;
}

export interface ExecutionPermit {
  reservationId: Id;
  requestHash: Hash;
  preconditionEpoch: Hash;
  fencingToken: number;
  signature: string;
}

export type TypedDigest =
  | ShellDigest
  | TestRunnerDigest
  | CompilerDigest
  | GitDiffDigest;

export interface AcquisitionResult {
  digest: TypedDigest;
  rawEventId: Id;
  rawBlobs: readonly BlobReceipt[];
}

export interface AcquisitionAdapters {
  execute(
    request: ExecutionRequest,
    permit: ExecutionPermit
  ): Promise<AcquisitionResult>;
}

export function createAdapters(options: {
  ledger: EventLedger;
  digestByteLimit: number; // 4096
  verifyAndConsumePermit: (
    request: ExecutionRequest,
    permit: ExecutionPermit
  ) => void;
}): AcquisitionAdapters;
```

#### Wspólny schemat digestów

```ts
export interface DigestMeta {
  adapter_version: string;
  raw_event_id: Id;
  receipt_id: Id;
  capture_complete: boolean;
  parser_status: "recognized" | "partial" | "unknown";
  omitted_count: number;
  truncated: boolean;
  unknown_fragment: {
    excerpt: string;
    source: SourceHandle;
  } | null;
}
```

`receipt_id = raw_event_id = event_id` zatwierdzonego zdarzenia `tool_output` (ADR-010); rozdzielą się w warstwie R.5.

Każdy digest ma maksymalnie 4096 bajtów UTF-8 po serializacji.

Nieznany parser nie przepuszcza całego outputu. Zwraca `parser_status=unknown`, ograniczony fragment i uchwyt do raw źródła. Dla `parser_status="unknown"` pole `unknown_fragment` MUSI być nie-null i zawierać bounded excerpt oraz rozwiązywalny `SourceHandle`; dla `recognized` jest `null`. Dla `partial` może być nie-null wyłącznie dla nierozpoznanej części.

`null` w polach liczników oznacza „nie ustalono”, nie zero.

#### Shell digest

```ts
export interface ShellDigest extends DigestMeta {
  kind: "shell";
  command: string;
  normalized_args_hash: Hash;
  exit_code: number | null;
  termination_signal: string | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;

  salient_errors: readonly {
    signature: Hash;
    code: string | null;
    excerpt: string;
    source: SourceHandle;
  }[];

  warning_signatures: readonly Hash[];

  changed_artifacts: readonly {
    path: string;
    before: Hash | "MISSING";
    after: Hash | "MISSING";
  }[];
}
```

`command` jest ograniczonym preview; pełne argumenty pozostają w raw proposal.

`termination_signal="RAW_LIMIT_EXCEEDED"` oznacza przerwanie limitem.

Raw archival form:

- Oddzielne, dokładne strumienie bajtów stdout i stderr.
- Envelope procesu.
- Argumenty.
- Cwd.
- Allowlisted environment fingerprint.
- Informacje o sygnale i zakończeniu.

`changed_artifacts` pochodzą z deterministycznego pomiaru filesystem przed i po wykonaniu (ADR-008), nigdy z komunikatu narzędzia „wrote file".

#### Test-runner digest

```ts
export interface TestRunnerDigest extends DigestMeta {
  kind: "test-runner";
  framework: string;
  command: string;
  exit_code: number | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;

  failed_tests: readonly {
    test_id: string;
    file: string;
    name: string;
    signature: Hash;
    source: SourceHandle;
  }[];

  failure_signatures: readonly Hash[];
  duration_ms: number;
  tested_epoch: Hash;
  test_fingerprint: Hash;
}
```

Raw archival form:

- Pełne stdout i stderr.
- Pełny maszynowy raport testów.

`exit_code=0` bez rozpoznanego raportu nie staje się automatycznie `tests_pass=true`.

Sprzeczność liczników z exit code oznacza `parser_status=partial` i brak pozytywnej atestacji.

#### Compiler digest

```ts
export interface CompilerDigest extends DigestMeta {
  kind: "compiler";
  compiler: string;
  command: string;
  exit_code: number | null;
  error_count: number | null;
  warning_count: number | null;

  diagnostics: readonly {
    severity: "error" | "warning" | "note";
    code: string | null;
    file: string | null;
    line: number | null;
    column: number | null;
    message: string;
    source: SourceHandle;
  }[];

  affected_files: readonly string[];
  compiled_epoch: Hash;
}
```

Raw archival form:

- Pełne stdout i stderr.
- Maszynowy raport, jeżeli kompilator go zapewnia.

Pierwszy wspierany parser w MVP-0:

```text
tsc --pretty false --noEmit
```

#### Git diff digest

```ts
export interface GitDiffDigest extends DigestMeta {
  kind: "git-diff";
  base: string;
  head: string;
  files_changed: number;
  additions: number;
  deletions: number;

  file_summaries: readonly {
    path: string;
    old_path: string | null;
    status: "A" | "M" | "D" | "R" | "C" | "T";
    additions: number | null;
    deletions: number | null;
    patch_source: SourceHandle;
  }[];

  binary_files: readonly string[];
}
```

Raw archival form:

- Pełny patch.
- NUL-delimited `raw/numstat`.
- Wyłączone external diff i textconv.

Nazw plików nie wolno parsować przez dzielenie po spacjach.

#### Invariants

- `spawn` nie może nastąpić bez poprawnego i niezużytego permit.
- TypeScript brand nie zastępuje sprawdzenia permit w runtime brokera.
- Domyślne wykonanie to `spawn(executable, argv, { shell: false })`.
- Uruchomienie interpretera z `-c` jest jawną postacią żądania.
- Treść skryptu przekazanego interpreterowi pozostaje ciągiem bajtów; nie wolno „normalizować” jej semantyki przez usuwanie whitespace.
- Raw jest utrwalany przed admission digestu.
- Digest nie może zawierać pełnego dużego outputu.
- Digest jawnie sygnalizuje pominięcia, niekompletność i nierozpoznany format.

#### Edge cases

- Multiline diagnostics.
- ANSI escapes.
- Bardzo długa linia.
- Zero testów.
- Malformed JSON report.
- Exit code sprzeczny z raportem.
- Timeout.
- Zakończenie sygnałem.
- Binary diff.
- Rename.
- Nazwa pliku z tabulatorem lub newline.

#### Real fixtures

Fixture zawiera manifest:

```text
tool version
command
input fixture hashes
raw output hash
exit code
capture timestamp
```

Źródła fixtures:

- Prawdziwy shell.
- Rzeczywisty nieudany test Vitest.
- Rzeczywisty błąd `tsc`.
- Prawdziwe `git diff` na tymczasowym repo.

Normalizacja ścieżek do porównań odbywa się w expected digest, nie przez podmianę raw evidence.

Dla każdego z czterech adapterów obowiązuje osobny unit test na rzeczywistym fixture output.

#### Codex interception point

Handler narzędzia zwraca do Codexa wyłącznie `TypedDigest`.

Nie zwraca pełnego `AcquisitionResult` ani raw bytes.

Docelowy punkt to odpowiedź MCP/subprocess wrappera przed pierwszym admission wyniku do modelu; jego zewnętrzny audyt nie należy do MVP-0.

### R.3. State Twin

#### Cel

Deterministycznie utrzymywać:

- Per-file content hashes.
- Git HEAD.
- Dirty tree hash.
- Test fingerprint.
- Environment fingerprint.
- Oddzielne `epoch_id` i `state_revision_id`.

Stan nie może pochodzić z odpowiedzi modelu.

#### Public API

Fabryka `createStateTwin` wiąże pomiar z ledgerem i kontekstem zdarzeń przy konstrukcji; samodzielny `computeStateEpoch` pozostaje pomiarem bez zapisu (ADR-012).

```ts
export function createStateTwin(options: {
  ledger: EventLedger;
  sessionId: Id;
  correlationId: Id;
}): StateTwin;

export interface StateInput {
  repositoryRoot: string;
  environmentFingerprint: Hash;
  testAttestations: Readonly<Record<string, Hash>>;
}

export interface StateTwin {
  computeStateEpoch(input: StateInput): Promise<StateEpoch>;

  epochFor(
    request: ExecutionRequest,
    world: StateEpoch
  ): Promise<Hash>;

  revalidateMemory(
    memory: MemoryRecord,
    epoch: StateEpoch
  ): Promise<"active" | "stale">;
}

export function computeStateEpoch(
  input: StateInput
): Promise<StateEpoch>;

export function revalidateMemory(
  memory: MemoryRecord,
  epoch: StateEpoch
): Promise<"active" | "stale">;
```

#### Epoka świata i rewizja wiedzy

```text
epoch_id =
  H(repo input manifest,
    Git HEAD,
    relevant environment,
    dependency configuration)

state_revision_id =
  H(epoch_id,
    normalized test attestations,
    verified observation references)
```

Do epoki eksperymentu nie wchodzą:

- `created_at`.
- Liczba eventów.
- Czas wykonania testu.
- Identyfikator nowej obserwacji.
- Sam fakt zapisania failure.
- Sam fakt zapisania nowego wyniku testu.

`test_result_hashes` opisują atestacje dla określonych epok wejściowych. Nie powodują samoczynnej zmiany preconditions.

#### Algorytm `computeStateEpoch()`

```text
1. Acquire worktree lease.
2. Read Git HEAD.
3. Enumerate tracked + relevant untracked files.
4. Record path, type, mode, content hash or symlink target hash.
5. Sort by canonical path bytes.
6. Hash complete manifest.
7. Read index/dirty representation with unambiguous framing.
8. Join trusted environment fingerprint.
9. Compute epoch_id, excluding timestamps and observation counters.
10. Attach test attestations for their tested epochs.
11. Compute state_revision_id.
12. Persist state observation.
```

`dirty_tree_hash` nie jest hashem tekstu `git status`. Obejmuje rzeczywistą zawartość i istotne metadane plików.

Epoka używana przez Failure Gate opisuje istotne preconditions eksperymentu, a nie dowolną zmianę niezwiązanego pliku.

#### SQLite schema — część State Twin

W MVP-0 obserwacje stanu są utrwalane jako zdarzenia ledgera kind="state_epoch" z pełnym StateEpoch w payload; tabela state_observations jest projekcją odłożoną do etapu integracji (issue #6) i nie jest tworzona w tym module. Lookup po epoch realizuje scan po kind.

Dalsza część `src/ledger/schema.sql`, wdrażana na etapie State Twin:

```sql
CREATE TABLE state_observations (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id),
  epoch_id TEXT NOT NULL,
  state_revision_id TEXT NOT NULL,
  manifest_blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
);

CREATE INDEX state_observations_epoch
  ON state_observations(epoch_id);
```

Kilka obserwacji może mieć ten sam `epoch_id`, ale inne atestacje wiedzy.

#### Algorytm `revalidateMemory()`

```text
Dla każdego dependency predicate:
  pobierz świeży pomiar
  porównaj z oczekiwaną wartością

brak pomiaru lub mismatch → stale
wszystkie predicates zgodne → active
```

`active` oznacza zgodność zależności. Nie usuwa osobnej kwarantanny ani nie promuje utility.

Memory odnoszące się do starej epoki nie może być przedstawione jako aktualny stan bez revalidation.

#### Źródła prawdy

| Mutable fact | Source of truth | Warunek aktualności |
|---|---|---|
| „Plik zawiera X” | Odczyt bajtów i content hash | Zgodny hash pliku lub zakresu |
| „Plik został zmodyfikowany” | Manifest przed i po | Różnica content, mode lub symlink hash |
| „Branch ma zmianę” | Git ref, index i worktree manifest | Świeży pomiar wszystkich istotnych elementów |
| „Dependency jest zainstalowane” | Rzeczywiste resolution i fingerprint instalacji | Nie sam lockfile |
| „Tests pass” | Zakończony run dla command/config/input/environment fingerprint | Atestacja zgodna z istotnymi wejściami |
| „Compiler nie ma błędów” | Zakończony run z rozpoznanym formatem | Zgodna epoka i kompletny capture |

Jeżeli memory mówi „tests pass”, a bieżąca zgodna atestacja mówi „fail”:

```text
current state = fail
old memory claim = historical/stale
contradiction event = committed
freshness = updated
```

#### Edge cases

- Usunięty plik.
- Symlink poza scope.
- Submodule.
- Executable bit.
- Niezatwierdzone pliki.
- Zmiana środowiska bez zmiany Git.
- Plik zmieniony podczas hashowania.
- Plik o tej samej długości i mtime, ale innych bajtach.

#### Testy modułu

- Determinism przy różnych timestampach.
- Mutacja treści.
- Delete.
- Rename.
- Mode change.
- Zmiana dependency installation fingerprint.
- Nowe test observation bez zmiany epoki eksperymentu.
- Memory active w E1 staje się stale po zmianie zależnego pliku.

#### Codex interception point

Pomiar odbywa się przed gate i po wykonaniu narzędzia.

State Twin nie przyjmuje odpowiedzi modelu jako pomiaru.

### R.4. Failure Antibody Gate

#### Cel

Zablokować równoważny nieudany eksperyment w niezmienionych preconditions przed uruchomieniem procesu.

#### Public API

```ts
export function createFailureGate(options: {
  ledger: EventLedger;
  signingKey: string;
}): FailureGate;

export interface EscapeProof {
  id: Id;
  failureId: Id;
  kind:
    | "state_change"
    | "args_change"
    | "precondition_change"
    | "new_evidence"
    | "authorized_recovery_hypothesis";
  evidenceEventIds: SourceIds;
  expiresAt: ISODate;
  signature: string;
}

export type PreflightResult =
  | {
      decision: "ALLOW";
      permit: ExecutionPermit;
    }
  | {
      decision: "BLOCK";
      reason: string;
      previousFailureId: Id | null;
      requiredEscapeProof: readonly string[];
    };

export interface FailureGate {
  preflight(input: {
    request: ExecutionRequest;
    preconditionEpoch: Hash;
    proof?: EscapeProof;
  }): PreflightResult;

  recordFailure(input: {
    request: ExecutionRequest;
    preconditionEpoch: Hash;
    sourceWorldEpoch: Hash;
    errorSignature: Hash;
    sourceEventIds: SourceIds;
  }): FailureRecord;
}

export function fingerprint(
  tool: string,
  normalizedArgs: Json,
  stateEpoch: Hash,
  errorSignature: Hash
): Hash;
```

#### Deterministyczny fingerprint

```ts
import { createHash } from "node:crypto";

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers are forbidden");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
    .join(",")}}`;
}

function hash(value: Json): Hash {
  return createHash("sha256")
    .update(canonical(value), "utf8")
    .digest("hex");
}

export function fingerprint(
  tool: string,
  normalizedArgs: Json,
  stateEpoch: Hash,
  errorSignature: Hash
): Hash {
  return hash({
    schema: "failure-fingerprint/v1",
    tool,
    normalizedArgs,
    stateEpoch,
    errorSignature
  });
}
```

Normalizacja zachowuje kolejność `argv`, treść cytowanych argumentów i semantycznie istotne wartości środowiska.

Nie wolno uznawać dowolnego shella za równoważny po usunięciu whitespace.

#### Error signature nie jest znany przed wykonaniem

Preflight oblicza najpierw:

```text
action_key = H(tool, normalizedArgs, preconditionEpoch)
```

Następnie wyszukuje wcześniejsze aktywne failures dla tego klucza.

Zapisane `error_signature` wcześniejszych failures służą do identyfikacji failure fingerprint.

Gate nie przewiduje przyszłego błędu i nie przyjmuje „nowej sygnatury” podanej przez model jako przepustki.

#### SQLite schema — część Failure Antibody Gate

Dalsza część `src/ledger/schema.sql`, wdrażana na etapie Gate:

```sql
CREATE TABLE failures (
  id TEXT PRIMARY KEY,
  action_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  precondition_epoch TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);

CREATE INDEX failures_action_key ON failures(action_key);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('reserved','started','completed','unknown'))
);

CREATE TABLE consumed_escape_proofs (
  proof_id TEXT PRIMARY KEY,
  consumed_by_reservation TEXT NOT NULL REFERENCES reservations(id),
  event_id TEXT NOT NULL REFERENCES events(event_id)
);
```

`failures` i `reservations` są odbudowywalnymi projekcjami. Autorytatywna historia pozostaje w append-only events.

#### Algorytm `preflight()`

```text
BEGIN IMMEDIATE

validate request and current lease
derive action_key
load active failures

if equivalent failure exists:
    if no valid escape proof:
        append BLOCK event
        COMMIT
        return BLOCK

    verify proof signature, freshness, scope and source events
    reject already consumed proof

    if unchanged preconditions retry already used:
        BLOCK

create reservation with fencing token
consume proof if present
append ALLOW event

COMMIT
return permit
```

Transakcja SQLite nie pozostaje otwarta przez cały czas działania procesu.

Lease wykonania i fencing token obejmują okres wykonania osobno.

Adapter weryfikuje i zużywa permit przed `spawn`.

#### Polityka retry

```text
pierwsza próba
→ ALLOW

failure zapisany

druga równoważna próba bez escape proof
→ BLOCK

trzecia identyczna próba bez ważnego escape proof
→ BLOCK przed spawn
```

Każdy BLOCK wynikający z wcześniejszej porażki zawiera reason i reference do previous failure.

Zmiana argumentów albo rzeczywistych zależności tworzy nowy eksperyment.

Nowy timestamp, nowy memory record lub nowe sformułowanie uzasadnienia nie są zmianą preconditions.

#### Escape proof

Dopuszczalne podstawy:

- Relevant state change.
- Argument change.
- Verified precondition change.
- New independent evidence.
- Authorized recovery hypothesis.

`authorized_recovery_hypothesis` wymaga zewnętrznie autoryzowanego, jednorazowego ticketu. Sam tekst „mam inną hipotezę” nie jest proof.

Domyślnie dopuszczalny jest najwyżej jeden autoryzowany retry bez zmiany preconditions w danym failure lineage.

Proof musi być:

- Powiązany z failure.
- Aktualny.
- Zgodny ze scope.
- Weryfikowalny przez source events.
- Podpisany zgodnie z kontraktem brokera.
- Nieużyty wcześniej.

#### Edge cases

- Równoległe identyczne requests.
- Replay proof.
- Zmiana nieistotnego pliku.
- Zmiana relevant dependency.
- Flaky test.
- Błąd sieciowy.
- Nieznany wynik wcześniejszego procesu.
- Restart gate.

Dla zewnętrznych zależności czasowych wymagany jest jawny TTL/precondition probe. Brak takiej informacji nie oznacza, że warunki są znane.

#### Testy modułu

- First attempt ALLOW.
- Druga równoważna próba bez proof BLOCK.
- Trzecia identyczna propozycja BLOCK przed spawn.
- Fingerprint determinism.
- Zachowanie kolejności argumentów.
- Changed relevant state pozwala na nowy eksperyment.
- Irrelevant state change nie odblokowuje failure.
- Ważny escape proof pozwala na jeden retry.
- Replayed proof jest odrzucany.
- Concurrent duplicate nie omija reservation gate.
- Restart nie usuwa aktywnego zakazu.

#### Codex interception point

Gate działa w brokerze wykonującym narzędzie, przed `spawn`.

Integracja, która widzi zdarzenie dopiero po `spawn`, nie spełnia kontraktu.

### R.5. Cienkie złożenie w `src/index.ts`

`src/index.ts` udostępnia publiczne API czterech modułów i `createLedgerMiddleware` używane przez demo.

Złożenie:

```text
tool proposal
→ normalizacja
→ worktree lease
→ computeStateEpoch / epochFor
→ preflight
→ commit intent i reservation
→ wykonanie z permit
→ raw capture
→ raw seal
→ typed digest
→ state update
→ failure record, jeżeli wystąpił
→ zatwierdzony context-facing result
```

Evidence Receipt wiąże:

```text
proposal_id
+ guard_decision_id
+ execution_id
+ raw_blob_hashes
+ input_epoch
+ output_epoch
+ digest_hash
+ capture_completeness
```

Żaden etap tej ścieżki nie wymaga wywołania LLM.

#### Kontrakt awarii

```text
crash po spawn przed zatwierdzeniem wyniku
→ execution_status = UNKNOWN
→ zero automatycznych retryów
→ sprawdzenie procesu, worktree i skutków
→ reconciliation
```

Dla nieidempotentnych efektów zewnętrznych wymagane jest osobne reconciliation.

Nie wolno twierdzić, że SQLite, Git i dowolny proces tworzą wspólną transakcję exactly-once.

#### Granica odpowiedzi

Context-facing odpowiedź zawiera wyłącznie bounded digest albo BLOCK.

Brak zatwierdzonego receipt, brak blobu lub niepotwierdzone wykonanie nie mogą zostać zamienione w pozornie poprawny wynik.

## S. MVP-0 ACCEPTANCE TESTS

### S.1. Sekwencja obowiązkowa

Poniższe skrypty muszą znaleźć się w `package.json`:

```json
{
  "scripts": {
    "test:ledger": "vitest run test/ledger",
    "test:adapters": "vitest run test/adapters",
    "test:state": "vitest run test/state",
    "test:guards": "vitest run test/guards",
    "test:e2e": "vitest run test/integration",
    "test:acceptance": "npm run test:ledger && npm run test:adapters && npm run test:state && npm run test:guards && npm run test:e2e"
  }
}
```

`&&` jest częścią bramki: niezaliczenie modułu zatrzymuje sekwencję.

Testy są deterministyczne i nie używają mockowanego LLM.

Nie wolno oznaczać brakujących, pominiętych lub niewykonanych testów jako spełnionej bramki.

### S.2. Pełny zestaw asercji

| Test | Asercja |
|---|---|
| Append-only ledger | UPDATE i DELETE eventu kończą się błędem storage |
| Stable event ID | Powtórne dostarczenie tego samego eventu nie tworzy nowego |
| Conflicting duplicate | Ten sam event ID z innym payloadem zostaje odrzucony |
| Raw blob integrity | Odczytane bajty i SHA-256 są identyczne z wejściem |
| Shell digest | Exit code, byte counts i wskazanie błędu zgodne z real fixture |
| Test-runner digest | Liczniki i failed test IDs zgodne z maszynowym raportem |
| Compiler digest | Kod, plik, linia i raw handle wskazują rzeczywisty błąd `tsc` |
| Git diff digest | Poprawne rename, binary files i nazwy z whitespace |
| State epoch determinism | Te same wejścia przy innym czasie pomiaru dają ten sam `epoch_id` |
| File mutation staleness | Memory active w E1 staje się stale po zmianie zależnego pliku |
| Failure fingerprint determinism | Różna kolejność kluczy JSON nie zmienia fingerprintu |
| Argument order preservation | Zmiana kolejności `argv` zmienia fingerprint |
| Third identical failure | Trzecia propozycja BLOCK przed spawn |
| Changed state | Zmiana relevant file hash pozwala na nowy eksperyment |
| Irrelevant state change | Zmiana pliku poza dependency set nie odblokowuje failure |
| Escape proof | Ważny proof pozwala na jeden retry |
| Replayed proof | Ponowne użycie tego samego proof zostaje odrzucone |
| 100 KB log | Raw ≥100 KiB zachowany; digest ≤4096 B |
| Concurrent duplicate | Dwa równoległe requests nie obchodzą reservation gate |
| Crash after intent | Po restarcie brak automatycznego retry `UNKNOWN` |
| Missing blob | Digest nie zostaje admitted |
| Test-result self-invalidation | Sam zapis nowego wyniku nie zmienia precondition epoch |

### S.3. Testy chaos i integracyjne

Obowiązkowe są również testy scenariuszy wynikających z edge cases modułów:

- Kill brokera.
- Kill procesu potomnego.
- Crash injection na granicy intent, spawn, capture, blob seal i commit.
- Disk-full.
- Duplicate concurrent proposals.
- Reopen storage.
- Niekompletny capture.
- Osierocony blob.
- Brak blobu wskazywanego przez obserwację.

Wymagany wynik:

```text
zero false success receipts
zero automatycznych retry nieznanych efektów
zero wykonanych identycznych retry bez dopuszczenia przez gate
```

### S.4. Skrypt demo

Plik: `scripts/demo.ts`.

Skrypt używa rzeczywistych procesów i tymczasowego repo, nie modelu.

Demo wykonuje się przez skompilowane artefakty (ADR-018); import `"../src/index.js"` pozostaje bez zmian.

`createLedgerMiddleware` jest cienką kompozycją czterech modułów. Nazwy helperów użytych w skrypcie stanowią kontrakt tego złożenia; helpery nie tworzą piątego modułu ani agent loop.

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createLedgerMiddleware,
  type MemoryRecord
} from "../src/index.js";

const root = await mkdtemp(join(tmpdir(), "ledger-demo-"));
const repo = join(root, "repo");
execFileSync("mkdir", ["-p", repo]);
execFileSync("git", ["init", "-q", repo]);

await writeFile(join(repo, "state.txt"), "version-one\n");

const middleware = createLedgerMiddleware({
  repositoryRoot: repo,
  databasePath: join(root, "ledger.sqlite"),
  blobDirectory: join(root, "blobs"),
  digestByteLimit: 4096,
  maxRawBytesPerExecution: 64 * 1024 * 1024
});

// SCENARIUSZ 1 — rzeczywisty failing process, potem BLOCK.
const failing = {
  kind: "shell" as const,
  executable: process.execPath,
  argv: ["-e", "process.stderr.write('KNOWN_FAILURE\\n');process.exit(7)"],
  cwd: repo,
  dependencyPaths: ["state.txt"],
  timeoutMs: 5000
};

const first = await middleware.intercept({
  ...failing, requestId: "loop-1"
});
assert.equal(first.decision, "EXECUTED");

const second = await middleware.intercept({
  ...failing, requestId: "loop-2"
});
assert.equal(second.decision, "BLOCK");

const third = await middleware.intercept({
  ...failing, requestId: "loop-3"
});
assert.equal(third.decision, "BLOCK");
assert.ok(third.previousFailureId);
assert.equal(
  middleware.executionCountForEquivalentRequest(failing),
  1
);

// SCENARIUSZ 2 — stale memory po mutacji pliku.
const e1 = await middleware.computeStateEpoch();
const memory: MemoryRecord = middleware.fileMemoryFromEpoch(
  "state.txt", e1
);

assert.equal(
  await middleware.revalidateMemory(memory, e1),
  "active"
);

await writeFile(join(repo, "state.txt"), "version-two\n");
const e2 = await middleware.computeStateEpoch();

assert.notEqual(e1.epoch_id, e2.epoch_id);
assert.equal(
  await middleware.revalidateMemory(memory, e2),
  "stale"
);

// SCENARIUSZ 3 — co najmniej 100 KiB raw, bounded digest.
const large = await middleware.intercept({
  requestId: "large-log-1",
  kind: "shell",
  executable: process.execPath,
  argv: [
    "-e",
    "process.stdout.write('x'.repeat(100 * 1024))"
  ],
  cwd: repo,
  dependencyPaths: [],
  timeoutMs: 5000
});

assert.equal(large.decision, "EXECUTED");
if (large.decision !== "EXECUTED") {
  throw new Error("Expected execution");
}

const raw = await middleware.readRawStdout(large.rawEventId);
assert.equal(raw.byteLength, 100 * 1024);
assert.equal(raw.toString("utf8"), "x".repeat(100 * 1024));

const contextFacing = JSON.stringify(large.digest);
assert.ok(Buffer.byteLength(contextFacing, "utf8") <= 4096);
assert.ok(!contextFacing.includes("x".repeat(100 * 1024)));

await middleware.close();
console.log("All three deterministic demo scenarios passed.");
```

#### Asercje demo

**Scenariusz 1 — tool loop**

```text
pierwsza próba → EXECUTED
druga próba → BLOCK
trzecia próba → BLOCK
previousFailureId istnieje
liczba wykonanych procesów dla równoważnego requestu = 1
```

**Scenariusz 2 — stale memory**

```text
memory w E1 → active
mutacja pliku
computeStateEpoch() → E2
E1.epoch_id != E2.epoch_id
revalidateMemory(memory, E2) → stale
```

**Scenariusz 3 — 100 KB log**

```text
raw output = 100 * 1024 bajty
pełny output odzyskiwalny z blob storage
digest ≤4096 bajtów UTF-8
context-facing result nie zawiera pełnego raw outputu
```

### S.5. Bramka ukończenia MVP-0

MVP-0 jest ukończone dopiero, gdy:

- Wszystkie asercje S.2 przechodzą.
- Edge cases każdego modułu mają odpowiadające testy.
- Testy S.3 przechodzą.
- Wszystkie trzy scenariusze demo przechodzą.
- Sekwencja `test:acceptance` przechodzi bez pomijania etapów.
- TypeScript przechodzi `tsc --noEmit`.
- Nie dodano piątego modułu ani provider/model loop.
- Hot path pozostaje bez wywołań LLM.

### S.6. Dodatkowa bramka wdrożenia — poza MVP-0

Po zaliczeniu testów deterministycznych trzeba uruchomić rzeczywisty Codex i sprawdzić, że model-facing wynik ma tę samą ograniczoną postać co wynik demo.

Test samej biblioteki nie dowodzi poprawnego podłączenia do hosta.

Audyt integracji MCP pozostaje poza zakresem MVP-0, a do czasu jego wykonania nie wolno deklarować potwierdzonego profilu `enforce` dla tej integracji.
