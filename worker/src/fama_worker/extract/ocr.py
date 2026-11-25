"""OCR for scanned PDFs.

A scanned PDF stores its pages as raster images with little or no embedded text.
`extract/pdf.py` reads the text layer; only when a PDF has none does it call
`extract_scanned_pages` here to read the page images. A text PDF never reaches
this module, so normal PDFs keep their current output and speed.

Backends, in preference order:

1. **tesseract** — the `tesseract` CLI, on any platform. It is the only backend
   that reads Icelandic: its `isl` model reads `þ, ð, æ, ö` and the accented
   vowels correctly, which Apple Vision does not. Measured on synthetic scans
   (2026-11-25): Vision reads `Þingvellir` as `Pingvellir` and `við` as `vio`,
   while tesseract `isl` reads `Þingvellir liggja við Öxará` exactly.
2. **vision** — Apple's `VNRecognizeTextRequest`, on macOS only, built in and
   offline with nothing to install. It reads English and Vision's other
   languages, but not Icelandic.

The macOS-only `pyobjc-framework-Vision` dependency is gated to
`sys_platform == 'darwin'` in `pyproject.toml`, and is imported lazily below,
so Linux, Docker and Modal builds stay clean and never need it.
"""

from __future__ import annotations

import functools
import io
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

# 300 DPI renders a crisp page for both engines. PDF pages are 72 points per inch.
_RENDER_SCALE = 300 / 72

# Raised when a PDF has no text layer and no OCR engine is installed. It shares
# the "no text layer" phrase with the pdf.py empty-result error so callers get
# one clear, stable message.
_NO_BACKEND = (
    "This PDF has no text layer, and no OCR engine is available to read it. "
    "Install tesseract to read scanned PDFs "
    "(macOS: `brew install tesseract tesseract-lang`; "
    "Debian: `apt-get install tesseract-ocr tesseract-ocr-isl`)."
)

_PAGE_NUMBER = re.compile(
    r"^\W*(?:page\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/)\s*\d+)?\W*$", re.IGNORECASE
)
_MIN_LETTER_SHARE = 0.5
_RUNNING_MAX_WORDS = 12
_RUNNING_SHARE = 0.3


@dataclass(frozen=True)
class _Line:
    """One OCR text line, in pixel coordinates with a top-left origin (y grows down)."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class _Block:
    """One paragraph: its de-hyphenated text and the box that bounds it."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float


def _tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def _vision_available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision  # noqa: F401

        return True
    except Exception:
        return False


def _vision_lines(image) -> list[_Line]:
    """OCR one PIL image with Apple Vision (macOS only)."""
    import Vision
    from Foundation import NSData

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    data = NSData.dataWithBytes_length_(buffer.getvalue(), len(buffer.getvalue()))

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise ValueError(f"Apple Vision OCR failed: {error}")

    width, height = image.size
    lines: list[_Line] = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        text = str(candidates[0].string()).strip()
        if not text:
            continue
        box = observation.boundingBox()  # normalized, bottom-left origin
        x0 = box.origin.x * width
        x1 = (box.origin.x + box.size.width) * width
        y1 = (1.0 - box.origin.y) * height
        y0 = (1.0 - (box.origin.y + box.size.height)) * height
        lines.append(_Line(text, x0, y0, x1, y1))
    return lines


@functools.lru_cache(maxsize=1)
def _tesseract_languages(exe: str) -> frozenset[str]:
    proc = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, check=False)
    return frozenset(proc.stdout.split()) if proc.returncode == 0 else frozenset()


def _tesseract_lines(image) -> list[_Line]:
    """OCR one PIL image with the `tesseract` CLI, in Icelandic (`isl`) when it is installed."""
    exe = shutil.which("tesseract")
    assert exe is not None  # _tesseract_available() gated this
    lang = "isl" if "isl" in _tesseract_languages(exe) else "eng"
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "page.png"
        image.save(png)
        proc = subprocess.run(
            [exe, str(png), "stdout", "-l", lang, "tsv"],
            capture_output=True,
            text=True,
            check=False,
        )
    if proc.returncode != 0:
        raise ValueError(f"tesseract failed: {proc.stderr.strip() or 'unknown error'}")
    return _parse_tsv(proc.stdout)


def _parse_tsv(stdout: str) -> list[_Line]:
    """Parse tesseract TSV output into lines, each the union of its words."""
    rows = [line.split("\t") for line in stdout.splitlines()]
    if not rows:
        return []
    columns = {name: index for index, name in enumerate(rows[0])}
    needed = ("level", "par_num", "line_num", "left", "top", "width", "height", "text")
    if not all(name in columns for name in needed):
        return []

    words_by_line: dict[tuple[int, int], list[tuple[int, int, int, int, str]]] = {}
    for row in rows[1:]:
        if len(row) <= columns["level"] or row[columns["level"]] != "5":
            continue
        text = row[columns["text"]].strip()
        if not text:
            continue
        try:
            left = int(row[columns["left"]])
            top = int(row[columns["top"]])
            width = int(row[columns["width"]])
            height = int(row[columns["height"]])
            line_num = int(row[columns["line_num"]])
            par_num = int(row[columns["par_num"]])
        except (ValueError, IndexError):
            continue
        words_by_line.setdefault((par_num, line_num), []).append((left, top, width, height, text))

    lines: list[_Line] = []
    for words in words_by_line.values():
        ordered = sorted(words, key=lambda word: word[0])
        x0 = min(word[0] for word in ordered)
        y0 = min(word[1] for word in ordered)
        x1 = max(word[0] + word[2] for word in ordered)
        y1 = max(word[1] + word[3] for word in ordered)
        lines.append(_Line(" ".join(word[4] for word in ordered), x0, y0, x1, y1))
    lines.sort(key=lambda line: (line.y0, line.x0))
    return lines


def _recognize(image) -> list[_Line]:
    if _tesseract_available():
        return _tesseract_lines(image)
    if _vision_available():
        return _vision_lines(image)
    raise ValueError(_NO_BACKEND)


def _join_lines(lines: list[_Line]) -> str:
    """Join a block's lines, un-hyphenating words split across a line break."""
    raw = "\n".join(line.text for line in lines)
    raw = re.sub(r"(?<=\w)-\n(?=[a-záéíóúýþæöð])", "", raw)
    return " ".join(raw.split())


def _group_blocks(lines: list[_Line]) -> list[_Block]:
    """Group consecutive lines into paragraphs in reading order and join them."""
    ordered = sorted(lines, key=lambda line: (line.y0, line.x0))
    groups: list[list[_Line]] = []
    for line in ordered:
        if not groups:
            groups.append([line])
            continue
        previous = groups[-1][-1]
        line_height = max(1.0, min(previous.y1 - previous.y0, line.y1 - line.y0))
        gap = line.y0 - previous.y1
        overlap_x = min(previous.x1, line.x1) > max(previous.x0, line.x0)
        if gap <= 0.7 * line_height and overlap_x:
            groups[-1].append(line)
        else:
            groups.append([line])

    blocks: list[_Block] = []
    for group in groups:
        text = _join_lines(group)
        if not text:
            continue
        blocks.append(
            _Block(
                text=text,
                x0=min(line.x0 for line in group),
                y0=min(line.y0 for line in group),
                x1=max(line.x1 for line in group),
                y1=max(line.y1 for line in group),
            )
        )
    return blocks


def _prose(text: str) -> bool:
    chars = [c for c in text if not c.isspace()]
    return bool(chars) and sum(c.isalpha() for c in chars) / len(chars) >= _MIN_LETTER_SHARE


def _edge_key(text: str) -> str:
    """One key for a running line on all pages: its number changes, so digits collapse."""
    return " ".join(sorted(re.sub(r"\d+", "#", text.lower()).split()))


def _drop_running(blocks_per_page: list[list[_Block]]) -> list[list[_Block]]:
    """Drop running headers, footers and page numbers that repeat across pages."""
    page_count = len(blocks_per_page)
    counts: Counter[str] = Counter()
    page_keys: list[set[str]] = []
    for blocks in blocks_per_page:
        keys: set[str] = set()
        if blocks:
            for block in (blocks[0], blocks[-1]):
                if len(block.text.split()) <= _RUNNING_MAX_WORDS:
                    keys.add(_edge_key(block.text))
        page_keys.append(keys)
        counts.update(keys)

    threshold = max(3, _RUNNING_SHARE * page_count)
    running = {key for key, count in counts.items() if count >= threshold}

    kept: list[list[_Block]] = []
    for index, blocks in enumerate(blocks_per_page):
        page: list[_Block] = []
        for position, block in enumerate(blocks):
            if _PAGE_NUMBER.match(block.text):
                continue
            if not _prose(block.text):
                continue
            is_edge = position == 0 or position == len(blocks) - 1
            key = _edge_key(block.text) if is_edge and len(block.text.split()) <= _RUNNING_MAX_WORDS else ""
            if key and key in running:
                continue
            page.append(block)
        kept.append(page)
    return kept


def _title_hint(lines: list[_Line]) -> str | None:
    """The largest line on the first page is the title of most scanned pages."""
    if not lines:
        return None
    tallest = max(lines, key=lambda line: line.y1 - line.y0)
    text = tallest.text.strip()
    return text if 2 <= len(text) <= 200 else None


def extract_scanned_pages(doc) -> tuple[list[list[str]], str | None]:
    """Read the page images of a text-less PDF: render each page and OCR it.

    Returns `(pages, title_hint)`. `pages` is one list of cleaned paragraph texts
    per page, with running headers, footers, page numbers and non-prose dropped.
    `title_hint` is the largest line on the first page, or `None`.
    """
    if not (_tesseract_available() or _vision_available()):
        raise ValueError(_NO_BACKEND)

    blocks_per_page: list[list[_Block]] = []
    first_page_lines: list[_Line] = []
    for index in range(len(doc)):
        page = doc[index]
        try:
            image = page.render(scale=_RENDER_SCALE).to_pil()
            lines = _recognize(image)
        finally:
            page.close()
        if index == 0:
            first_page_lines = lines
        blocks_per_page.append(_group_blocks(lines))

    blocks_per_page = _drop_running(blocks_per_page)
    pages = [[block.text for block in blocks] for blocks in blocks_per_page]
    return pages, _title_hint(first_page_lines)
