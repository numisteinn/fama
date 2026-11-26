"""OCR for scanned PDFs: fixtures render real image-only PDFs, no binary blobs checked in."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from fama_worker.extract import extract
from fama_worker.extract import ocr as ocr_mod
from fama_worker.extract.ocr import _Line, _group_blocks, _parse_tsv, _title_hint
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
_TESS_EXE = shutil.which("tesseract")
_HAVE_TESSERACT_ISL = _TESS_EXE is not None and "isl" in ocr_mod._tesseract_languages(_TESS_EXE)
_HAVE_VISION = ocr_mod._vision_available()

_needs_font = pytest.mark.skipif(_FONT is None, reason="no font with Icelandic glyphs on this machine")
_needs_ocr = pytest.mark.skipif(not _HAVE_OCR, reason="no OCR backend (tesseract or Apple Vision) on this machine")
_needs_tesseract_isl = pytest.mark.skipif(not _HAVE_TESSERACT_ISL, reason="tesseract with isl traineddata not installed")
_needs_vision = pytest.mark.skipif(not _HAVE_VISION, reason="Apple Vision not available on this machine")


def _render_page(blocks: list[list[str]], font_size: int = 38) -> Image.Image:
    """Render one or more paragraphs separated by clear blank gaps."""
    font = ImageFont.truetype(_FONT, font_size)
    all_lines = [line for block in blocks for line in block]
    width = max(int(font.getlength(line)) for line in all_lines) + 160
    line_height = int(font_size * 1.45)
    para_gap = int(font_size * 2.2)
    height = 160 + sum(len(block) * line_height for block in blocks) + max(0, len(blocks) - 1) * para_gap
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    y = 80
    for b_idx, block in enumerate(blocks):
        if b_idx > 0:
            y += para_gap
        for line in block:
            draw.text((80, y), line, font=font, fill="black")
            y += line_height
    return image


def _draw_scanned_page(doc: canvas.Canvas, png: Path, blocks: list[list[str]]) -> None:
    width, height = A4
    image = _render_page(blocks)
    image.save(png)
    scale = min(width / image.width, height / image.height) * 0.88
    doc.drawImage(str(png), 40, height - 40 - image.height * scale, width=image.width * scale, height=image.height * scale)
    doc.showPage()
    png.unlink()


def _scanned_pdf(path: Path, pages: list[list[list[str]]]) -> Path:
    """An image-only PDF: each page is a rendered raster with no text layer."""
    doc = canvas.Canvas(str(path), pagesize=A4)
    for page_blocks in pages:
        _draw_scanned_page(doc, path.with_name(path.stem + "-page.png"), page_blocks)
    doc.save()
    return path


def test_parse_tsv_keeps_multi_block_pages_separate():
    """Tesseract restarts par_num per block_num; _parse_tsv must key by (block_num, par_num, line_num)."""
    tsv = "\n".join(
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "5\t1\t1\t1\t1\t1\t50\t20\t40\t20\t95\tThe",
            "5\t1\t1\t1\t1\t2\t100\t20\t50\t20\t95\tHeader",
            "5\t1\t2\t1\t1\t1\t50\t100\t80\t20\t95\tFirst",
            "5\t1\t2\t1\t1\t2\t140\t100\t90\t20\t95\tparagraph.",
            "5\t1\t3\t1\t1\t1\t50\t220\t80\t20\t95\tSecond",
            "5\t1\t3\t1\t1\t2\t140\t220\t90\t20\t95\tparagraph.",
        ]
    )
    lines = _parse_tsv(tsv)
    assert [line.text for line in lines] == ["The Header", "First paragraph.", "Second paragraph."]
    blocks = _group_blocks(lines)
    assert [b.text for b in blocks] == ["The Header", "First paragraph.", "Second paragraph."]


def test_parse_tsv_raises_on_non_tsv_output():
    with pytest.raises(ValueError, match="TSV"):
        _parse_tsv("not a tsv header")


def test_parse_tsv_drops_low_confidence_photo_noise():
    tsv = "\n".join(
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "5\t1\t1\t1\t1\t1\t50\t20\t40\t20\t28\tA",
            "5\t1\t1\t1\t1\t2\t100\t20\t50\t20\t31\tMare",
            "5\t1\t1\t1\t1\t3\t160\t20\t30\t20\t35\tee",
        ]
    )
    assert _parse_tsv(tsv) == []


def test_text_pdf_with_photo_plate_skips_noise_and_succeeds_without_ocr_backend(tmp_path, monkeypatch):
    """A text PDF with an image-only photo page must not narrate noise or fail when no OCR backend exists."""
    path = tmp_path / "photo_book.pdf"
    photo = tmp_path / "plate.png"
    # Synthetic noisy texture image resembling a photo/illustration plate with no text.
    img = Image.new("RGB", (600, 800), (40, 80, 120))
    draw = ImageDraw.Draw(img)
    for y in range(0, 800, 17):
        draw.line((0, y, 600, (y * 3) % 800), fill=((y * 5) % 255, (y * 7) % 255, 180), width=4)
    img.save(photo)

    doc = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    doc.drawImage(str(photo), 40, 40, width=w - 80, height=h - 80)
    doc.showPage()
    doc.setFont("Helvetica", 12)
    doc.drawString(72, 720, "Chapter one begins cleanly after the cover plate.")
    doc.showPage()
    doc.save()

    # With real OCR enabled (if present), low-confidence photo noise must still be dropped.
    if _HAVE_OCR:
        extracted_with_ocr = extract(FileSource(path))
        assert extracted_with_ocr.chapters[0].text == "Chapter one begins cleanly after the cover plate."
        assert extracted_with_ocr.title == "photo book"

    # Without any OCR engine, the text PDF must still succeed using its embedded text.
    monkeypatch.setattr(ocr_mod, "_tesseract_available", lambda: False)
    monkeypatch.setattr(ocr_mod, "_vision_available", lambda: False)
    extracted = extract(FileSource(path))
    assert extracted.chapters[0].text == "Chapter one begins cleanly after the cover plate."
    assert extracted.title == "photo book"


@_needs_font
@_needs_ocr
def test_scanned_multi_paragraph_english_pdf_is_ocrd_in_order(tmp_path):
    pages = [
        [
            ["The City Book"],
            ["The harbour master reads the tide tables", "every morning before the boats leave."],
            ["In winter the ice comes down from the north", "and the boats stay tied to the quay."],
            ["1"],
        ]
    ]
    path = _scanned_pdf(tmp_path / "harbour_scan.pdf", pages)
    document = extract(FileSource(path))
    text = document.chapters[0].text
    assert "The harbour master reads the tide tables" in text
    assert "In winter the ice comes down from the north" in text
    assert text.index("harbour master") < text.index("In winter")


@_needs_font
@_needs_tesseract_isl
def test_scanned_icelandic_pdf_keeps_diacritics(tmp_path):
    path = _scanned_pdf(tmp_path / "scan_is.pdf", [[["Þingvellir liggja við Öxará og Þjórsá."]]])
    document = extract(FileSource(path))
    text = document.chapters[0].text
    assert "Þingvellir" in text and "við" in text and "Öxará" in text


@_needs_font
@_needs_vision
def test_vision_backend_reads_english_scan(tmp_path, monkeypatch):
    monkeypatch.setattr(ocr_mod, "_tesseract_available", lambda: False)
    path = _scanned_pdf(tmp_path / "vision_scan.pdf", [[["The harbour master reads the tide tables every morning."]]])
    document = extract(FileSource(path))
    text = document.chapters[0].text.lower()
    assert "harbour" in text and "tide tables" in text


@_needs_font
@_needs_ocr
def test_hybrid_pdf_ocrs_scanned_pages_and_keeps_text_pages(tmp_path):
    """A text cover page followed by a scanned page must extract both."""
    path = tmp_path / "hybrid.pdf"
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setFont("Helvetica", 16)
    doc.drawString(72, 720, "Cover page scanned at the library.")
    doc.showPage()
    _draw_scanned_page(doc, path.with_name("hybrid-page.png"), [["The boats sail out at dawn across the calm bay."]])
    doc.save()

    document = extract(FileSource(path))
    text = document.chapters[0].text
    assert "Cover page scanned at the library" in text
    assert "boats sail out at dawn" in text


def test_text_pdf_never_invokes_ocr(tmp_path, monkeypatch):
    path = tmp_path / "normal.pdf"
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setFont("Helvetica", 12)
    doc.drawString(72, 720, "Normal embedded text PDF should never call OCR.")
    doc.showPage()
    doc.save()

    def boom(*_args, **_kwargs):
        raise AssertionError("OCR should not run on a normal text PDF")

    monkeypatch.setattr(ocr_mod, "ocr_pages", boom)
    document = extract(FileSource(path))
    assert "Normal embedded text PDF" in document.chapters[0].text


def test_paragraph_lines_join_and_dehyphenate():
    lines = [
        _Line("The harbour grew over the cen-", 40, 40, 400, 62),
        _Line("turies into a capital city.", 40, 66, 400, 88),
    ]
    blocks = _group_blocks(lines, page_w=600)
    assert len(blocks) == 1
    assert blocks[0].text == "The harbour grew over the centuries into a capital city."


def test_two_column_vision_lines_do_not_interleave():
    lines = [
        _Line("Left column line one.", 40, 100, 260, 122),
        _Line("Right column line one.", 340, 100, 560, 122),
        _Line("Left column line two.", 40, 128, 260, 150),
        _Line("Right column line two.", 340, 128, 560, 150),
    ]
    blocks = _group_blocks(lines, page_w=600)
    assert [b.text for b in blocks] == [
        "Left column line one. Left column line two.",
        "Right column line one. Right column line two.",
    ]


def test_title_hint_requires_clear_heading_height():
    body_only = [
        _Line("First body line.", 40, 40, 400, 62),
        _Line("Second body line slightly taller.", 40, 70, 400, 94),
        _Line("Third body line.", 40, 100, 400, 122),
    ]
    assert _title_hint(body_only) is None

    with_heading = [
        _Line("Harbour Notes", 40, 40, 400, 88),
        _Line("First body line.", 40, 110, 400, 132),
        _Line("Second body line.", 40, 140, 400, 162),
    ]
    assert _title_hint(with_heading) == "Harbour Notes"


def test_scanned_pdf_without_backend_raises_clear_error(tmp_path, monkeypatch):
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
