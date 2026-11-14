"""Local operator helpers for deterministic SearXNG bootstrap."""

from __future__ import annotations

import os
import secrets
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from search_tool.health import run_health_checks

CONTAINER_NAME = "krn-search-searxng-smoke"
IMAGE = "searxng/searxng:latest"
HOST_URL = "http://localhost:9999"
HOST_BIND = "127.0.0.1"
CONTAINER_PORT = 8080
DEFAULT_WAIT_SECONDS = 30.0
SETTINGS_SOURCE_PATH = "/usr/local/searxng/searx/settings.yml"


class SearxngOperatorError(RuntimeError):
    """User-facing local operator failure."""


@dataclass(frozen=True)
class SearxngStatus:
    ready: bool
    url: str
    reason: str


def runtime_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME")
    if base:
        return Path(base) / "krn-search" / "searxng"
    return Path(f"/tmp/krn-search-searxng-pnp-{os.getuid()}")


def probe_status(base_url: str = HOST_URL, *, timeout: float = 10.0) -> SearxngStatus:
    try:
        import httpx
    except Exception as exc:  # pragma: no cover - import failure is unlikely in this repo
        return SearxngStatus(False, base_url, f"httpx unavailable: {exc}")

    query_url = base_url.rstrip("/") + "/search"
    try:
        with httpx.Client(trust_env=False, timeout=timeout) as client:
            response = client.get(query_url, params={"q": "test", "format": "json"})
    except Exception as exc:
        return SearxngStatus(False, base_url, f"unreachable: {exc}")

    if response.status_code != 200:
        return SearxngStatus(False, base_url, f"unexpected HTTP {response.status_code} from {query_url}")

    content_type = response.headers.get("content-type", "")
    if "json" not in content_type.lower():
        return SearxngStatus(False, base_url, f"unexpected content-type {content_type or '<missing>'} from {query_url}")

    try:
        payload = response.json()
    except ValueError as exc:
        return SearxngStatus(False, base_url, f"invalid JSON response from {query_url}: {exc}")

    if not isinstance(payload, dict):
        return SearxngStatus(False, base_url, f"unexpected JSON payload from {query_url}")

    return SearxngStatus(True, base_url, f"queryable JSON endpoint ready at {query_url}")


def patch_settings_yaml(text: str, *, secret_key: str) -> str:
    lines = text.splitlines(keepends=True)
    section_bounds = _top_level_section_bounds(lines)

    if "search" not in section_bounds or "server" not in section_bounds:
        raise SearxngOperatorError("failed to patch SearXNG settings: missing search/server sections")

    search_start, search_end = section_bounds["search"]
    server_start, server_end = section_bounds["server"]

    search_lines = _patch_formats_block(lines[search_start:search_end])
    server_lines = lines[server_start:server_end]
    server_lines = _replace_or_insert_scalar(server_lines, "port", str(CONTAINER_PORT))
    server_lines = _replace_or_insert_scalar(server_lines, "bind_address", '"0.0.0.0"')
    server_lines = _replace_or_insert_scalar(server_lines, "secret_key", f'"{secret_key}"')

    output: list[str] = []
    output.extend(lines[:search_start])
    output.extend(search_lines)
    output.extend(lines[search_end:server_start])
    output.extend(server_lines)
    output.extend(lines[server_end:])
    return "".join(output)


def ensure_local_searxng(*, wait_seconds: float = DEFAULT_WAIT_SECONDS, base_url: str = HOST_URL) -> str:
    status = probe_status(base_url)
    if status.ready:
        return f"SearXNG already ready at {status.url}"

    _require_docker()
    existing_state = _container_state(CONTAINER_NAME)
    if existing_state is not None:
        _remove_container(CONTAINER_NAME)

    target_dir = _ensure_runtime_dir()
    settings_path = target_dir / "settings.yml"
    settings_path.write_text(
        patch_settings_yaml(_read_default_settings_from_image(), secret_key=secrets.token_hex(32)),
        encoding="utf-8",
    )

    _run_command(
        [
            "docker",
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "-v",
            f"{target_dir}:/etc/searxng",
            "-p",
            f"{HOST_BIND}:9999:{CONTAINER_PORT}",
            IMAGE,
        ]
    )

    report = run_health_checks(
        research_mode=True,
        searxng_url_override=base_url,
        searxng_wait_seconds=wait_seconds,
    )
    if report.overall_status() == "ok":
        return f"SearXNG ready at {base_url}"

    logs = _container_logs(CONTAINER_NAME)
    raise SearxngOperatorError(
        "SearXNG bootstrap failed.\n"
        f"- health: {report.to_human()}\n"
        f"- logs: docker logs {CONTAINER_NAME}\n"
        f"{logs}"
    )


def stop_local_searxng() -> str:
    _require_docker()
    state = _container_state(CONTAINER_NAME)
    if state is None:
        return f"{CONTAINER_NAME} not present"
    _remove_container(CONTAINER_NAME)
    return f"Removed {CONTAINER_NAME}"


def _ensure_runtime_dir() -> Path:
    target_dir = runtime_dir()
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        test_path = target_dir / ".write-test"
        test_path.write_text("ok", encoding="utf-8")
        test_path.unlink(missing_ok=True)
        return target_dir
    except (PermissionError, OSError):
        fallback = Path(tempfile.mkdtemp(prefix=f"krn-search-searxng-pnp-{os.getuid()}-"))
        return fallback


def _top_level_section_bounds(lines: Sequence[str]) -> dict[str, tuple[int, int]]:
    starts: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        if not line or line.startswith((" ", "\t", "#")):
            continue
        if ":" not in line:
            continue
        name = line.split(":", 1)[0].strip()
        if not name or " " in name:
            continue
        starts.append((name, index))

    bounds: dict[str, tuple[int, int]] = {}
    for idx, (name, start) in enumerate(starts):
        end = starts[idx + 1][1] if idx + 1 < len(starts) else len(lines)
        bounds[name] = (start, end)
    return bounds


def _patch_formats_block(section_lines: list[str]) -> list[str]:
    for idx, line in enumerate(section_lines):
        if line.strip() != "formats:":
            continue
        end = idx + 1
        while end < len(section_lines):
            candidate = section_lines[end]
            if candidate.startswith("    - "):
                end += 1
                continue
            break
        replacement = ["  formats:\n", "    - html\n", "    - json\n"]
        return section_lines[:idx] + replacement + section_lines[end:]

    insert_at = len(section_lines)
    while insert_at > 1 and not section_lines[insert_at - 1].strip():
        insert_at -= 1
    return section_lines[:insert_at] + ["  formats:\n", "    - html\n", "    - json\n"] + section_lines[insert_at:]


def _replace_or_insert_scalar(section_lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"  {key}:"
    for idx, line in enumerate(section_lines):
        if not line.startswith(prefix):
            continue
        comment = ""
        if "#" in line:
            _, suffix = line.split("#", 1)
            comment = f"  # {suffix.strip()}"
        section_lines[idx] = f"{prefix} {value}{comment}\n"
        return section_lines

    insert_at = 1 if section_lines else 0
    while insert_at < len(section_lines) and section_lines[insert_at].lstrip().startswith("#"):
        insert_at += 1
    return section_lines[:insert_at] + [f"{prefix} {value}\n"] + section_lines[insert_at:]


def _require_docker() -> None:
    try:
        _run_command(["docker", "--version"])
    except SearxngOperatorError as exc:
        raise SearxngOperatorError(f"Docker is required for local SearXNG bootstrap: {exc}") from exc


def _read_default_settings_from_image() -> str:
    result = _run_command(
        ["docker", "run", "--rm", "--entrypoint", "sh", IMAGE, "-lc", f"cat {SETTINGS_SOURCE_PATH}"]
    )
    if not result.stdout.strip():
        raise SearxngOperatorError("failed to read default SearXNG settings from image")
    return result.stdout


def _container_state(name: str) -> str | None:
    result = _run_command(
        ["docker", "ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.State}}"],
        check=False,
    )
    state = result.stdout.strip()
    return state or None


def _remove_container(name: str) -> None:
    _run_command(["docker", "rm", "-f", name], check=False)


def _container_logs(name: str) -> str:
    result = _run_command(["docker", "logs", name], check=False)
    stderr = result.stderr.strip()
    stdout = result.stdout.strip()
    return stderr or stdout or "<no container logs available>"


def _run_command(args: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise SearxngOperatorError(detail)
    return result
