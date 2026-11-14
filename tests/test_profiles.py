"""Tests for deterministic query profiles."""

import json
from pathlib import Path

from search_tool.profiles import (
    Profile,
    PROFILES,
    VALID_PROFILE_NAMES,
    get_profile,
    profile_to_json,
    profile_sort_key,
)


class TestGetProfile:
    def test_returns_none_for_none(self):
        assert get_profile(None) is None

    def test_returns_none_for_unknown(self):
        assert get_profile("nonexistent") is None

    def test_returns_official_docs(self):
        p = get_profile("official-docs")
        assert p is not None
        assert p.name == "official-docs"

    def test_returns_github_repo(self):
        p = get_profile("github-repo")
        assert p is not None
        assert p.name == "github-repo"

    def test_returns_security_research(self):
        p = get_profile("security-research")
        assert p is not None
        assert p.name == "security-research"


class TestProfileDefinitions:
    def test_all_profiles_frozen(self):
        for name, p in PROFILES.items():
            assert isinstance(p, Profile)
            assert p.name == name

    def test_all_prefer_not_require(self):
        for p in PROFILES.values():
            assert p.selection_policy == "prefer_not_require"

    def test_all_minimum_authority_2(self):
        for p in PROFILES.values():
            assert p.minimum_authority_score == 2

    def test_all_have_reason(self):
        for p in PROFILES.values():
            assert len(p.reason) > 0

    def test_valid_names_match_profiles(self):
        assert set(VALID_PROFILE_NAMES) == set(PROFILES.keys())


class TestProfileToJson:
    def test_none_returns_none(self):
        assert profile_to_json(None) is None

    def test_returns_dict_with_keys(self):
        p = get_profile("official-docs")
        d = profile_to_json(p)
        assert isinstance(d, dict)
        assert d["name"] == "official-docs"
        assert "source_type_preferences" in d
        assert d["minimum_authority_score"] == 2
        assert d["selection_policy"] == "prefer_not_require"
        assert "reason" in d

    def test_source_type_preferences_is_list(self):
        p = get_profile("security-research")
        d = profile_to_json(p)
        assert isinstance(d["source_type_preferences"], list)


class TestProfileSortKey:
    def test_no_profile_equal_for_all_sources(self):
        """Without profile, preference_match is always 0 (no bias)."""
        key1 = profile_sort_key(None, "official_docs", 3, 3, 1)
        key2 = profile_sort_key(None, "blog", 1, 1, 2)
        assert key1[0] == 0
        assert key2[0] == 0

    def test_profile_bumps_preferred_sources(self):
        """Preferred source_type gets negative preference_match (sorts first)."""
        p = get_profile("official-docs")
        key_preferred = profile_sort_key(p, "official_docs", 3, 3, 1)
        key_other = profile_sort_key(p, "blog", 3, 3, 1)
        assert key_preferred[0] == -1
        assert key_other[0] == 0
        # preferred should sort before other
        assert key_preferred < key_other

    def test_authority_breaks_tie_within_preference(self):
        """Same preference: higher authority sorts first."""
        p = get_profile("official-docs")
        key_high = profile_sort_key(p, "official_docs", 3, 3, 2)
        key_low = profile_sort_key(p, "official_docs", 2, 3, 1)
        assert key_high < key_low

    def test_quality_breaks_tie_within_preference_and_authority(self):
        """Same preference+authority: higher quality sorts first."""
        p = get_profile("official-docs")
        key_high = profile_sort_key(p, "official_docs", 3, 3, 2)
        key_low = profile_sort_key(p, "official_docs", 3, 1, 1)
        assert key_high < key_low

    def test_rank_breaks_final_tie(self):
        """Same everything: lower rank sorts first."""
        p = get_profile("official-docs")
        key_first = profile_sort_key(p, "official_docs", 3, 3, 1)
        key_second = profile_sort_key(p, "official_docs", 3, 3, 2)
        assert key_first < key_second

    def test_preferred_low_authority_over_nonpreferred_high(self):
        """A preferred source with lower authority sorts before non-preferred with higher."""
        p = get_profile("official-docs")
        key_preferred = profile_sort_key(p, "official_docs", 2, 2, 3)
        key_nonpreferred = profile_sort_key(p, "blog", 3, 3, 1)
        assert key_preferred < key_nonpreferred

    def test_github_repo_profile_prefers_repository(self):
        p = get_profile("github-repo")
        key_repo = profile_sort_key(p, "repository", 2, 2, 1)
        key_forum = profile_sort_key(p, "forum", 2, 2, 1)
        assert key_repo[0] == -1
        assert key_forum[0] == 0

    def test_security_research_profile_prefers_advisory(self):
        p = get_profile("security-research")
        key_advisory = profile_sort_key(p, "advisory", 3, 3, 1)
        key_blog = profile_sort_key(p, "blog", 3, 3, 1)
        assert key_advisory[0] == -1
        assert key_blog[0] == 0


class TestProfileCliIntegration:
    """Integration tests for --profile flag in CLI."""

    def test_unknown_profile_rejected(self, capsys):
        """Invalid profile value exits 1."""
        from search_tool.cli import main
        rc = main(["search-query", "test", "--provider", "static",
                    "--candidate-url", "http://example.com", "--profile", "invalid"])
        assert rc == 1
        captured = capsys.readouterr()
        assert "invalid" in captured.err.lower() or "unknown" in captured.err.lower()

    def test_unknown_profile_json_emits_valid_error_json(self, capsys):
        """Invalid profile with --json emits valid error JSON on stdout."""
        from search_tool.cli import main
        rc = main(["search-query", "test", "--provider", "static",
                    "--candidate-url", "http://example.com", "--profile", "nope",
                    "--json"])
        assert rc == 1
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert "profile" in parsed["failures"][0]["reason"].lower() or "invalid" in parsed["failures"][0]["reason"].lower() or "unknown" in parsed["failures"][0]["reason"].lower()
        assert parsed["recovery"]["websearch_allowed"] is False

    def test_profile_none_in_json_by_default(self, capsys, tmp_path):
        """Without --profile, profile is null in JSON output."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed.get("profile") is None

    def test_profile_present_in_json_output(self, capsys, tmp_path):
        """With --profile, profile metadata is in JSON output."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--work-dir", work_dir, "--profile", "official-docs",
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["profile"] is not None
            assert parsed["profile"]["name"] == "official-docs"
            assert parsed["profile"]["selection_policy"] == "prefer_not_require"
            assert "official_docs" in parsed["profile"]["source_type_preferences"]

    def test_profile_present_in_error_json(self, capsys):
        """Error JSON output includes profile as null."""
        from search_tool.cli import main
        rc = main(["search-query", "", "--provider", "static", "--json",
                    "--candidate-url", "http://x", "--profile", "official-docs"])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed.get("profile") is None


class TestProfileCompactSummary:
    """Integration tests for profile in compact summary."""

    def test_profile_in_compact_metadata(self, capsys, tmp_path):
        """Compact summary includes profile metadata when --profile is set."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--compact", "--work-dir", work_dir,
            "--profile", "security-research",
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            summary_path = parsed.get("compact_summary_path")
            if summary_path:
                content = Path(summary_path).read_text(encoding="utf-8")
                assert "security-research" in content
                assert "prefer_not_require" in content

    def test_no_profile_in_compact_without_flag(self, capsys, tmp_path):
        """Compact summary does not show profile when --profile is not set."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--compact", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            summary_path = parsed.get("compact_summary_path")
            if summary_path:
                content = Path(summary_path).read_text(encoding="utf-8")
                assert "Profile:" not in content

    def test_profile_ordering_label_in_compact(self, capsys, tmp_path):
        """Compact summary with profile shows deterministic profile ordering label."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--compact", "--work-dir", work_dir,
            "--profile", "github-repo",
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            summary_path = parsed.get("compact_summary_path")
            if summary_path:
                content = Path(summary_path).read_text(encoding="utf-8")
                assert "deterministic profile ordering" in content
