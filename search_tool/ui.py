"""Local minimal UI testbench for krn-search."""

from __future__ import annotations

import http.server
import json
import socketserver
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlunparse

# Internal imports
import search_tool.evidence
import search_tool.search
import search_tool.run
import search_tool.cache
from search_tool.discovery import RawDiscoveryCandidate, StaticDiscoveryProvider, SearxngDiscoveryProvider
from search_tool.search import search_query, write_search_run_manifest, _quality_score
from search_tool.run import fetch_url_to_evidence, write_fetch_list_manifest
from search_tool.eval_corpus import run_corpus


HTML_TEMPLATE = r"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>[ krn-search ]</title>
    <style>
        body { background: #000; color: #0f0; font-family: 'Courier New', Courier, monospace; margin: 0; padding: 20px; font-size: 14px; }
        header { border-bottom: 1px dashed #0f0; margin-bottom: 20px; padding-bottom: 10px; }
        .warning { color: #f00; margin-bottom: 20px; border: 1px solid #f00; padding: 5px; display: inline-block; }
        .info { color: #0af; margin-bottom: 20px; border: 1px solid #0af; padding: 5px; display: inline-block; }
        section { margin-bottom: 30px; }
        h1, h2, h3 { color: #0f0; text-transform: uppercase; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"], input[type="number"], textarea, select {
            background: #000; color: #0f0; border: 1px solid #0f0;
            padding: 5px; width: 100%; box-sizing: border-box; font-family: inherit;
        }
        textarea { height: 100px; }
        button {
            background: #0f0; color: #000; border: none; padding: 5px 15px;
            cursor: pointer; font-family: inherit; font-weight: bold; text-transform: uppercase;
        }
        button:hover { background: #0c0; }
        button:disabled { background: #333; color: #666; cursor: not-allowed; }
        pre { border: 1px solid #333; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
        .tabs { border-bottom: 1px solid #0f0; margin-bottom: 20px; }
        .tab { display: inline-block; padding: 5px 15px; cursor: pointer; border: 1px solid transparent; }
        .tab.active { border: 1px solid #0f0; border-bottom: 1px solid #000; margin-bottom: -1px; background: #000; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; border: 1px solid #0f0; }
        th, td { text-align: left; padding: 5px; border: 1px solid #0f0; }
        .status-pass { color: #0f0; }
        .status-fail { color: #f00; }
        .artifact-list { list-style: none; padding: 0; }
        .artifact-item { border-bottom: 1px dashed #333; padding: 5px 0; display: flex; justify-content: space-between; }
        .artifact-link { color: #0f0; text-decoration: underline; cursor: pointer; }
        #preview-content { background: #111; border-color: #0f0; }
        .ascii-art { white-space: pre; line-height: 1; margin-bottom: 20px; color: #0f0; }
    </style>
</head>
<body>
    <div class="ascii-art">
  _  __ ____  _   _      ____  _____     _     ____   ____ _   _
 | |/ /|  _ \| \ | |    / ___|| ____|   / \   |  _ \ / ___| | | |
 | ' / | |_) |  \| |____\___ \|  _|    / _ \  | |_) | |   | |_| |
 | . \ |  _ <| |\  |_____|__) | |___  / ___ \ |  _ <| |___|  _  |
 |_|\_\|_| \_\_| \_|    |____/|_____|/_/   \_\|_| \_\\____|_| |_|
    </div>

    <div class="warning">!! LOCAL-ONLY DEV UI !! NO AUTH !! WORK-DIR: <span id="work-dir-display"></span></div>
    <div class="info" id="provider-hint">INFO: STATIC provider requires manual URLs. Use SEARXNG for live web search.</div>

    <div class="tabs">
        <div class="tab active" onclick="showTab('search-tab')">[ SEARCH ]</div>
        <div class="tab" onclick="showTab('eval-tab')">[ EVAL ]</div>
        <div class="tab" onclick="showTab('artifacts-tab')">[ ARTIFACTS ]</div>
    </div>

    <div id="search-tab" class="tab-content active">
        <section>
            <div class="form-group">
                <label>> QUERY:</label>
                <input type="text" id="query" placeholder="e.g. best mcp servers 2026">
            </div>
            <div style="display: flex; gap: 20px;">
                <div class="form-group" style="flex: 1;">
                    <label>> PROVIDER:</label>
                    <select id="provider" onchange="toggleProviderFields()">
                        <option value="static">static (manual urls)</option>
                        <option value="searxng">searxng (live search)</option>
                    </select>
                </div>
                <div class="form-group" style="flex: 1;">
                    <label>> MAX_CANDIDATES:</label>
                    <input type="number" id="max-candidates" value="10">
                </div>
            </div>

            <div id="static-fields">
                <div class="form-group">
                    <label>> CANDIDATE_URLS (PASTE LINKS HERE OR IT WON'T FIND ANYTHING):</label>
                    <textarea id="candidate-urls" placeholder="https://example.com/page1&#10;https://example.com/page2"></textarea>
                </div>
                <div class="form-group">
                    <label>> CANDIDATE_TITLES (optional):</label>
                    <textarea id="candidate-titles"></textarea>
                </div>
            </div>

            <div id="searxng-fields" style="display:none;">
                <div class="form-group">
                    <label>> SEARXNG_URL (LIVE SEARCH READY ON PORT 9999):</label>
                    <input type="text" id="searxng-url" value="http://localhost:9999">
                </div>
            </div>

            <div class="form-group">
                <label><input type="checkbox" id="refresh"> REFRESH</label>
                <label><input type="checkbox" id="follow-redirects"> FOLLOW_REDIRECTS</label>
            </div>

            <button id="run-search" onclick="runSearch()">EXECUTE</button>
            <button style="background: #333; color: #0f0; margin-left: 10px;" onclick="loadExample()">LOAD_EXAMPLE</button>
        </section>

        <section id="search-results" style="display:none;">
            <hr style="border: 0; border-top: 1px solid #0f0;">
            <h3>Results:</h3>
            <div id="search-errors" style="margin-bottom: 20px;"></div>
            <div id="search-summary"></div>
            <div id="search-evidence-container"></div>
            <div id="preview-container" style="display:none; margin-top: 20px;">
                <h3>Preview: <span id="preview-filename"></span></h3>
                <pre id="preview-content"></pre>
            </div>
            <details style="margin-top: 20px; color: #666;">
                <summary>[ view raw json ]</summary>
                <pre id="search-output" style="border-color: #333;"></pre>
            </details>
        </section>
    </div>

    <div id="eval-tab" class="tab-content">
        <section>
            <div class="form-group">
                <label>> CORPUS_PATH:</label>
                <input type="text" id="corpus-path" value="tests/fixtures/search_corpus/basic.json">
            </div>
            <button id="run-eval" onclick="runEval()">RUN_EVAL</button>
        </section>

        <section id="eval-results" style="display:none;">
            <h3>Eval Status: <span id="eval-summary"></span></h3>
            <div id="eval-table-container"></div>
            <details style="margin-top: 20px; color: #666;">
                <summary>[ view raw json ]</summary>
                <pre id="eval-output" style="border-color: #333;"></pre>
            </details>
        </section>
    </div>

    <div id="artifacts-tab" class="tab-content">
        <section>
            <button onclick="loadArtifacts()">REFRESH_LIST</button>
            <ul id="artifact-list" class="artifact-list"></ul>
        </section>
        <section id="artifact-view" style="display:none;">
            <h3>File: <span id="artifact-filename"></span></h3>
            <pre id="artifact-content"></pre>
        </section>
    </div>

    <script>
        function showTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector(`[onclick="showTab('${tabId}')"]`).classList.add('active');
            document.getElementById(tabId).classList.add('active');
            if (tabId === 'artifacts-tab') loadArtifacts();
        }

        function toggleProviderFields() {
            const provider = document.getElementById('provider').value;
            document.getElementById('static-fields').style.display = provider === 'static' ? 'block' : 'none';
            document.getElementById('searxng-fields').style.display = provider === 'searxng' ? 'block' : 'none';
            const hint = document.getElementById('provider-hint');
            if (provider === 'static') {
                hint.innerText = "INFO: STATIC provider requires manual URLs. Use SEARXNG for live web search.";
                hint.style.color = "#0af";
                hint.style.borderColor = "#0af";
            } else {
                hint.innerText = "WARNING: SEARXNG requires a running instance (e.g. docker run searxng/searxng).";
                hint.style.color = "#f80";
                hint.style.borderColor = "#f80";
            }
        }

        function loadExample() {
            document.getElementById('query').value = 'Python programming language';
            document.getElementById('provider').value = 'static';
            document.getElementById('candidate-urls').value = 'https://en.wikipedia.org/wiki/Python_(programming_language)\nhttps://www.python.org/about/\nhttps://docs.python.org/3/tutorial/index.html';
            document.getElementById('candidate-titles').value = 'Python Wikipedia\nAbout Python\nPython Tutorial';
            toggleProviderFields();
        }

        async function apiPost(url, data) {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await response.json();
        }

        async function runSearch() {
            const btn = document.getElementById('run-search');
            btn.disabled = true;
            btn.innerText = 'WORKING...';
            document.getElementById('preview-container').style.display = 'none';
            document.getElementById('search-errors').innerHTML = '';

            const data = {
                query: document.getElementById('query').value,
                provider: document.getElementById('provider').value,
                max_candidates: parseInt(document.getElementById('max-candidates').value),
                refresh: document.getElementById('refresh').checked,
                follow_redirects: document.getElementById('follow-redirects').checked,
            };

            if (data.provider === 'static') {
                data.candidate_urls = document.getElementById('candidate-urls').value.split('\n').filter(u => u.trim());
                data.candidate_titles = document.getElementById('candidate-titles').value.split('\n').filter(t => t.trim());
            } else {
                data.searxng_url = document.getElementById('searxng-url').value;
            }

            try {
                const result = await apiPost('/api/search-query', data);
                document.getElementById('search-results').style.display = 'block';
                document.getElementById('search-output').innerText = JSON.stringify(result, null, 2);

                if (result.error) {
                    document.getElementById('search-summary').innerHTML = `<p class="status-fail">ERROR: ${result.error}</p>`;
                    return;
                }

                if (result.discovery.errors && result.discovery.errors.length > 0) {
                    let errHtml = '<ul>';
                    result.discovery.errors.forEach(e => {
                        errHtml += `<li class="status-fail"><b>${e.code}:</b> ${e.message}</li>`;
                    });
                    errHtml += '</ul>';
                    document.getElementById('search-errors').innerHTML = errHtml;
                }

                const candidates = result.discovery?.candidates || [];
                const selected = candidates.filter(c => c.selected_for_fetch).length;
                const blocked = candidates.filter(c => c.url_policy === 'blocked').length;
                const duplicates = candidates.filter(c => c.duplicate_of !== null && c.duplicate_of !== undefined).length;
                const discoveryErrors = (result.discovery?.errors || []).length;

                if (candidates.length === 0) {
                    let msg = "DISCOVERY RETURNED 0 RESULTS.";
                    if (data.provider === 'static') msg += " (Static provider needs URLs to ingest!)";
                    document.getElementById('search-summary').innerHTML = `<p class="status-fail">${msg}</p>`;
                    document.getElementById('search-evidence-container').innerHTML = "";
                    return;
                }

                let summaryHtml = `
                    <p><b>DISCOVERY:</b><br>
                    - ${candidates.length} candidates found<br>
                    - ${selected} selected<br>
                    - ${blocked} blocked<br>
                    - ${duplicates} duplicates<br>
                    - ${discoveryErrors} errors</p>
                `;

                const evidence = result.evidence_results || [];
                const total = evidence.length;
                const extracted = evidence.filter(r => r.fetch_status === 'success' && r.extraction_status === 'success').length;
                const truncated = evidence.filter(r => r.extraction_status === 'truncated').length;
                const redirects = evidence.filter(r => r.http_status >= 300 && r.http_status < 400).length;
                const blockedFetch = evidence.filter(r => r.fetch_status === 'blocked').length;
                const failed = evidence.filter(r => r.fetch_status === 'failed').length;
                const skipped = evidence.filter(r => r.extraction_status === 'skipped').length;

                summaryHtml += `
                    <p><b>INGESTION:</b><br>
                    - ${total} packs total<br>
                    - ${extracted} extracted<br>
                    - ${truncated} truncated<br>
                    - ${redirects} redirects not followed<br>
                    - ${failed} failed<br>
                    - ${blockedFetch} blocked<br>
                    - ${skipped} skipped</p>
                `;

                if (redirects > 0) {
                    summaryHtml += `<p class="info">Some results are redirects. Enable Follow Redirects to fetch final pages.</p>`;
                }

                summaryHtml += '<p><b>ARTIFACTS:</b><br>';
                if (result.manifest_path) {
                    summaryHtml += `- <span class="artifact-link" onclick="viewArtifact('${result.manifest_path}')">Fetch List Manifest</span><br>`;
                }
                if (result.search_manifest_path) {
                    summaryHtml += `- <span class="artifact-link" onclick="viewArtifact('${result.search_manifest_path}')">Search Run Manifest</span><br>`;
                }
                summaryHtml += '</p>';

                document.getElementById('search-summary').innerHTML = summaryHtml;

                let table = '<table><tr><th>URL</th><th>STATUS</th><th>QUAL</th><th>ACTION</th></tr>';
                result.evidence_results.forEach(r => {
                    const statusClass = r.fetch_status === 'success' ? 'status-pass' : 'status-fail';
                    table += `<tr>
                        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${r.original_url}</td>
                        <td class="${statusClass}">${r.fetch_status.toUpperCase()}</td>
                        <td>${Number.isInteger(r.quality_score) ? r.quality_score : 0}/3</td>
                        <td><button onclick="viewPreview('${r.evidence_path}')" style="padding: 0 5px; font-size: 10px;">VIEW</button></td>
                    </tr>`;
                });
                table += '</table>';
                document.getElementById('search-evidence-container').innerHTML = table;
            } catch (e) {
                alert('ERROR: ' + e);
            } finally {
                btn.disabled = false;
                btn.innerText = 'EXECUTE';
            }
        }

        async function viewPreview(path) {
            const response = await fetch('/api/artifact?path=' + encodeURIComponent(path));
            const content = await response.text();
            document.getElementById('preview-container').style.display = 'block';
            document.getElementById('preview-filename').innerText = path;
            document.getElementById('preview-content').innerText = content;
        }

        async function runEval() {
            const btn = document.getElementById('run-eval');
            btn.disabled = true;
            btn.innerText = 'WORKING...';

            try {
                const result = await apiPost('/api/eval-corpus', {
                    corpus_path: document.getElementById('corpus-path').value
                });
                document.getElementById('eval-results').style.display = 'block';
                document.getElementById('eval-output').innerText = JSON.stringify(result, null, 2);

                if (result.error) {
                    document.getElementById('eval-summary').innerHTML = `<span class="status-fail">ERROR: ${result.error}</span>`;
                    return;
                }

                document.getElementById('eval-summary').innerHTML = `[ <span class="status-${result.status.toLowerCase()}">${result.status}</span> ] ${result.scenarios_passed}/${result.scenarios_total} PASSED`;

                let table = '<table><tr><th>SCENARIO</th><th>STATUS</th><th>MESSAGE</th></tr>';
                result.results.forEach(r => {
                    table += `<tr>
                        <td>${r.scenario_id}</td>
                        <td class="status-${r.status.toLowerCase()}">${r.status}</td>
                        <td>${r.message || ''}</td>
                    </tr>`;
                });
                table += '</table>';
                document.getElementById('eval-table-container').innerHTML = table;
            } catch (e) {
                alert('ERROR: ' + e);
            } finally {
                btn.disabled = false;
                btn.innerText = 'RUN_EVAL';
            }
        }

        async function loadArtifacts() {
            const response = await fetch('/api/artifacts');
            const artifacts = await response.json();
            const list = document.getElementById('artifact-list');
            list.innerHTML = '';
            artifacts.forEach(a => {
                const li = document.createElement('li');
                li.className = 'artifact-item';
                li.innerHTML = `
                    <span class="artifact-link" onclick="viewArtifact('${a.path}')">${a.name}</span>
                    <small style="color: #666;">${a.mtime}</small>
                `;
                list.appendChild(li);
            });
        }

        async function viewArtifact(path) {
            const response = await fetch('/api/artifact?path=' + encodeURIComponent(path));
            const content = await response.text();
            document.getElementById('artifact-view').style.display = 'block';
            document.getElementById('artifact-filename').innerText = path;
            document.getElementById('artifact-content').innerText = content;
            document.getElementById('artifact-view').scrollIntoView({ behavior: 'smooth' });
        }

        async function loadHealth() {
            const response = await fetch('/api/health');
            const health = await response.json();
            document.getElementById('work-dir-display').innerText = health.work_dir;
        }

        loadHealth();
    </script>
</body>
</html>
"""


def _sanitize_provider_url(url: str) -> str:
    """Redact credentials and path/query/fragment from provider URL."""
    try:
        parsed = urlparse(url)
        if not parsed.hostname:
            return "[REDACTED]"
        netloc = parsed.hostname
        if parsed.port:
            netloc = f"{netloc}:{parsed.port}"
        return urlunparse((parsed.scheme, netloc, "", "", "", ""))
    except Exception:
        return "[REDACTED]"


class UIRequestHandler(http.server.BaseHTTPRequestHandler):
    work_dir: Path

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(HTML_TEMPLATE.encode("utf-8"))
        elif parsed.path == "/api/health":
            self._send_json({
                "status": "ok",
                "work_dir": str(self.work_dir),
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
        elif parsed.path == "/api/artifacts":
            artifacts = []
            if self.work_dir.exists():
                # Look for .md and .json files
                for p in sorted(self.work_dir.rglob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
                    if p.is_file() and p.suffix in (".md", ".json"):
                        try:
                            rel = p.relative_to(self.work_dir)
                            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat()
                            artifacts.append({"name": str(rel), "path": str(rel), "mtime": mtime})
                        except ValueError:
                            continue
            self._send_json(artifacts)
        elif parsed.path == "/api/artifact":
            qs = parse_qs(parsed.query)
            rel_path = qs.get("path", [""])[0]
            if not rel_path:
                self.send_error(400, "Missing path")
                return

            # Security: path confinement
            try:
                safe_path = (self.work_dir / rel_path).resolve()
                if not safe_path.is_relative_to(self.work_dir.resolve()):
                    self.send_error(403, "Forbidden")
                    return
                if not safe_path.exists() or not safe_path.is_file():
                    self.send_error(404, "Not Found")
                    return

                content = safe_path.read_text(encoding="utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(content.encode("utf-8"))
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception:
            self._send_json({"error": "Invalid JSON"}, status=400)
            return

        if parsed.path == "/api/search-query":
            self._handle_search_query(body)
        elif parsed.path == "/api/eval-corpus":
            self._handle_eval_corpus(body)
        else:
            self.send_error(404)

    def _handle_search_query(self, body: dict):
        query = body.get("query", "").strip()
        if not query:
            self._send_json({"error": "Query must not be empty"}, status=400)
            return

        provider_name = body.get("provider", "static")
        max_candidates = int(body.get("max_candidates", 10))
        refresh = bool(body.get("refresh", False))
        follow_redirects = bool(body.get("follow_redirects", False))

        print(f"[UI] Running search: query='{query}' provider={provider_name}")

        try:
            if provider_name == "static":
                urls = body.get("candidate_urls", [])
                print(f"[UI] Static URLs: {len(urls)}")
                titles = body.get("candidate_titles", [])
                candidates = []
                for i, url in enumerate(urls):
                    candidates.append(RawDiscoveryCandidate(
                        url=url,
                        title=titles[i] if i < len(titles) else None
                    ))
                provider = StaticDiscoveryProvider(name="static", candidates=tuple(candidates))
                provider_config = {"candidate_urls": urls}
            elif provider_name == "searxng":
                searxng_url = body.get("searxng_url", "")
                print(f"[UI] SearXNG URL: {searxng_url}")
                if not searxng_url:
                    self._send_json({"error": "SearXNG URL required"}, status=400)
                    return
                provider = SearxngDiscoveryProvider(base_url=searxng_url)
                provider_config = {"searxng_url_redacted": _sanitize_provider_url(searxng_url)}
            else:
                self._send_json({"error": "Unknown provider"}, status=400)
                return

            # Patch EVIDENCE_DIR and CACHE_DIR to UI work dir
            # We use a run-specific subdirectory for evidence to ensure isolation
            run_id = datetime.now().strftime("%Y%m%dT%H%M%SZ")
            run_dir = self.work_dir / "runs" / run_id
            run_dir.mkdir(parents=True, exist_ok=True)

            search_tool.evidence.EVIDENCE_DIR = run_dir
            search_tool.search.EVIDENCE_DIR = run_dir
            search_tool.run.EVIDENCE_DIR = run_dir

            # Cache stays at top level of work_dir to allow reuse across runs
            search_tool.cache.CACHE_DIR = self.work_dir / "cache"
            search_tool.cache.OBJECTS_DIR = search_tool.cache.CACHE_DIR / "objects"
            search_tool.cache.ENTRIES_DIR = search_tool.cache.CACHE_DIR / "entries"

            result = search_query(
                provider=provider,
                query=query,
                max_candidates=max_candidates,
                refresh=refresh,
                follow_redirects=follow_redirects,
                fetcher=fetch_url_to_evidence,
                manifest_writer=write_fetch_list_manifest,
                search_manifest_writer=write_search_run_manifest,
                provider_config=provider_config,
            )

            # Convert SearchRunResult to dict for JSON
            # Return paths relative to work_dir for easier artifact retrieval
            def _path_to_str(obj):
                if isinstance(obj, Path):
                    try:
                        return str(obj.relative_to(self.work_dir))
                    except ValueError:
                        return str(obj)
                raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")

            # Build summaries for UI
            candidates = result.discovery.candidates
            discovery_summary = {
                "candidates_total": len(candidates),
                "selected": sum(1 for c in candidates if c.selected_for_fetch),
                "blocked": sum(1 for c in candidates if c.url_policy == "blocked"),
                "duplicates": sum(1 for c in candidates if c.duplicate_of is not None),
                "errors": len(result.discovery.errors),
            }

            evidence = result.evidence_results
            ingestion_summary = {
                "packs_total": len(evidence),
                "extracted": sum(1 for r in evidence if r.fetch_status == "success" and r.extraction_status == "success"),
                "truncated": sum(1 for r in evidence if r.extraction_status == "truncated"),
                "redirects": sum(1 for r in evidence if 300 <= (r.http_status or 0) < 400),
                "failed": sum(1 for r in evidence if r.fetch_status == "failed"),
                "blocked": sum(1 for r in evidence if r.fetch_status == "blocked"),
                "skipped": sum(1 for r in evidence if r.extraction_status == "skipped"),
            }

            resp_data = asdict(result)
            resp_data["discovery_summary"] = discovery_summary
            resp_data["ingestion_summary"] = ingestion_summary

            for i, r in enumerate(result.evidence_results):
                resp_data["evidence_results"][i]["quality_score"] = _quality_score(r)

            self._send_json(resp_data, default=_path_to_str)
        except Exception as e:
            print(f"[UI] Error during search: {e}")
            self._send_json({"error": str(e)}, status=500)

    def _handle_eval_corpus(self, body: dict):
        corpus_path_str = body.get("corpus_path", "")
        if not corpus_path_str:
            self._send_json({"error": "Corpus path required"}, status=400)
            return

        corpus_path = Path(corpus_path_str)
        if not corpus_path.exists():
            self._send_json({"error": f"Corpus file not found: {corpus_path}"}, status=400)
            return

        try:
            # For eval-corpus, we use scenario-specific subdirs under UI work_dir
            eval_work_dir = self.work_dir / "eval-runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
            eval_work_dir.mkdir(parents=True, exist_ok=True)

            results = run_corpus(corpus_path, work_dir=eval_work_dir)

            passed = sum(1 for r in results if r.status == "PASS")
            failed = sum(1 for r in results if r.status == "FAIL")
            errors = sum(1 for r in results if r.status == "ERROR")

            summary = {
                "status": "PASS" if failed == 0 and errors == 0 else "FAIL",
                "scenarios_total": len(results),
                "scenarios_passed": passed,
                "scenarios_failed": failed + errors,
                "results": [asdict(r) for r in results]
            }
            self._send_json(summary)
        except Exception as e:
            self._send_json({"error": str(e)}, status=500)

    def _send_json(self, data: dict | list, status: int = 200, default=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, default=default).encode("utf-8"))


def run_ui_server(port: int, host: str, work_dir: Path):
    """Run the local UI server."""
    work_dir.mkdir(parents=True, exist_ok=True)

    class CustomHandler(UIRequestHandler):
        def __init__(self, *args, **kwargs):
            self.work_dir = work_dir
            super().__init__(*args, **kwargs)

    # Note: socketserver.TCPServer with allow_reuse_address
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, port), CustomHandler) as httpd:
        print(f"krn-search local testbench running at http://{host}:{port}")
        print(f"Artifacts will be stored in: {work_dir}")
        print("WARNING: This is a local-only development UI. Do not expose publicly.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping UI server...")
            sys.exit(0)
