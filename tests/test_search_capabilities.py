"""Contract tests for authoritative Search sort/facet capabilities (#61)."""

from src.search_capabilities import (
    SEARCH_EXTENSIONS,
    SEARCH_LANGUAGES,
    SEARCH_SORTS,
    SORT_RELEVANCE,
    normalize_sort,
    search_capabilities,
)


def test_relevance_is_default_and_first_sort_option():
    assert SORT_RELEVANCE == ""
    assert SEARCH_SORTS[0]["value"] == SORT_RELEVANCE
    assert SEARCH_SORTS[0]["label"] == "Relevance"


def test_normalize_sort_accepts_known_alternate():
    assert normalize_sort("newest") == "newest"
    assert normalize_sort("  largest ") == "largest"


def test_normalize_sort_unknown_or_none_is_relevance():
    assert normalize_sort(None) == SORT_RELEVANCE
    assert normalize_sort("popularity") == SORT_RELEVANCE
    assert normalize_sort("random") == SORT_RELEVANCE


def test_capabilities_payload_shape():
    caps = search_capabilities()
    assert {s["value"] for s in caps["sorts"]} == {s["value"] for s in SEARCH_SORTS}
    assert {e["value"] for e in caps["extensions"]} == {e["value"] for e in SEARCH_EXTENSIONS}
    assert {lang["value"] for lang in caps["languages"]} == {
        lang["value"] for lang in SEARCH_LANGUAGES
    }
    # Mutable copies — callers cannot mutate the module tuples via the payload.
    caps["extensions"].append({"value": "xyz", "label": "XYZ"})
    assert all(e["value"] != "xyz" for e in SEARCH_EXTENSIONS)
