"""OCR for scanned PDFs.

A scanned PDF stores its pages as raster images with little or no embedded text.
`extract/pdf.py` reads the text layer; for pages without embedded text that carry
a scan image (or when a whole PDF has no text layer), it calls `ocr_pages` here
to read the page images. Normal text PDFs never reach this module, so they keep
their exact output and speed.

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
import logging
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from statistics import median

log = logging.getLogger(__name__)

# 300 DPI renders a crisp page for both engines. PDF pages are 72 points per inch.
_RENDER_DPI = 300
_RENDER_SCALE = _RENDER_DPI / 72
# Cap large-format pages so a poster or blueprint cannot exhaust memory.
_MAX_RENDER_SIDE = 3500
_TESSERACT_TIMEOUT_S = 120
_LIST_LANGS_TIMEOUT_S = 15
_TITLE_HEIGHT_RATIO = 1.3

# Raised when a scanned PDF arrives on a worker with no OCR engine.
_NO_BACKEND = (
    "This PDF has no readable text layer, and no OCR engine is available on this worker."
)
_NO_BACKEND_HINT = (
    "Install tesseract to enable scanned PDF OCR "
    "(macOS: `brew install tesseract tesseract-lang`; "
    "Debian: `apt-get install tesseract-ocr tesseract-ocr-isl`)."
)


@dataclass(frozen=True)
class _Line:
    """One OCR text line, in pixel coordinates with a top-left origin (y grows down)."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    block_num: int | None = None
    par_num: int | None = None


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
    import objc
    import Vision
    from Foundation import NSData

    with objc.autorelease_pool():
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        raw = buffer.getvalue()
        data = NSData.dataWithBytes_length_(raw, len(raw))

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


@functools.lru_cache(maxsize=4)
def _tesseract_languages(exe: str) -> frozenset[str]:
    try:
        proc = subprocess.run(
            [exe, "--list-langs"],
            capture_output=True,
            text=True,
            check=False,
            timeout=_LIST_LANGS_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return frozenset()
    return frozenset(proc.stdout.split()) if proc.returncode == 0 else frozenset()


def _select_tesseract_lang(exe: str) -> str:
    langs = _tesseract_languages(exe)
    if "isl" in langs and "eng" in langs:
        return "isl+eng"
    if "isl" in langs:
        return "isl"
    return "eng"


def _tesseract_lines(image, *, exe: str | None = None, lang: str | None = None) -> list[_Line]:
    """OCR one PIL image with the `tesseract` CLI, using `isl+eng` when Icelandic data is installed."""
    exe = exe or shutil.which("tesseract")
    assert exe is not None  # _tesseract_available() gated this
    lang = lang or _select_tesseract_lang(exe)
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "page.png"
        image.save(png)
        try:
            proc = subprocess.run(
                [exe, str(png), "stdout", "--dpi", str(_RENDER_DPI), "-l", lang, "tsv"],
                capture_output=True,
                text=True,
                check=False,
                timeout=_TESSERACT_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("OCR timed out while reading a scanned page.") from exc
    if proc.returncode != 0:
        raise ValueError(f"tesseract failed: {proc.stderr.strip() or 'unknown error'}")
    return _parse_tsv(proc.stdout)


def _parse_tsv(stdout: str) -> list[_Line]:
    """Parse tesseract TSV output into lines grouped by `(block_num, par_num, line_num)`."""
    rows = [line.split("\t") for line in stdout.splitlines()]
    if not rows:
        raise ValueError("tesseract returned empty TSV output.")
    columns = {name: index for index, name in enumerate(rows[0])}
    needed = ("level", "block_num", "par_num", "line_num", "left", "top", "width", "height", "text")
    if not all(name in columns for name in needed):
        raise ValueError("tesseract did not return valid TSV output.")

    words_by_line: dict[tuple[int, int, int], list[tuple[int, int, int, int, str]]] = {}
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
            block_num = int(row[columns["block_num"]])
            par_num = int(row[columns["par_num"]])
            line_num = int(row[columns["line_num"]])
        except (ValueError, IndexError):
            continue
        words_by_line.setdefault((block_num, par_num, line_num), []).append((left, top, width, height, text))

    lines: list[_Line] = []
    for (block_num, par_num, _line_num), words in sorted(words_by_line.items()):
        ordered = sorted(words, key=lambda word: word[0])
        x0 = min(word[0] for word in ordered)
        y0 = min(word[1] for word in ordered)
        x1 = max(word[0] + word[2] for word in ordered)
        y1 = max(word[1] + word[3] for word in ordered)
        lines.append(_Line(" ".join(word[4] for word in ordered), x0, y0, x1, y1, block_num=block_num, par_num=par_num))
    return lines


def _join_lines(lines: list[_Line]) -> str:
    """Join a block's lines, un-hyphenating words split across a line break."""
    raw = "\n".join(line.text for line in lines)
    raw = re.sub(r"(?<=\w)-\n(?=[a-záéíóúýþæöð])", "", raw)
    return " ".join(raw.split())


def _order_ocr_blocks(blocks: list[_Block], page_w: float) -> list[_Block]:
    """Order OCR blocks top-to-bottom, reading left column before right column on two-column bands."""
    if len(blocks) <= 1 or page_w <= 0:
        return blocks

    sorted_blocks = sorted(blocks, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))
    lo, hi = 0.42 * page_w, 0.58 * page_w
    full = [b for b in sorted_blocks if b.x0 < lo and b.x1 > hi]
    narrow = [b for b in sorted_blocks if not (b.x0 < lo and b.x1 > hi)]
    if not narrow:
        return sorted_blocks

    def sort_band(band: list[_Block]) -> list[_Block]:
        if len(band) < 2:
            return band
        mid = page_w / 2
        left = [b for b in band if b.x1 <= mid + 0.02 * page_w]
        right = [b for b in band if b.x0 >= mid - 0.02 * page_w]
        if left and right and len(left) + len(right) == len(band):
            return sorted(left, key=lambda b: (round(b.y0, 1), round(b.x0, 1))) + sorted(
                right, key=lambda b: (round(b.y0, 1), round(b.x0, 1))
            )
        return sorted(band, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))

    ordered: list[_Block] = []
    dividers = sorted(full, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))
    remaining = narrow
    for div in dividers:
        above = [b for b in remaining if (b.y0 + b.y1) / 2 < div.y0]
        remaining = [b for b in remaining if (b.y0 + b.y1) / 2 >= div.y0]
        ordered.extend(sort_band(above))
        ordered.append(div)
    ordered.extend(sort_band(remaining))
    return ordered


def _group_blocks(lines: list[_Line], page_w: float = 0.0) -> list[_Block]:
    """Group OCR lines into paragraphs in reading order.

    When lines come from tesseract TSV (`block_num` and `par_num` set), keep tesseract's
    block and paragraph boundaries and reading order directly (preserving multi-column layouts).
    Otherwise (Apple Vision), attach each line to the closest vertically-adjacent group that
    overlaps horizontally so two-column lines stay in separate column blocks, then order columns.
    """
    if not lines:
        return []

    if all(line.block_num is not None and line.par_num is not None for line in lines):
        grouped: dict[tuple[int, int], list[_Line]] = {}
        for line in lines:
            grouped.setdefault((line.block_num or 0, line.par_num or 0), []).append(line)
        blocks: list[_Block] = []
        for group in grouped.values():
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

    ordered = sorted(lines, key=lambda line: (line.y0, line.x0))
    groups: list[list[_Line]] = []
    for line in ordered:
        best_index: int | None = None
        best_gap: float = float("inf")
        for idx in range(len(groups) - 1, -1, -1):
            previous = groups[idx][-1]
            line_height = max(1.0, min(previous.y1 - previous.y0, line.y1 - line.y0))
            gap = line.y0 - previous.y1
            overlap_x = min(previous.x1, line.x1) > max(previous.x0, line.x0)
            if -0.2 * line_height <= gap <= 0.7 * line_height and overlap_x and gap < best_gap:
                best_gap = gap
                best_index = idx
        if best_index is not None:
            groups[best_index].append(line)
        else:
            groups.append([line])

    blocks = []
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
    effective_w = page_w if page_w > 0 else max((b.x1 for b in blocks), default=0.0)
    return _order_ocr_blocks(blocks, effective_w)


def _title_hint(lines: list[_Line]) -> str | None:
    """Return the first-page heading only when it is clearly taller than normal body lines."""
    sized = [(line, max(0.0, line.y1 - line.y0)) for line in lines if line.text.strip()]
    if len(sized) < 2:
        return None
    median_height = median(height for _, height in sized)
    if median_height <= 0:
        return None
    tallest_line, tallest_height = max(sized, key=lambda pair: pair[1])
    if tallest_height < _TITLE_HEIGHT_RATIO * median_height:
        return None
    text = tallest_line.text.strip()
    return text if 2 <= len(text) <= 200 else None


def _render_scale(page) -> float:
    page_w, page_h = page.get_size()
    longest = max(page_w, page_h, 1.0)
    return min(_RENDER_SCALE, _MAX_RENDER_SIDE / longest)


def _choose_backend() -> tuple[str, str | None, str | None]:
    """Choose the OCR backend once per document. Returns `(backend, exe, lang)`."""
    if _tesseract_available():
        exe = shutil.which("tesseract")
        assert exe is not None
        lang = _select_tesseract_lang(exe)
        if "isl" not in lang:
            log.warning("OCR using tesseract lang=%s (Icelandic 'isl' traineddata not installed)", lang)
        return "tesseract", exe, lang
    if _vision_available():
        log.warning("OCR falling back to Apple Vision (tesseract not found; Icelandic diacritics are not supported)")
        return "vision", None, None
    log.error("%s %s", _NO_BACKEND, _NO_BACKEND_HINT)
    raise ValueError(_NO_BACKEND)


def ocr_pages(doc, page_indices: list[int]) -> tuple[dict[int, list[_Block]], str | None]:
    """Render and OCR the selected `page_indices` of `doc`.

    Returns `(blocks_by_page, first_page_title_hint)`.
    """
    if not page_indices:
        return {}, None

    backend, exe, lang = _choose_backend()
    log.info("OCR starting: backend=%s lang=%s pages=%d", backend, lang or "auto", len(page_indices))

    blocks_by_page: dict[int, list[_Block]] = {}
    first_page_lines: list[_Line] = []
    for index in page_indices:
        page = doc[index]
        try:
            scale = _render_scale(page)
            image = page.render(scale=scale, grayscale=True).to_pil()
            lines = _tesseract_lines(image, exe=exe, lang=lang) if backend == "tesseract" else _vision_lines(image)
            page_w = float(image.size[0])
        finally:
            page.close()
        if index == 0:
            first_page_lines = lines
        blocks_by_page[index] = _group_blocks(lines, page_w=page_w)

    return blocks_by_page, _title_hint(first_page_lines)
