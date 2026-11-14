"""Session: multi-query research session with metadata tracking."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from search_tool.evidence import _yaml_safe

SESSIONS_DIR = "sessions"
SESSION_META_FILENAME = "session.yaml"
SCHEMA_VERSION = "0.1"


@dataclass
class SessionRunRecord:
    run_id: str
    query: str
    query_sha256: str
    provider: str
    profile: str | None
    status: str  # "ok", "partial_success", "error"
    sources_total: int
    sources_succeeded: int
    sources_failed: int
    best_evidence_relevance: float
    created_at: str


@dataclass
class SessionMetadata:
    schema_version: str = SCHEMA_VERSION
    session_id: str = ""
    topic: str = ""
    created_at: str = ""
    updated_at: str = ""
    status: str = "active"
    runs_total: int = 0
    runs: list[SessionRunRecord] = field(default_factory=list)


def generate_session_id(topic: str) -> str:
    topic_hash = hashlib.sha256(topic.encode()).hexdigest()[:12]
    return f"session-{topic_hash}"


def session_dir_path(work_dir: Path, session_id: str) -> Path:
    return work_dir / SESSIONS_DIR / session_id


def _serialize_yaml(meta: SessionMetadata) -> str:
    lines = [
        f'schema_version: "{_yaml_safe(meta.schema_version)}"',
        f'session_id: "{_yaml_safe(meta.session_id)}"',
        f'topic: "{_yaml_safe(meta.topic)}"',
        f'created_at: "{_yaml_safe(meta.created_at)}"',
        f'updated_at: "{_yaml_safe(meta.updated_at)}"',
        f'status: "{_yaml_safe(meta.status)}"',
        f"runs_total: {meta.runs_total}",
        "runs:",
    ]
    for run in meta.runs:
        lines.append(f'  - run_id: "{_yaml_safe(run.run_id)}"')
        lines.append(f'    query: "{_yaml_safe(run.query)}"')
        lines.append(f'    query_sha256: "{_yaml_safe(run.query_sha256)}"')
        lines.append(f'    provider: "{_yaml_safe(run.provider)}"')
        if run.profile is not None:
            lines.append(f'    profile: "{_yaml_safe(run.profile)}"')
        else:
            lines.append("    profile: null")
        lines.append(f'    status: "{_yaml_safe(run.status)}"')
        lines.append(f"    sources_total: {run.sources_total}")
        lines.append(f"    sources_succeeded: {run.sources_succeeded}")
        lines.append(f"    sources_failed: {run.sources_failed}")
        lines.append(f"    best_evidence_relevance: {run.best_evidence_relevance}")
        lines.append(f'    created_at: "{_yaml_safe(run.created_at)}"')
    return "\n".join(lines) + "\n"


def _unquote_yaml(raw: str) -> str:
    """Single-pass left-to-right unescaping of YAML double-quoted values."""
    result: list[str] = []
    i = 0
    while i < len(raw):
        if raw[i] == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            if nxt == "\\":
                result.append("\\")
                i += 2
            elif nxt == '"':
                result.append('"')
                i += 2
            elif nxt == "n":
                result.append("\n")
                i += 2
            elif nxt == "r":
                result.append("\r")
                i += 2
            elif nxt == "t":
                result.append("\t")
                i += 2
            else:
                result.append(raw[i])
                i += 1
        else:
            result.append(raw[i])
            i += 1
    return "".join(result)


def _parse_yaml_value(raw: str) -> str | int | float | None:
    raw = raw.strip()
    if raw.startswith('"') and raw.endswith('"'):
        return _unquote_yaml(raw[1:-1])
    if raw == "null":
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


_RUN_KEYS = frozenset({
    "run_id", "query", "query_sha256", "provider", "profile",
    "status", "sources_total", "sources_succeeded", "sources_failed",
    "best_evidence_relevance", "created_at",
})


def _parse_yaml(text: str) -> SessionMetadata:
    """Parse session.yaml text produced by _serialize_yaml."""
    lines = text.split("\n")
    meta = SessionMetadata()
    runs: list[SessionRunRecord] = []
    current_run: dict | None = None
    in_runs = False

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if in_runs:
            if stripped.startswith("- "):
                if current_run is not None:
                    runs.append(SessionRunRecord(**current_run))
                kv = stripped[2:]
                key, _, val = kv.partition(":")
                current_run = {key.strip(): _parse_yaml_value(val)}
                continue
            if current_run is not None:
                key, _, val = stripped.partition(":")
                key = key.strip()
                if key in _RUN_KEYS:
                    current_run[key] = _parse_yaml_value(val)
                    continue
                in_runs = False
                if current_run is not None:
                    runs.append(SessionRunRecord(**current_run))
                    current_run = None

        if not in_runs:
            if stripped == "runs:":
                in_runs = True
                continue

            key, _, val = stripped.partition(":")
            key = key.strip()
            parsed = _parse_yaml_value(val)
            if key == "schema_version" and parsed is not None:
                meta.schema_version = str(parsed)
            elif key == "session_id" and parsed is not None:
                meta.session_id = str(parsed)
            elif key == "topic" and parsed is not None:
                meta.topic = str(parsed)
            elif key == "created_at" and parsed is not None:
                meta.created_at = str(parsed)
            elif key == "updated_at" and parsed is not None:
                meta.updated_at = str(parsed)
            elif key == "status" and parsed is not None:
                meta.status = str(parsed)
            elif key == "runs_total" and parsed is not None:
                meta.runs_total = int(parsed)

    if current_run is not None:
        runs.append(SessionRunRecord(**current_run))

    meta.runs = runs
    return meta


def _validate_metadata(meta: SessionMetadata, session_dir: Path) -> bool:
    """Validate session metadata has required fields and consistent session_id.

    Returns False for metadata that cannot be trusted (corrupted/junk content).
    """
    if meta.schema_version != SCHEMA_VERSION:
        return False
    if not meta.session_id:
        return False
    if not meta.status:
        return False
    if meta.session_id != session_dir.name:
        return False
    if not isinstance(meta.runs_total, int):
        return False
    return True


def _write_metadata(session_dir: Path, meta: SessionMetadata) -> None:
    """Write session metadata atomically via temp file + os.replace."""
    target = session_dir / SESSION_META_FILENAME
    content = _serialize_yaml(meta)
    fd, tmp = tempfile.mkstemp(dir=str(session_dir))
    try:
        os.write(fd, content.encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, str(target))


def create_session(work_dir: Path, topic: str) -> tuple[Path, SessionMetadata]:
    """Create a new session or return existing session for the topic.

    Same topic always maps to the same session ID and directory.
    If session.yaml is missing or corrupted, attempts recovery from run artifacts.
    """
    session_id = generate_session_id(topic)
    session_dir = session_dir_path(work_dir, session_id)

    existing = load_session_metadata(session_dir)
    if existing is not None:
        return session_dir, existing

    # Metadata missing or corrupted — attempt recovery from run artifacts.
    recovered = recover_session_metadata(session_dir)
    if recovered is not None:
        # Recovery cannot reconstruct the original topic. Fill it from the caller.
        recovered.topic = topic
        try:
            _write_metadata(session_dir, recovered)
        except Exception:
            pass
        return session_dir, recovered

    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "runs").mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()
    meta = SessionMetadata(
        session_id=session_id,
        topic=topic,
        created_at=now,
        updated_at=now,
    )
    _write_metadata(session_dir, meta)
    return session_dir, meta


def load_session_metadata(session_dir: Path) -> SessionMetadata | None:
    """Load session metadata. Returns None if missing or corrupted."""
    meta_path = session_dir / SESSION_META_FILENAME
    if not meta_path.exists():
        return None
    try:
        text = meta_path.read_text(encoding="utf-8")
        parsed = _parse_yaml(text)
    except Exception:
        return None
    if not _validate_metadata(parsed, session_dir):
        return None
    return parsed


def update_session_metadata(
    session_dir: Path, run_record: SessionRunRecord,
) -> SessionMetadata | None:
    """Append a run record to session metadata. Best-effort: returns None on failure."""
    meta = load_session_metadata(session_dir)
    if meta is None:
        meta = recover_session_metadata(session_dir)
    if meta is None:
        return None

    meta.runs.append(run_record)
    meta.runs_total = len(meta.runs)
    meta.updated_at = datetime.now(timezone.utc).isoformat()

    try:
        _write_metadata(session_dir, meta)
    except Exception:
        return None

    return meta


def recover_session_metadata(session_dir: Path) -> SessionMetadata | None:
    """Reconstruct session metadata by scanning run directories for search-run.json."""
    runs_dir = session_dir / "runs"
    if not runs_dir.exists():
        return None

    session_id = session_dir.name
    run_records: list[SessionRunRecord] = []
    earliest_time: datetime | None = None

    for run_path in sorted(runs_dir.iterdir()):
        if not run_path.is_dir():
            continue
        json_path = run_path / "search-run.json"
        if not json_path.exists():
            continue
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        run_id = run_path.name
        query = data.get("query", {}).get("redacted", "")
        query_sha256 = data.get("query", {}).get("hash_sha256", "")
        provider = data.get("discovery", {}).get("provider") or "unknown"
        status = data.get("status", "error")

        evidence_results = data.get("evidence_results", [])
        failures = data.get("failures", [])
        sources_total = len(evidence_results) + len(failures)
        sources_succeeded = sum(
            1 for e in evidence_results
            if e.get("status") in ("success", "skipped_duplicate")
        )
        sources_failed = sources_total - sources_succeeded

        relevance_entries = data.get("evidence_relevance", [])
        best_rel = max(
            (r.get("score", 0.0) for r in relevance_entries), default=0.0,
        )

        profile_data = data.get("profile")
        profile = profile_data.get("name") if isinstance(profile_data, dict) else None

        created_at = ""
        try:
            ts_part = run_id.split("-")[0]
            dt = datetime.strptime(ts_part, "%Y%m%dT%H%M%SZ").replace(
                tzinfo=timezone.utc,
            )
            created_at = dt.isoformat()
            if earliest_time is None or dt < earliest_time:
                earliest_time = dt
        except (ValueError, IndexError):
            pass

        run_records.append(SessionRunRecord(
            run_id=run_id,
            query=query,
            query_sha256=query_sha256,
            provider=provider,
            profile=profile,
            status=status,
            sources_total=sources_total,
            sources_succeeded=sources_succeeded,
            sources_failed=sources_failed,
            best_evidence_relevance=round(best_rel, 2),
            created_at=created_at,
        ))

    if not run_records:
        return None

    meta = SessionMetadata(
        session_id=session_id,
        topic="",
        created_at=earliest_time.isoformat() if earliest_time else "",
        updated_at=datetime.now(timezone.utc).isoformat(),
        status="recovered",
        runs_total=len(run_records),
        runs=run_records,
    )

    try:
        _write_metadata(session_dir, meta)
    except Exception:
        pass

    return meta
