"""OCR for scanned PDFs: fixtures render real image-only PDFs, no binary blobs checked in."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from fama_worker.extract import extract
from fama_worker.extract import ocr as ocr_mod
from fama_worker.extract.ocr import _Block, _Line, _drop_running, _group_blocks
from fama_worker.model import FileSource

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia.ttf",  # macOS
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",  # Debian
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
]


def _find_font() -> str | None:
    return next((path for path in _FONT_CANDIDATES if Path(path).exists()), None)


_FONT = _find_font()
_HAVE_OCR = ocr_mod._tesseract_available() or ocr_mod._vision_available()
_HAVE_TESSERACT = ocr_mod._tesseract_available()

_needs_font = pytest.mark.skipif(_FONT is None, reason="no font with Icelandic glyphs on this machine")
_needs_ocr = pytest.mark.skipif(not _HAVE_OCR, reason="no OCR backend (tesseract or Apple Vision) on this machine")
_needs_tesseract = pytest.mark.skipif(not _HAVE_TESSERACT, reason="tesseract not installed")


def _render_page(lines: list[str], font_size: int = 42) -> Image.Image:
    font = ImageFont.truetype(_FONT, font_size)
    width = max(int(font.getlength(line)) for line in lines) + 120
    line_height = int(font_size * 1.7)
    image = Image.new("RGB", (width, 120 + line_height * len(lines)), "white")
    draw = ImageDraw.Draw(image)
    y = 60
    for line in lines:
        draw.text((60, y), line, font=font, fill="black")
        y += line_height
    return image


def _scanned_pdf(path: Path, pages: list[list[str]]) -> Path:
    """An image-only PDF: each page is a rendered raster with no text layer."""
    doc = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    for lines in pages:
        image = _render_page(lines)
        png = path.with_name(path.stem + "-page.png")
        image.save(png)
        scale = min(width / image.width, height / image.height) * 0.9
        doc.drawImage(str(png), 40, height - 40 - image.height * scale, width=image.width * scale, height=image.height * scale)
        doc.showPage()
        png.unlink()
    doc.save()
    return path


@_needs_font
@_needs_ocr
def test_scanned_english_pdf_is_ocrd(tmp_path):
    path = _scanned_pdf(tmp_path / "scan.pdf", [["The harbour master reads the tide tables every morning."]])
    document = extract(FileSource(path))
    text = document.chapters[0].text.lower()
    assert "harbour" in text and "tide tables" in text


@_needs_font
@_needs_tesseract
def test_scanned_icelandic_pdf_keeps_diacritics(tmp_path):
    # Apple Vision does not read Icelandic (it mangles þ/ð/æ/ö), so this proves
    # the tesseract path that Fama needs for Icelandic scans.
    path = _scanned_pdf(tmp_path / "scan.pdf", [["Þingvellir liggja við Öxará og Þjórsá."]])
    document = extract(FileSource(path))
    text = document.chapters[0].text
    assert "Þingvellir" in text and "við" in text and "Öxará" in text


def test_paragraph_lines_join_and_dehyphenate():
    lines = [
        _Line("The harbour grew over the cen-", 40, 40, 400, 62),
        _Line("turies into a capital city.", 40, 66, 400, 88),
    ]
    blocks = _group_blocks(lines)
    assert len(blocks) == 1
    assert blocks[0].text == "The harbour grew over the centuries into a capital city."


def test_paragraphs_split_on_a_large_vertical_gap():
    lines = [
        _Line("First paragraph ends here.", 40, 40, 400, 62),
        _Line("A second paragraph starts far below.", 40, 200, 400, 222),
    ]
    assert len(_group_blocks(lines)) == 2


def test_drop_running_headers_footers_and_page_numbers():
    body = "The harbour accounts close at the end of the year and the town council reads them."
    pages = [
        [
            _Block("The City Book", 0, 0, 200, 24),
            _Block(body, 0, 60, 500, 84),
            _Block(str(number), 300, 820, 320, 844),
        ]
        for number in range(1, 7)
    ]
    kept = _drop_running(pages)
    assert all(len(page) == 1 for page in kept)
    assert all(page[0].text == body for page in kept)


def test_scanned_pdf_without_backend_raises_install_hint(tmp_path, monkeypatch):
    path = tmp_path / "scan.pdf"
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.rect(72, 72, 200, 200)
    doc.showPage()
    doc.save()

    monkeypatch.setattr(ocr_mod, "_tesseract_available", lambda: False)
    monkeypatch.setattr(ocr_mod, "_vision_available", lambda: False)
    with pytest.raises(ValueError, match="no OCR engine"):
        extract(FileSource(path))


@_needs_ocr
def test_blank_scan_still_raises_a_clear_error(tmp_path):
    path = tmp_path / "scan.pdf"
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.rect(72, 72, 200, 200)
    doc.showPage()
    doc.save()

    with pytest.raises(ValueError, match="no text to read"):
        extract(FileSource(path))
