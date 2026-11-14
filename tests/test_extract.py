"""Tests for extraction module."""

from search_tool.extract import extract, MAX_EXTRACTED_CHARS


class TestHtmlExtraction:
    def test_basic_html(self):
        html = b"<html><head><title>Test Page</title></head><body><p>Hello world</p></body></html>"
        result = extract(html, "text/html")
        assert result.status == "success"
        assert result.method == "beautifulsoup4-html-text"
        assert result.title == "Test Page"
        assert "Hello world" in result.text
        assert result.text_chars > 0
        assert not result.truncated

    def test_script_removal(self):
        html = b'<html><body><p>Visible</p><script>alert("xss")</script></body></html>'
        result = extract(html, "text/html")
        assert "Visible" in result.text
        assert "alert" not in result.text

    def test_style_removal(self):
        html = b'<html><body><p>Text</p><style>body{display:none}</style></body></html>'
        result = extract(html, "text/html")
        assert "Text" in result.text
        assert "display:none" not in result.text

    def test_noscript_removal(self):
        html = b"<html><body><noscript>Hidden</noscript><p>Shown</p></body></html>"
        result = extract(html, "text/html")
        assert "Shown" in result.text

    def test_no_title(self):
        html = b"<html><body><p>No title here</p></body></html>"
        result = extract(html, "text/html")
        assert result.title is None

    def test_malformed_html(self):
        html = b"<html><body><p>unclosed paragraph<div>nested</p></body>"
        result = extract(html, "text/html")
        assert result.status == "success"
        assert "unclosed paragraph" in result.text
        assert result.errors == []

    def test_empty_html(self):
        result = extract(b"", "text/html")
        assert result.status == "success"
        assert result.text_chars == 0

    def test_github_like_page_prefers_readme_content_and_strips_chrome(self):
        html = b"""
        <html>
          <head><title>Repo</title></head>
          <body>
            <div>Skip to content</div>
            <div>You signed in with another tab or window.</div>
            <main role="main">
              <div>Folders and files</div>
              <div>Repository files navigation</div>
              <article class="markdown-body entry-content container-lg" itemprop="text">
                <h1>Excalidraw MCP Server &amp; Agent Skill</h1>
                <p>Run a live Excalidraw canvas and control it from AI agents.</p>
                <h2>Quick Start</h2>
                <p>npm ci</p>
              </article>
              <div>Uh oh!</div>
              <div>There was an error while loading.</div>
            </main>
          </body>
        </html>
        """
        result = extract(html, "text/html")
        assert "Excalidraw MCP Server & Agent Skill" in result.text
        assert "Run a live Excalidraw canvas" in result.text
        assert "Quick Start" in result.text
        assert "Skip to content" not in result.text
        assert "You signed in with another tab or window." not in result.text
        assert "Folders and files" not in result.text
        assert "Repository files navigation" not in result.text
        assert "There was an error while loading." not in result.text

    def test_stitches_fragmented_punctuation_lines(self):
        html = b"""
        <html><body>
          <article class="markdown-body">
            <p>MCP Server</p>
            <p>: Connect via Model Context Protocol</p>
            <p>align_elements</p>
            <p>, distribute_elements</p>
          </article>
        </body></html>
        """
        result = extract(html, "text/html")
        assert "MCP Server: Connect via Model Context Protocol" in result.text
        assert "align_elements, distribute_elements" in result.text

    def test_preserves_real_content_starting_with_github_ui_words(self):
        html = b"""
        <html><body>
          <article>
            <p>Fork this repository to customize the setup.</p>
            <p>Star charts are supported by this renderer.</p>
            <p>Tags can be configured per release.</p>
          </article>
        </body></html>
        """
        result = extract(html, "text/html")
        assert "Fork this repository to customize the setup." in result.text
        assert "Star charts are supported by this renderer." in result.text
        assert "Tags can be configured per release." in result.text


class TestPlainTextExtraction:
    def test_basic_text(self):
        result = extract(b"Hello world\nLine two", "text/plain")
        assert result.status == "success"
        assert result.method == "plain-text"
        assert "Hello world" in result.text
        assert "Line two" in result.text

    def test_crlf_normalization(self):
        result = extract(b"line1\r\nline2\rline3", "text/plain")
        assert "\r" not in result.text


class TestUnsupportedContent:
    def test_pdf_skipped(self):
        result = extract(b"%PDF-1.4...", "application/pdf")
        assert result.status == "skipped"
        assert result.method == "none"

    def test_image_skipped(self):
        result = extract(b"\x89PNG\r\n", "image/png")
        assert result.status == "skipped"

    def test_octet_stream_skipped(self):
        result = extract(b"\x00\x01\x02", "application/octet-stream")
        assert result.status == "skipped"

    def test_no_body_skipped(self):
        result = extract(None, "text/html")
        assert result.status == "skipped"
        assert result.method == "none"


class TestWhitespaceNormalization:
    def test_collapses_blank_lines(self):
        html = b"<html><body><p>a</p><p>b</p></body></html>"
        result = extract(html, "text/html")
        # Should not have excessive blank lines
        blank_runs = 0
        for line in result.text.split("\n"):
            if line.strip() == "":
                blank_runs += 1
            else:
                blank_runs = 0
        assert blank_runs <= 1
