"""Tests for live-search scraping helpers."""

from unittest.mock import MagicMock, patch

import pytest

from src.scraper import SCRAPE_PAGE_SIZE, _detect_content_type, scrape_annas_archive


def _response(html: str) -> MagicMock:
    response = MagicMock()
    response.text = html
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
