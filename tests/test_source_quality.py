"""Tests for deterministic source quality classifier."""

from search_tool.source_quality import classify_source_quality, SourceQuality, SOURCE_TYPES


class TestOfficialDocs:
    def test_docs_python_org(self):
        sq = classify_source_quality("https://docs.python.org/3/library/asyncio.html")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3
        assert sq.is_official is True
        assert sq.is_primary_source is True
        assert sq.domain == "docs.python.org"

    def test_docs_anthropic_com(self):
        sq = classify_source_quality("https://docs.anthropic.com/en/docs/claude-code/hooks")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_code_claude_com(self):
        sq = classify_source_quality("https://code.claude.com/docs/llms.txt")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_platform_openai_com_docs(self):
        sq = classify_source_quality("https://platform.openai.com/docs/guides")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_docs_github_com(self):
        sq = classify_source_quality("https://docs.github.com/en/actions")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3

    def test_developer_mozilla_org(self):
        sq = classify_source_quality("https://developer.mozilla.org/en-US/docs/Web")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3

    def test_www_prefix_stripped(self):
        sq = classify_source_quality("https://www.docs.python.org/3/")
        assert sq.domain == "docs.python.org"
        assert sq.source_type == "official_docs"

    def test_generic_docs_subdomain(self):
        sq = classify_source_quality("https://docs.example.com/api/reference")
        assert sq.source_type == "official_docs"
        assert sq.authority_score == 3
        assert sq.domain == "docs.example.com"


class TestRepository:
    def test_github_repo_default(self):
        sq = classify_source_quality("https://github.com/owner/repo")
        assert sq.source_type == "repository"
        assert sq.authority_score == 2
        assert sq.is_official is False

    def test_github_repo_official_title(self):
        sq = classify_source_quality(
            "https://github.com/owner/repo",
            title="owner/repo: Official documentation",
        )
        assert sq.source_type == "repository"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_raw_githubusercontent(self):
        sq = classify_source_quality("https://raw.githubusercontent.com/owner/repo/main/README.md")
        assert sq.source_type == "repository"
        assert sq.authority_score == 2


class TestPaper:
    def test_arxiv(self):
        sq = classify_source_quality("https://arxiv.org/abs/2301.12345")
        assert sq.source_type == "paper"
        assert sq.authority_score == 2
        assert sq.is_primary_source is True

    def test_doi(self):
        sq = classify_source_quality("https://doi.org/10.1234/example")
        assert sq.source_type == "paper"
        assert sq.authority_score == 2


class TestStandards:
    def test_owasp(self):
        sq = classify_source_quality("https://owasp.org/www-project-top-ten/")
        assert sq.source_type == "standards"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_openssf(self):
        sq = classify_source_quality("https://openssf.org/guide")
        assert sq.source_type == "standards"
        assert sq.authority_score == 3


class TestAdvisory:
    def test_cve(self):
        sq = classify_source_quality("https://cve.org/CVE-2024-12345")
        assert sq.source_type == "advisory"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_nist(self):
        sq = classify_source_quality("https://nist.gov/cve/detail")
        assert sq.source_type == "advisory"
        assert sq.authority_score == 3


class TestForum:
    def test_reddit(self):
        sq = classify_source_quality("https://reddit.com/r/python")
        assert sq.source_type == "forum"
        assert sq.authority_score == 1
        assert sq.is_official is False

    def test_stackoverflow(self):
        sq = classify_source_quality("https://stackoverflow.com/questions/12345")
        assert sq.source_type == "forum"
        assert sq.authority_score == 1

    def test_hacker_news(self):
        sq = classify_source_quality("https://news.ycombinator.com/item?id=12345")
        assert sq.source_type == "forum"
        assert sq.authority_score == 1


class TestBlog:
    def test_medium(self):
        sq = classify_source_quality("https://medium.com/@user/article")
        assert sq.source_type == "blog"
        assert sq.authority_score == 1

    def test_dev_to(self):
        sq = classify_source_quality("https://dev.to/user/article")
        assert sq.source_type == "blog"
        assert sq.authority_score == 1

    def test_substack(self):
        sq = classify_source_quality("https://example.substack.com/p/article")
        assert sq.source_type == "blog"
        assert sq.authority_score == 1


class TestUnknown:
    def test_malformed_url(self):
        sq = classify_source_quality("not-a-url")
        assert sq.source_type == "unknown"
        assert sq.authority_score == 0
        assert sq.is_official is False
        assert sq.domain == ""

    def test_empty_url(self):
        sq = classify_source_quality("")
        assert sq.source_type == "unknown"
        assert sq.authority_score == 0

    def test_localhost(self):
        sq = classify_source_quality("http://localhost:9999/search")
        assert sq.source_type == "unknown"
        assert sq.authority_score == 0
        assert sq.is_official is False
        assert "private" in sq.reason

    def test_private_ip(self):
        sq = classify_source_quality("http://192.168.1.1/admin")
        assert sq.source_type == "unknown"
        assert sq.authority_score == 0

    def test_generic_domain(self):
        sq = classify_source_quality("https://example.com/page")
        assert sq.source_type == "unknown"
        assert sq.authority_score == 1
        assert sq.domain == "example.com"

    def test_doc_in_domain_but_not_docs_prefix(self):
        sq = classify_source_quality("https://docsite.com/guide")
        assert sq.source_type == "docs_site"
        assert sq.authority_score == 2


class TestNoSecrets:
    def test_url_with_credentials_domain_clean(self):
        sq = classify_source_quality("https://user:pass@example.com/path")
        assert sq.domain == "example.com"
        assert "pass" not in sq.reason
        assert "user" not in sq.reason


class TestVendorResearchBlog:
    def test_anthropic_research_blog(self):
        sq = classify_source_quality("https://www.anthropic.com/research/building-effective-agents")
        assert sq.source_type == "blog"
        assert sq.authority_score == 3
        assert sq.is_official is True
        assert sq.is_primary_source is True
        assert sq.domain == "anthropic.com"
        assert "research blog" in sq.reason

    def test_anthropic_research_www_stripped(self):
        sq = classify_source_quality("https://anthropic.com/research/building-effective-agents")
        assert sq.source_type == "blog"
        assert sq.authority_score == 3
        assert sq.is_official is True

    def test_openai_index(self):
        sq = classify_source_quality("https://openai.com/index/new-chapter-for-developers")
        assert sq.source_type == "blog"
        assert sq.authority_score == 3
        assert sq.is_official is True
        assert sq.is_primary_source is True

    def test_developers_googleblog(self):
        sq = classify_source_quality("https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability")
        assert sq.source_type == "blog"
        assert sq.authority_score == 3
        assert sq.is_official is True
        assert sq.is_primary_source is True

    def test_medium_still_non_official(self):
        sq = classify_source_quality("https://medium.com/@user/agent-best-practices")
        assert sq.source_type == "blog"
        assert sq.authority_score == 1
        assert sq.is_official is False
        assert sq.is_primary_source is False


class TestContract:
    def test_source_type_in_enum(self):
        sq = classify_source_quality("https://docs.python.org/3/")
        assert sq.source_type in SOURCE_TYPES

    def test_score_bounded(self):
        for url in [
            "https://docs.python.org/3/",
            "https://github.com/owner/repo",
            "https://reddit.com/r/test",
            "not-a-url",
        ]:
            sq = classify_source_quality(url)
            assert 0 <= sq.authority_score <= 3, f"score out of range for {url}: {sq.authority_score}"

    def test_frozen_dataclass(self):
        sq = classify_source_quality("https://docs.python.org/3/")
        assert hasattr(sq, "__hash__")

    def test_no_exceptions_on_bad_input(self):
        for bad in ["", "://", "ftp://", None, 42, "x" * 10000]:
            try:
                sq = classify_source_quality(bad)  # type: ignore[arg-type]
                assert sq.source_type in SOURCE_TYPES
                assert 0 <= sq.authority_score <= 3
            except Exception as e:
                raise AssertionError(f"classify_source_quality raised {e} for input {bad!r}")
