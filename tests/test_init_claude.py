"""Tests for `krn-search init-claude` bootstrap command. Mocked, no live internet."""

import json
from pathlib import Path

import pytest

from search_tool.bootstrap import init_claude, print_summary


class TestInitClaudeDryRun:
    def test_dry_run_creates_nothing(self, tmp_path):
        result = init_claude(str(tmp_path), dry_run=True)
        # dry-run should not create any directories
        assert not (tmp_path / ".claude").exists()
        # but should report what it would create
        assert ".claude/skills/krn-search-research/SKILL.md" in result["created"]
        assert ".claude/commands/krn-search-research.md" in result["created"]

    def test_dry_run_with_hook_includes_hook(self, tmp_path):
        result = init_claude(str(tmp_path), dry_run=True, with_hook=True)
        assert ".claude/hooks/websearch_krn_search_guard.py" in result["created"]
        assert ".claude/hooks/candidate_url_static_guard.py" in result["created"]


class TestInitClaudeDefault:
    def test_creates_skill_and_command(self, tmp_path):
        result = init_claude(str(tmp_path))
        assert (tmp_path / ".claude/skills/krn-search-research/SKILL.md").exists()
        assert (tmp_path / ".claude/commands/krn-search-research.md").exists()
        assert not (tmp_path / ".claude/hooks").exists()
        assert len(result["created"]) == 5
        assert len(result["skipped"]) == 0
        assert len(result["overwritten"]) == 0

    def test_does_not_create_hook_by_default(self, tmp_path):
        init_claude(str(tmp_path))
        assert not (tmp_path / ".claude/hooks").exists()

    def test_hook_created_with_flag(self, tmp_path):
        result = init_claude(str(tmp_path), with_hook=True)
        assert (tmp_path / ".claude/hooks/websearch_krn_search_guard.py").exists()
        assert (tmp_path / ".claude/hooks/candidate_url_static_guard.py").exists()
        assert len(result["created"]) == 7


class TestInitClaudeInstructionInjection:
    def test_injects_contract_into_existing_instruction_files(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("# Project\n\nExisting rules.\n", encoding="utf-8")
        (tmp_path / "AGENTS.md").write_text("# Agents\n\nExisting agent rules.\n", encoding="utf-8")
        rules_dir = tmp_path / ".claude" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "00-operating-model.md").write_text("Core rule.\n", encoding="utf-8")

        result = init_claude(str(tmp_path))

        assert "CLAUDE.md" in result["injected"]
        assert "AGENTS.md" in result["injected"]
        assert ".claude/rules/00-operating-model.md" in result["injected"]

        for rel in ("CLAUDE.md", "AGENTS.md", ".claude/rules/00-operating-model.md"):
            content = (tmp_path / rel).read_text(encoding="utf-8")
            assert "<!-- krn-search:research-contract:start -->" in content
            assert 'krn-search search-query "<query>" --research' in content
            assert "krn-search searxng up" in content
            assert "Do not use WebSearch/WebFetch" in content
            assert "Do not invent, template, guess, or synthesize candidate URLs" in content

    def test_instruction_injection_is_idempotent(self, tmp_path):
        path = tmp_path / "CLAUDE.md"
        path.write_text("# Project\n", encoding="utf-8")

        init_claude(str(tmp_path))
        first = path.read_text(encoding="utf-8")
        result = init_claude(str(tmp_path))
        second = path.read_text(encoding="utf-8")

        assert first == second
        assert result["injected"] == []
        assert result["unchanged"] == ["CLAUDE.md"]
        assert second.count("<!-- krn-search:research-contract:start -->") == 1

    def test_dry_run_reports_instruction_injection_without_writing(self, tmp_path):
        path = tmp_path / "CLAUDE.md"
        path.write_text("# Project\n", encoding="utf-8")

        result = init_claude(str(tmp_path), dry_run=True)

        assert "CLAUDE.md" in result["injected"]
        assert "<!-- krn-search:research-contract:start -->" not in path.read_text(encoding="utf-8")


class TestInitClaudeNoOverwrite:
    def test_existing_files_skipped_by_default(self, tmp_path):
        # First run creates files
        result1 = init_claude(str(tmp_path))
        assert len(result1["created"]) == 5

        # Second run without --force skips
        result2 = init_claude(str(tmp_path))
        assert len(result2["skipped"]) == 5
        assert len(result2["created"]) == 0

    def test_content_unchanged_after_skip(self, tmp_path):
        init_claude(str(tmp_path))
        first_content = (tmp_path / ".claude/skills/krn-search-research/SKILL.md").read_text()
        # Second run should skip, content unchanged
        init_claude(str(tmp_path))
        second_content = (tmp_path / ".claude/skills/krn-search-research/SKILL.md").read_text()
        assert first_content == second_content


class TestInitClaudeForce:
    def test_force_overwrites_existing(self, tmp_path):
        # First run
        init_claude(str(tmp_path))

        # Modify a file
        (tmp_path / ".claude/skills/krn-search-research/SKILL.md").write_text(
            "MODIFIED CONTENT", encoding="utf-8"
        )

        # Second run with --force
        result = init_claude(str(tmp_path), force=True)
        assert len(result["overwritten"]) >= 1

        # Content should be restored to template
        content = (tmp_path / ".claude/skills/krn-search-research/SKILL.md").read_text()
        assert content != "MODIFIED CONTENT"
        assert "krn-search" in content


class TestInitClaudeTargetDir:
    def test_writes_to_custom_target(self, tmp_path):
        target = tmp_path / "custom" / "target"
        init_claude(str(target))
        assert (target / ".claude/skills/krn-search-research/SKILL.md").exists()
        assert (target / ".claude/commands/krn-search-research.md").exists()


class TestInitClaudeSummary:
    def test_print_summary_with_creates(self, capsys):
        result = {
            "created": [".claude/skills/test.md"],
            "skipped": [],
            "overwritten": [],
            "target": "/tmp/target",
            "next_steps": ["step1"],
        }
        print_summary(result)
        output = capsys.readouterr().out
        assert "+ .claude/skills/test.md" in output
        assert "Created" in output

    def test_print_summary_with_skips(self, capsys):
        result = {
            "created": [],
            "skipped": [".claude/commands/test.md"],
            "overwritten": [],
            "target": "/tmp/target",
            "next_steps": ["step1"],
        }
        print_summary(result)
        output = capsys.readouterr().out
        assert "- .claude/commands/test.md" in output
        assert "Skipped" in output

    def test_print_summary_with_overwrites(self, capsys):
        result = {
            "created": [],
            "skipped": [],
            "overwritten": [".claude/skills/test.md"],
            "target": "/tmp/target",
            "next_steps": ["step1"],
        }
        print_summary(result)
        output = capsys.readouterr().out
        assert "~ .claude/skills/test.md" in output
        assert "Overwritten" in output


class TestInitClaudeContentVerification:
    def test_skill_file_contains_expected_strings(self, tmp_path):
        """Skill file should contain key strings for the portable kit."""
        init_claude(str(tmp_path))
        content = (tmp_path / ".claude/skills/krn-search-research/SKILL.md").read_text()
        assert "krn-search search-query" in content
        assert "--research" in content
        assert "krn-search searxng status" in content
        assert "krn-search searxng up" in content
        assert "Falls back to static provider with candidate URLs from context" not in content
        assert "Do not invent, template, guess, or synthesize URLs" in content
        assert "scholar.google.com/scholar?q=<query>" not in content
        assert "https://<domain>" not in content
        assert "<slug>" not in content
        assert "<org>/<repo>" not in content
        assert "arxiv.org/abs/<id>" not in content
        assert "arxiv.org/pdf/<id>" not in content

    def test_command_file_contains_expected_strings(self, tmp_path):
        """Command file should mention krn-search search-query and --research."""
        init_claude(str(tmp_path))
        content = (tmp_path / ".claude/commands/krn-search-research.md").read_text()
        assert "krn-search search-query" in content
        assert "--research" in content
        assert "krn-search searxng status" in content
        assert "krn-search searxng up" in content
        assert "Do not call WebSearch or WebFetch" in content
        assert "Do not invent or template URLs" in content

    def test_hook_file_contains_expected_strings(self, tmp_path):
        """Hook file should reference WebSearch/WebFetch."""
        result = init_claude(str(tmp_path), with_hook=True)
        assert ".claude/hooks/websearch_krn_search_guard.py" in result["created"]
        assert ".claude/hooks/candidate_url_static_guard.py" in result["created"]
        content = (tmp_path / ".claude/hooks/websearch_krn_search_guard.py").read_text()
        assert "WebSearch" in content
        assert "WebFetch" in content
        assert "--research" in content
        assert "<user-provided-or-known-url>" in content
        assert "Do not invent URLs" in content
        assert "--provider searxng --searxng-url <url>" not in content
        candidate_guard = (tmp_path / ".claude/hooks/candidate_url_static_guard.py").read_text()
        assert "KRN_SEARCH_ALLOW_EXACT_URLS=1" in candidate_guard
        assert "--provider static" in candidate_guard


class TestInitClaudeWorkflowSkills:
    """Verify init-claude copies the three workflow skill templates."""

    def test_diagnose_skill_copied(self, tmp_path):
        init_claude(str(tmp_path))
        path = tmp_path / ".claude/skills/krn-search-diagnose/SKILL.md"
        assert path.exists()
        content = path.read_text()
        assert "deterministic" in content
        assert "hypothes" in content.lower()
        assert "review packet" in content.lower()

    def test_design_grill_skill_copied(self, tmp_path):
        init_claude(str(tmp_path))
        path = tmp_path / ".claude/skills/krn-search-design-grill/SKILL.md"
        assert path.exists()
        content = path.read_text()
        assert "Do not implement code" in content
        assert "CLAUDE.md" in content
        assert "ACTIVE_TASK.md" in content

    def test_handoff_skill_copied(self, tmp_path):
        init_claude(str(tmp_path))
        path = tmp_path / ".claude/skills/krn-search-handoff/SKILL.md"
        assert path.exists()
        content = path.read_text()
        assert ".local/krn-search-handoffs" in content
        assert "Do not create committed notes" in content
        assert "redact" in content.lower()


class TestInitClaudeHookSettings:
    def test_no_settings_json_created(self, tmp_path):
        init_claude(str(tmp_path))
        assert not (tmp_path / ".claude/settings.json").exists()
        assert not (tmp_path / ".claude/settings.local.json").exists()

    def test_settings_local_created_with_hook(self, tmp_path):
        result = init_claude(str(tmp_path), with_hook=True)

        assert not (tmp_path / ".claude/settings.json").exists()
        settings_path = tmp_path / ".claude/settings.local.json"
        assert settings_path.exists()
        assert ".claude/settings.local.json" in result["configured"]

        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        assert settings["env"]["KRN_SEARCH_BIN"] == "krn-search"
        assert settings["env"]["SEARXNG_URL"] == "http://localhost:9999"
        hook = settings["hooks"]["PreToolUse"][0]
        assert hook["matcher"] == "WebSearch|WebFetch"
        assert hook["hooks"][0]["command"] == "python3 .claude/hooks/websearch_krn_search_guard.py"
        bash_hook = settings["hooks"]["PreToolUse"][1]
        assert bash_hook["matcher"] == "Bash"
        assert bash_hook["hooks"][0]["command"] == "python3 .claude/hooks/candidate_url_static_guard.py"

    def test_settings_local_merge_preserves_existing_config_and_is_idempotent(self, tmp_path):
        settings_path = tmp_path / ".claude/settings.local.json"
        settings_path.parent.mkdir(parents=True)
        settings_path.write_text(
            json.dumps({
                "env": {"EXISTING": "1", "SEARXNG_URL": "http://custom:9999"},
                "hooks": {
                    "PostToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "echo ok"}]}]
                },
            }),
            encoding="utf-8",
        )

        result = init_claude(str(tmp_path), with_hook=True)
        first = json.loads(settings_path.read_text(encoding="utf-8"))
        second_result = init_claude(str(tmp_path), with_hook=True)
        second = json.loads(settings_path.read_text(encoding="utf-8"))

        assert ".claude/settings.local.json" in result["configured"]
        assert ".claude/settings.local.json" in second_result["unchanged"]
        assert first == second
        assert second["env"]["EXISTING"] == "1"
        assert second["env"]["SEARXNG_URL"] == "http://custom:9999"
        assert second["env"]["KRN_SEARCH_BIN"] == "krn-search"
        assert "PostToolUse" in second["hooks"]
        pre_hooks = second["hooks"]["PreToolUse"]
        assert len([h for h in pre_hooks if h.get("matcher") == "WebSearch|WebFetch"]) == 1
        assert len([h for h in pre_hooks if h.get("matcher") == "Bash"]) == 1

    def test_no_settings_json_force(self, tmp_path):
        init_claude(str(tmp_path), force=True)
        assert not (tmp_path / ".claude/settings.json").exists()
        assert not (tmp_path / ".claude/settings.local.json").exists()

    def test_settings_local_dry_run_reports_without_writing(self, tmp_path):
        result = init_claude(str(tmp_path), dry_run=True, with_hook=True)
        assert ".claude/settings.local.json" in result["configured"]
        assert not (tmp_path / ".claude/settings.json").exists()
        assert not (tmp_path / ".claude/settings.local.json").exists()

    def test_invalid_settings_local_json_fails_with_readable_error(self, tmp_path):
        settings_path = tmp_path / ".claude" / ".keep"
        settings_path.parent.mkdir(parents=True)
        (tmp_path / ".claude/settings.local.json").write_text("{bad json", encoding="utf-8")

        with pytest.raises(ValueError, match=r"invalid JSON in .*\.claude/settings\.local\.json"):
            init_claude(str(tmp_path), with_hook=True)


class TestInitClaudeCli:
    """Test the CLI entry point for init-claude."""

    def test_init_claude_help(self, capsys):
        from search_tool.cli import main
        with pytest.raises(SystemExit) as exc_info:
            main(["init-claude", "--help"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "--target-dir" in output
        assert "--dry-run" in output
        assert "--force" in output
        assert "--with-hook" in output

    def test_init_claude_default_creates_files(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        exit_code = main(["init-claude"])
        assert exit_code == 0
        assert (tmp_path / ".claude/skills/krn-search-research/SKILL.md").exists()
        assert (tmp_path / ".claude/commands/krn-search-research.md").exists()

    def test_init_claude_dry_run_exits_zero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        exit_code = main(["init-claude", "--dry-run"])
        assert exit_code == 0
        assert not (tmp_path / ".claude").exists()

    def test_init_claude_force_overwrites(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        # First run
        main(["init-claude"])
        # Modify
        (tmp_path / ".claude/skills/krn-search-research/SKILL.md").write_text("MODIFIED", encoding="utf-8")
        # Second run with --force
        exit_code = main(["init-claude", "--force"])
        assert exit_code == 0
        content = (tmp_path / ".claude/skills/krn-search-research/SKILL.md").read_text()
        assert content != "MODIFIED"

    def test_init_claude_with_hook_creates_hook(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        exit_code = main(["init-claude", "--with-hook"])
        assert exit_code == 0
        assert (tmp_path / ".claude/hooks/websearch_krn_search_guard.py").exists()
        assert (tmp_path / ".claude/hooks/candidate_url_static_guard.py").exists()
        assert (tmp_path / ".claude/settings.local.json").exists()

    def test_init_claude_target_dir(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        target = tmp_path / "custom"
        exit_code = main(["init-claude", "--target-dir", str(target)])
        assert exit_code == 0
        assert (target / ".claude/skills/krn-search-research/SKILL.md").exists()

    def test_init_claude_no_settings_created(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from search_tool.cli import main
        exit_code = main(["init-claude"])
        assert exit_code == 0
        assert not (tmp_path / ".claude/settings.json").exists()
        assert not (tmp_path / ".claude/settings.local.json").exists()

    def test_init_claude_invalid_settings_returns_error(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude/settings.local.json").write_text("{bad json", encoding="utf-8")
        from search_tool.cli import main
        exit_code = main(["init-claude", "--with-hook"])
        assert exit_code == 1
        err = capsys.readouterr().err
        assert "invalid JSON in" in err
