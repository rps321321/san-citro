"""Tests for live-search scraping helpers."""

from unittest.mock import MagicMock, patch

from src.scraper import SCRAPE_PAGE_SIZE, scrape_annas_archive


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
        patch("src.scraper._make_session", return_value=session),
        patch("src.scraper.is_allowed_by_robots", return_value=True),
        patch("src.scraper.time.sleep"),
    ):
        rows = scrape_annas_archive("history")

    assert len(rows) == 1
    assert rows[0]["language"] == "English"
    assert rows[0]["extension"] == "pdf"
    assert rows[0]["filesize_bytes"] == 1_572_864
    assert rows[0]["year"] == "2024"


def test_scrape_page_size_tracks_current_site_page_size():
    assert SCRAPE_PAGE_SIZE == 50
