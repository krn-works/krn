"""Deterministic query profiles for source preference biasing."""

from __future__ import annotations

from dataclasses import dataclass


VALID_PROFILE_NAMES = frozenset({"official-docs", "github-repo", "security-research", "llms-docs"})


@dataclass(frozen=True)
class Profile:
    name: str
    source_type_preferences: tuple[str, ...]
    minimum_authority_score: int
    selection_policy: str
    reason: str


PROFILES: dict[str, Profile] = {
    "official-docs": Profile(
        name="official-docs",
        source_type_preferences=("official_docs", "standards", "repository"),
        minimum_authority_score=2,
        selection_policy="prefer_not_require",
        reason="Prefer official documentation and primary sources.",
    ),
    "github-repo": Profile(
        name="github-repo",
        source_type_preferences=("repository", "official_docs"),
        minimum_authority_score=2,
        selection_policy="prefer_not_require",
        reason="Prefer repository and README-like primary sources.",
    ),
    "security-research": Profile(
        name="security-research",
        source_type_preferences=("advisory", "standards", "official_docs", "paper", "repository"),
        minimum_authority_score=2,
        selection_policy="prefer_not_require",
        reason="Prefer advisories, standards, official docs, papers, and primary repositories.",
    ),
    "llms-docs": Profile(
        name="llms-docs",
        source_type_preferences=("official_docs", "docs_site", "repository"),
        minimum_authority_score=2,
        selection_policy="prefer_not_require",
        reason="Prefer official documentation and documentation sites from llms.txt discovery.",
    ),
}


def get_profile(name: str | None) -> Profile | None:
    if name is None:
        return None
    return PROFILES.get(name)


def profile_to_json(profile: Profile | None) -> dict | None:
    if profile is None:
        return None
    return {
        "name": profile.name,
        "source_type_preferences": list(profile.source_type_preferences),
        "minimum_authority_score": profile.minimum_authority_score,
        "selection_policy": profile.selection_policy,
        "reason": profile.reason,
    }


def profile_sort_key(
    profile: Profile | None,
    source_type: str,
    authority_score: int,
    quality_score: int,
    original_rank: int,
) -> tuple:
    """Deterministic sort key for profile-aware ordering.

    Returns (-preference_match, -authority, -quality, rank).
    Preferred source types get preference_match=1, producing -1 in the tuple,
    which sorts before non-preferred sources (preference_match=0 → 0 in tuple).
    Without profile, all sources get preference_match=0 (no bias).

    This is deterministic mechanical ordering, not AI ranking.
    """
    preference_match = 0
    if profile is not None:
        if source_type in profile.source_type_preferences:
            preference_match = 1
    return (-preference_match, -authority_score, -quality_score, original_rank)
