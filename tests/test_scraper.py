"""Tests for live-search scraping helpers."""

from unittest.mock import MagicMock, patch

import pytest
import requests

from src.scraper import (
    SCRAPE_PAGE_SIZE,
    SearchScrapeError,
    _detect_content_type,
    classify_search_html,
    scrape_annas_archive,
)


def _response(html: str, *, content_type: str = "text/html; charset=utf-8") -> MagicMock:
    response = MagicMock()
    response.text = html
    response.status_code = 200
    response.headers = {"Content-Type": content_type}
    response.elapsed = MagicMock()
    response.elapsed.total_seconds = MagicMock(return_value=0.05)
    response.raise_for_status = MagicMock()
    return response


def test_scrape_parses_metadata_split_across_elements():
    html = """
    <html><body>
      <div class="border-b">
        <a href="/md5/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">History of 1984</a>
        <div>Jane Author</div>
        <div>English [en]</div>
        <div>PDF</div>
        <div>1.5 MB</div>
        <div>2024</div>
        <div>Book</div>
      </div>
    </body></html>
    """
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        rows = scrape_annas_archive("history")

    assert len(rows) == 1
    assert rows[0]["language"] == "English"
    assert rows[0]["extension"] == "pdf"
    assert rows[0]["filesize_bytes"] == 1_572_864
    assert rows[0]["year"] == "2024"


def test_scrape_sets_content_type_from_card_token():
    html = """
    <html><body>
      <div class="border-b">
        <a href="/md5/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">A Comic Tale</a>
        <div>Some Artist</div>
        <div>English [en]</div>
        <div>CBZ</div>
        <div>Comic</div>
      </div>
    </body></html>
    """
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        rows = scrape_annas_archive("comic")

    assert len(rows) == 1
    assert rows[0]["content_type"] == "comic"


@pytest.mark.parametrize(
    ("card_text", "expected"),
    [
        ("Title\nBook (fiction)\nEnglish", "fiction"),
        ("Title\nBook (non-fiction)\nEnglish", "non-fiction"),
        ("Title\nBook (nonfiction)\nEnglish", "non-fiction"),
        ("Title\nComic\nEnglish", "comic"),
        ("Title\nMagazine\nEnglish", "magazine"),
        ("Title\nMusical score\nEnglish", "other"),
        ("Title\nEnglish [en]\nPDF", None),
    ],
)
def test_detect_content_type_maps_card_token(card_text, expected):
    assert _detect_content_type(card_text) == expected


def test_scrape_page_size_tracks_current_site_page_size():
    assert SCRAPE_PAGE_SIZE == 50


def test_scrape_forwards_sort_and_filters_in_request_url():
    """Global sort/filters are AA URL params — not client-side reordering."""
    html = """
    <html><body>
      <div class="border-b">
        <a href="/md5/cccccccccccccccccccccccccccccccc">Sorted Book</a>
        <div>Author</div>
        <div>English [en]</div>
        <div>EPUB</div>
      </div>
    </body></html>
    """
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        scrape_annas_archive(
            "habits",
            ext="epub",
            lang="English",
            sort="newest",
            page=2,
            base_url="https://annas-archive.example",
        )

    url = session.get.call_args.args[0]
    assert "q=habits" in url
    assert "ext=epub" in url
    assert "lang=English" in url
    assert "sort=newest" in url
    assert "page=2" in url


def test_scrape_omits_sort_param_for_relevance_default():
    html = """
    <html><body>
      <div class="border-b">
        <a href="/md5/dddddddddddddddddddddddddddddddd">Book</a>
      </div>
    </body></html>
    """
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        scrape_annas_archive("habits", sort=None)
        scrape_annas_archive("habits", sort="")

    for call in session.get.call_args_list:
        url = call.args[0]
        assert "sort=" not in url


# ---------------------------------------------------------------------------
# Page classification + failure taxonomy (#105)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("html", "content_type", "expected"),
    [
        (
            '<a href="/md5/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">T</a>',
            "text/html",
            "results",
        ),
        (
            '<div class="js-aarecord">x</div>',
            "text/html",
            "results",
        ),
        (
            "<html><body><h1>No files found</h1></body></html>",
            "text/html",
            "empty",
        ),
        (
            "<html><title>Just a moment...</title><div>cf-browser-verification</div></html>",
            "text/html",
            "blocked",
        ),
        (
            "<html><body><p>Enable JavaScript to continue</p></body></html>",
            "text/html",
            "blocked",
        ),
        (
            "<html><body><p>Welcome</p></body></html>",
            "text/html",
            "unsupported",
        ),
        (
            "",
            "text/html",
            "unsupported",
        ),
        (
            '{"error":true}',
            "application/json",
            "unsupported",
        ),
    ],
)
def test_classify_search_html_table(html: str, content_type: str, expected: str) -> None:
    assert classify_search_html(html, content_type=content_type) == expected


def test_scrape_returns_empty_list_for_legitimate_empty_page() -> None:
    html = "<html><body><p>No results found for your query.</p></body></html>"
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        rows = scrape_annas_archive("zzzz-unlikely")

    assert rows == []


def test_scrape_raises_unsupported_for_html_without_markers() -> None:
    """Regression: incomplete/br-broken AA shells used to become silent []."""
    html = "<html><head><title>Search</title></head><body><div id='app'></div></body></html>"
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
        pytest.raises(SearchScrapeError) as ei,
    ):
        scrape_annas_archive("The Pragmatic Programmer")

    assert ei.value.code == "unsupported"
    assert "could not be parsed" in str(ei.value).lower()


def test_scrape_raises_blocked_for_challenge_page() -> None:
    html = "<html><title>Just a moment...</title>" "<div id='challenge-platform'>Checking your browser</div></html>"
    session = MagicMock()
    session.get.return_value = _response(html)

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
        pytest.raises(SearchScrapeError) as ei,
    ):
        scrape_annas_archive("book")

    assert ei.value.code == "blocked"


def test_scrape_raises_unavailable_on_network_error() -> None:
    session = MagicMock()
    session.get.side_effect = requests.ConnectionError("dns fail")

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
        pytest.raises(SearchScrapeError) as ei,
    ):
        scrape_annas_archive("book")

    assert ei.value.code == "unavailable"


def test_scrape_raises_blocked_on_http_403() -> None:
    session = MagicMock()
    resp = MagicMock()
    resp.status_code = 403
    err = requests.HTTPError(response=resp)
    err.response = resp
    session.get.side_effect = err

    with (
        patch("src.scraper._make_session", return_value=(session, None, "ua")),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
        pytest.raises(SearchScrapeError) as ei,
    ):
        scrape_annas_archive("book")

    assert ei.value.code == "blocked"


def test_session_accept_encoding_omits_brotli() -> None:
    """Accept-Encoding must not advertise br (causes empty AA HTML shells)."""
    from src.scraper import _make_session

    session, _proxy, _ua = _make_session([])
    enc = session.headers.get("Accept-Encoding", "")
    assert "br" not in enc.split(",")
    assert "gzip" in enc


def test_handle_search_propagates_scrape_error() -> None:
    """Bridge handler must not convert typed scrape failures into empty results."""
    import sys
    from pathlib import Path
    from unittest.mock import patch

    bridge_dir = Path(__file__).resolve().parents[1] / "electron-app" / "python"
    if str(bridge_dir) not in sys.path:
        sys.path.insert(0, str(bridge_dir))

    import bridge_handlers

    with (
        patch.object(
            bridge_handlers,
            "scrape_annas_archive",
            side_effect=SearchScrapeError("unsupported", "not parseable"),
        ),
        pytest.raises(SearchScrapeError) as ei,
    ):
        bridge_handlers.handle_search({"query": "The Pragmatic Programmer"})
    assert ei.value.code == "unsupported"
