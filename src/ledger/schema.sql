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

CREATE INDEX events_session_seq ON events(session_id, seq);
CREATE INDEX events_kind_time ON events(kind, source_timestamp);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER event_blobs_no_update BEFORE UPDATE ON event_blobs BEGIN
  SELECT RAISE(ABORT, 'event sources are immutable');
END;
CREATE TRIGGER event_blobs_no_delete BEFORE DELETE ON event_blobs BEGIN
  SELECT RAISE(ABORT, 'event sources are immutable');
END;

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
